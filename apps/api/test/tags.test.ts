import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { app } from "../src/app.js";
import { signUp } from "./helpers.js";

async function createHousehold(cookie: string, name = "Tags Test House") {
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

async function addTag(cookie: string, householdId: string, name: string) {
  const res = await app.request("/api/tags", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ householdId, name }),
  });
  return { status: res.status, body: await res.json() };
}

describe("tags", () => {
  it("creates a tag and lists it", async () => {
    const { cookie } = await signUp(app);
    const house = await createHousehold(cookie);
    const created = await addTag(cookie, house.id, "sci-fi");
    expect(created.status).toBe(201);
    expect(created.body.tag.name).toBe("sci-fi");

    const list = await (
      await app.request(`/api/tags?householdId=${house.id}`, { headers: { cookie } })
    ).json();
    expect(list.tags).toHaveLength(1);
    expect(list.tags[0].name).toBe("sci-fi");
  });

  it("POST is idempotent: creating the same (householdId, name) twice returns the existing tag", async () => {
    const { cookie } = await signUp(app);
    const house = await createHousehold(cookie);
    const first = await addTag(cookie, house.id, "sci-fi");
    const second = await addTag(cookie, house.id, "sci-fi");

    expect(second.status).toBe(200);
    expect(second.body.tag.id).toBe(first.body.tag.id);

    const list = await (
      await app.request(`/api/tags?householdId=${house.id}`, { headers: { cookie } })
    ).json();
    expect(list.tags).toHaveLength(1);
  });

  it("POST requires householdId and name", async () => {
    const { cookie } = await signUp(app);
    const res = await app.request("/api/tags", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("GET requires householdId", async () => {
    const { cookie } = await signUp(app);
    const res = await app.request("/api/tags", { headers: { cookie } });
    expect(res.status).toBe(400);
  });

  it("tags a book and lists the tag on it via book_tag; DELETE untags", async () => {
    const { cookie } = await signUp(app);
    const house = await createHousehold(cookie);
    const book = await addBook(cookie, house.id, "Sapiens");
    const tag = await addTag(cookie, house.id, "history");

    const tagRes = await app.request(`/api/books/${book.id}/tags`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ tagId: tag.body.tag.id }),
    });
    expect(tagRes.status).toBe(201);

    // Filtering books by tag should find it (books.ts already supports ?tag=)
    const filtered = await (
      await app.request(`/api/books?householdId=${house.id}&tag=history`, { headers: { cookie } })
    ).json();
    expect(filtered.books).toHaveLength(1);

    const untag = await app.request(`/api/books/${book.id}/tags/${tag.body.tag.id}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(untag.status).toBe(200);

    const afterUntag = await (
      await app.request(`/api/books?householdId=${house.id}&tag=history`, { headers: { cookie } })
    ).json();
    expect(afterUntag.books).toHaveLength(0);
  });

  it("POST /books/:bookId/tags requires tagId", async () => {
    const { cookie } = await signUp(app);
    const house = await createHousehold(cookie);
    const book = await addBook(cookie, house.id, "Sapiens");
    const res = await app.request(`/api/books/${book.id}/tags`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("POST /books/:bookId/tags returns 404 for a nonexistent book", async () => {
    const { cookie } = await signUp(app);
    const house = await createHousehold(cookie);
    const tag = await addTag(cookie, house.id, "history");
    const res = await app.request(`/api/books/${randomUUID()}/tags`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ tagId: tag.body.tag.id }),
    });
    expect(res.status).toBe(404);
  });

  it("DELETE /books/:bookId/tags/:tagId returns 404 when no such book_tag row exists", async () => {
    const { cookie } = await signUp(app);
    const house = await createHousehold(cookie);
    const book = await addBook(cookie, house.id, "Sapiens");
    const tag = await addTag(cookie, house.id, "history");
    const res = await app.request(`/api/books/${book.id}/tags/${tag.body.tag.id}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(res.status).toBe(404);
  });

  it("RLS: household B never sees household A's tags", async () => {
    const a = await signUp(app);
    const houseA = await createHousehold(a.cookie, "A");
    await addTag(a.cookie, houseA.id, "hidden");

    const b = await signUp(app);
    const houseB = await createHousehold(b.cookie, "B");
    const list = await (
      await app.request(`/api/tags?householdId=${houseB.id}`, { headers: { cookie: b.cookie } })
    ).json();
    expect(list.tags).toHaveLength(0);
  });

  it("requires auth", async () => {
    const res = await app.request("/api/tags?householdId=x");
    expect(res.status).toBe(401);
  });
});
