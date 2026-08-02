import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { app } from "../src/app.js";
import { signUp } from "./helpers.js";

async function createHousehold(cookie: string, name = "Status Test House") {
  const res = await app.request("/api/households", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return (await res.json()).household as { id: string };
}

async function addBook(cookie: string, householdId: string, title: string) {
  const res = await app.request("/api/books", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ householdId, edition: { title, authors: "A" }, ownership: "owned" }),
  });
  return (await res.json()).book as { id: string };
}

async function inviteAndAccept(ownerCookie: string, householdId: string) {
  const invRes = await app.request(`/api/households/${householdId}/invites`, {
    method: "POST",
    headers: { cookie: ownerCookie, "content-type": "application/json" },
    body: JSON.stringify({ email: `${randomUUID()}@test.local`, role: "member" }),
  });
  const invite = (await invRes.json()) as { token: string };
  const other = await signUp(app);
  await app.request(`/api/invites/${invite.token}/accept`, {
    method: "POST",
    headers: { cookie: other.cookie },
  });
  return other;
}

describe("reading status", () => {
  it("PUT upserts the caller's status and GET returns it", async () => {
    const { cookie } = await signUp(app);
    const house = await createHousehold(cookie);
    const book = await addBook(cookie, house.id, "Sapiens");

    const put = await app.request(`/api/books/${book.id}/status`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ status: "reading" }),
    });
    expect(put.status).toBe(200);
    const putBody = await put.json();
    expect(putBody.status.status).toBe("reading");

    const get = await app.request(`/api/books/${book.id}/status`, { headers: { cookie } });
    expect(get.status).toBe(200);
    const getBody = await get.json();
    expect(getBody.statuses).toHaveLength(1);
    expect(getBody.statuses[0].status).toBe("reading");
  });

  it("PUT called twice updates rather than duplicates", async () => {
    const { cookie } = await signUp(app);
    const house = await createHousehold(cookie);
    const book = await addBook(cookie, house.id, "Sapiens");

    await app.request(`/api/books/${book.id}/status`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ status: "reading" }),
    });
    const second = await app.request(`/api/books/${book.id}/status`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ status: "finished", rating: 5 }),
    });
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.status.status).toBe("finished");
    expect(secondBody.status.rating).toBe(5);

    const get = await app.request(`/api/books/${book.id}/status`, { headers: { cookie } });
    const getBody = await get.json();
    expect(getBody.statuses).toHaveLength(1);
    expect(getBody.statuses[0].status).toBe("finished");
  });

  it("user A's status update doesn't affect user B's status on the same book", async () => {
    const a = await signUp(app);
    const houseA = await createHousehold(a.cookie);
    const book = await addBook(a.cookie, houseA.id, "Sapiens");
    const b = await inviteAndAccept(a.cookie, houseA.id);

    await app.request(`/api/books/${book.id}/status`, {
      method: "PUT",
      headers: { cookie: a.cookie, "content-type": "application/json" },
      body: JSON.stringify({ status: "reading" }),
    });
    await app.request(`/api/books/${book.id}/status`, {
      method: "PUT",
      headers: { cookie: b.cookie, "content-type": "application/json" },
      body: JSON.stringify({ status: "want_to_read" }),
    });

    const get = await app.request(`/api/books/${book.id}/status`, { headers: { cookie: a.cookie } });
    const getBody = await get.json();
    expect(getBody.statuses).toHaveLength(2);
    const byStatus = getBody.statuses.map((s: any) => s.status).sort();
    expect(byStatus).toEqual(["reading", "want_to_read"]);
  });

  it("rejects an unknown status value with 400", async () => {
    const { cookie } = await signUp(app);
    const house = await createHousehold(cookie);
    const book = await addBook(cookie, house.id, "Sapiens");

    const res = await app.request(`/api/books/${book.id}/status`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ status: "on_fire" }),
    });
    expect(res.status).toBe(400);
  });

  it("PUT with missing status returns 400", async () => {
    const { cookie } = await signUp(app);
    const house = await createHousehold(cookie);
    const book = await addBook(cookie, house.id, "Sapiens");

    const res = await app.request(`/api/books/${book.id}/status`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("PUT returns 404 for a nonexistent book", async () => {
    const { cookie } = await signUp(app);
    const res = await app.request(`/api/books/${randomUUID()}/status`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ status: "reading" }),
    });
    expect(res.status).toBe(404);
  });

  it("PUT ignores a client-supplied householdId and derives it from the book", async () => {
    const a = await signUp(app);
    const houseA = await createHousehold(a.cookie, "A");
    const book = await addBook(a.cookie, houseA.id, "Sapiens");

    const b = await signUp(app);
    const houseB = await createHousehold(b.cookie, "B");

    // b is not in houseA; even if b tries to spoof householdId, RLS on `book`
    // means b can't see the book at all -> 404, no cross-tenant write possible.
    const res = await app.request(`/api/books/${book.id}/status`, {
      method: "PUT",
      headers: { cookie: b.cookie, "content-type": "application/json" },
      body: JSON.stringify({ status: "reading", householdId: houseB.id }),
    });
    expect(res.status).toBe(404);
  });

  it("GET returns 404 for a nonexistent book", async () => {
    const { cookie } = await signUp(app);
    const res = await app.request(`/api/books/${randomUUID()}/status`, { headers: { cookie } });
    expect(res.status).toBe(404);
  });

  it("requires auth", async () => {
    const res = await app.request(`/api/books/${randomUUID()}/status`);
    expect(res.status).toBe(401);
  });
});
