import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { app } from "../src/app.js";
import { signUp } from "./helpers.js";

async function createHousehold(cookie: string, name = "Contacts Test House") {
  const res = await app.request("/api/households", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return (await res.json()).household as { id: string };
}

async function addContact(cookie: string, householdId: string, name = "Alice") {
  const res = await app.request("/api/contacts", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ householdId, name, phone: "555-1234", email: "alice@example.com" }),
  });
  return { status: res.status, body: await res.json() };
}

describe("contacts", () => {
  it("creates a contact and lists it", async () => {
    const { cookie } = await signUp(app);
    const house = await createHousehold(cookie);
    const created = await addContact(cookie, house.id, "Alice");
    expect(created.status).toBe(201);
    expect(created.body.contact.name).toBe("Alice");
    expect(created.body.contact.phone).toBe("555-1234");

    const list = await (
      await app.request(`/api/contacts?householdId=${house.id}`, { headers: { cookie } })
    ).json();
    expect(list.contacts).toHaveLength(1);
    expect(list.contacts[0].name).toBe("Alice");
  });

  it("POST requires householdId and name", async () => {
    const { cookie } = await signUp(app);
    const res = await app.request("/api/contacts", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("GET requires householdId", async () => {
    const { cookie } = await signUp(app);
    const res = await app.request("/api/contacts", { headers: { cookie } });
    expect(res.status).toBe(400);
  });

  it("PATCH updates fields", async () => {
    const { cookie } = await signUp(app);
    const house = await createHousehold(cookie);
    const created = await addContact(cookie, house.id, "Alice");

    const patched = await app.request(`/api/contacts/${created.body.contact.id}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ phone: "555-9999" }),
    });
    expect(patched.status).toBe(200);
    const patchedBody = await patched.json();
    expect(patchedBody.contact.phone).toBe("555-9999");
    expect(patchedBody.contact.name).toBe("Alice");
  });

  it("PATCH with empty body returns 400", async () => {
    const { cookie } = await signUp(app);
    const house = await createHousehold(cookie);
    const created = await addContact(cookie, house.id, "Alice");

    const res = await app.request(`/api/contacts/${created.body.contact.id}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("PATCH returns 404 for a nonexistent contact", async () => {
    const { cookie } = await signUp(app);
    const res = await app.request(`/api/contacts/${randomUUID()}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Bob" }),
    });
    expect(res.status).toBe(404);
  });

  it("DELETE soft-deletes a contact", async () => {
    const { cookie } = await signUp(app);
    const house = await createHousehold(cookie);
    const created = await addContact(cookie, house.id, "Alice");

    const del = await app.request(`/api/contacts/${created.body.contact.id}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(del.status).toBe(200);

    const list = await (
      await app.request(`/api/contacts?householdId=${house.id}`, { headers: { cookie } })
    ).json();
    expect(list.contacts).toHaveLength(0);
  });

  it("DELETE returns 404 for a nonexistent contact", async () => {
    const { cookie } = await signUp(app);
    const res = await app.request(`/api/contacts/${randomUUID()}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(res.status).toBe(404);
  });

  it("RLS: household B never sees household A's contacts", async () => {
    const a = await signUp(app);
    const houseA = await createHousehold(a.cookie, "A");
    await addContact(a.cookie, houseA.id, "Hidden");

    const b = await signUp(app);
    const houseB = await createHousehold(b.cookie, "B");
    const list = await (
      await app.request(`/api/contacts?householdId=${houseB.id}`, { headers: { cookie: b.cookie } })
    ).json();
    expect(list.contacts).toHaveLength(0);
  });

  it("requires auth", async () => {
    const res = await app.request("/api/contacts?householdId=x");
    expect(res.status).toBe(401);
  });

  // --- Client-supplied id + idempotent upsert (fix round) -----------------

  it("POST with a client-supplied id creates the contact under that exact id", async () => {
    const { cookie } = await signUp(app);
    const house = await createHousehold(cookie);
    const id = randomUUID();

    const res = await app.request("/api/contacts", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ id, householdId: house.id, name: "Client Id Contact" }),
    });
    expect(res.status).toBe(201);
    expect((await res.json()).contact.id).toBe(id);
  });

  it("POST retried with the same client-supplied id returns the same row, not a duplicate", async () => {
    const { cookie } = await signUp(app);
    const house = await createHousehold(cookie);
    const id = randomUUID();
    const body = JSON.stringify({ id, householdId: house.id, name: "Retried Contact" });

    const first = await app.request("/api/contacts", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body,
    });
    expect(first.status).toBe(201);

    const retry = await app.request("/api/contacts", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body,
    });
    expect(retry.status).toBe(201);
    expect((await retry.json()).contact.id).toBe(id);

    const list = await (
      await app.request(`/api/contacts?householdId=${house.id}`, { headers: { cookie } })
    ).json();
    expect(list.contacts).toHaveLength(1);
  });

  it("POST without a client-supplied id still server-generates one (backward compatible)", async () => {
    const { cookie } = await signUp(app);
    const house = await createHousehold(cookie);
    const created = await addContact(cookie, house.id, "No Client Id");
    expect(created.status).toBe(201);
    expect(created.body.contact.id).toBeTruthy();
  });
});
