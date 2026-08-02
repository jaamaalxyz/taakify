import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { app } from "../src/app.js";
import { signUp } from "./helpers.js";

async function createHousehold(cookie: string, name = "Books Test House") {
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
  return { status: res.status, body: await res.json() };
}

describe("books", () => {
  it("creates a book (with an inline edition) and lists it", async () => {
    const { cookie } = await signUp(app);
    const house = await createHousehold(cookie);
    const created = await addBook(cookie, house.id, "Sapiens");
    expect(created.status).toBe(201);
    expect(created.body.book.id).toBeTruthy();

    const list = await (
      await app.request(`/api/books?householdId=${house.id}`, { headers: { cookie } })
    ).json();
    expect(list.books).toHaveLength(1);
    expect(list.books[0].edition.title).toBe("Sapiens");
  });

  it("searches by title and filters by ownership", async () => {
    const { cookie } = await signUp(app);
    const house = await createHousehold(cookie);
    await addBook(cookie, house.id, "Sapiens");
    await addBook(cookie, house.id, "Dune");

    const q = await (await app.request(`/api/books?householdId=${house.id}&q=dun`, { headers: { cookie } })).json();
    expect(q.books).toHaveLength(1);
    expect(q.books[0].edition.title).toBe("Dune");

    const none = await (await app.request(`/api/books?householdId=${house.id}&ownership=wishlist`, { headers: { cookie } })).json();
    expect(none.books).toHaveLength(0);
  });

  it("RLS: a second household never sees the first's books", async () => {
    const a = await signUp(app);
    const houseA = await createHousehold(a.cookie, "A");
    await addBook(a.cookie, houseA.id, "Hidden");

    const b = await signUp(app);
    const houseB = await createHousehold(b.cookie, "B");
    const list = await (await app.request(`/api/books?householdId=${houseB.id}`, { headers: { cookie: b.cookie } })).json();
    expect(list.books).toHaveLength(0);
  });

  it("requires auth", async () => {
    const res = await app.request("/api/books");
    expect(res.status).toBe(401);
  });

  it("creates a book by reusing an existing editionId", async () => {
    const { cookie } = await signUp(app);
    const house = await createHousehold(cookie);

    // Create first book with inline edition
    const first = await addBook(cookie, house.id, "Sapiens");
    expect(first.status).toBe(201);
    const editionId = first.body.book.edition.id;

    // Create second book reusing the same edition
    const res = await app.request("/api/books", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ householdId: house.id, editionId, ownership: "borrowed_in" }),
    });
    expect(res.status).toBe(201);
    const { book: second } = await res.json();
    expect(second.id).toBeTruthy();
    expect(second.edition.id).toBe(editionId);
    expect(second.edition.title).toBe("Sapiens");
    expect(second.ownership).toBe("borrowed_in");
  });

  it("GET /:id returns a single book with nested edition", async () => {
    const { cookie } = await signUp(app);
    const house = await createHousehold(cookie);
    const created = await addBook(cookie, house.id, "Sapiens");
    const bookId = created.body.book.id;

    const res = await app.request(`/api/books/${bookId}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const { book } = await res.json();
    expect(book.id).toBe(bookId);
    expect(book.edition.title).toBe("Sapiens");
    expect(book.edition.id).toBeTruthy();
  });

  it("GET /:id returns 404 for nonexistent book", async () => {
    const { cookie } = await signUp(app);
    const res = await app.request(`/api/books/${randomUUID()}`, { headers: { cookie } });
    expect(res.status).toBe(404);
  });

  it("PATCH /:id updates a book field", async () => {
    const { cookie } = await signUp(app);
    const house = await createHousehold(cookie);
    const created = await addBook(cookie, house.id, "Sapiens");
    const bookId = created.body.book.id;
    const originalUpdatedAt = created.body.book.updated_at;

    const updateRes = await app.request(`/api/books/${bookId}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ notes: "Great book!" }),
    });
    expect(updateRes.status).toBe(200);
    const { book: updated } = await updateRes.json();
    expect(updated.notes).toBe("Great book!");
    expect(updated.edition.title).toBe("Sapiens");
    expect(updated.updated_at).toBeTruthy();
    expect(new Date(updated.updated_at) > new Date(originalUpdatedAt)).toBe(true);
  });

  it("PATCH /:id with empty body returns 400", async () => {
    const { cookie } = await signUp(app);
    const house = await createHousehold(cookie);
    const created = await addBook(cookie, house.id, "Sapiens");
    const bookId = created.body.book.id;

    const res = await app.request(`/api/books/${bookId}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("nothing to update");
  });

  it("PATCH /:id returns 404 for nonexistent book", async () => {
    const { cookie } = await signUp(app);
    const res = await app.request(`/api/books/${randomUUID()}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ notes: "test" }),
    });
    expect(res.status).toBe(404);
  });

  it("DELETE /:id soft-deletes a book", async () => {
    const { cookie } = await signUp(app);
    const house = await createHousehold(cookie);
    const created = await addBook(cookie, house.id, "Sapiens");
    const bookId = created.body.book.id;

    const deleteRes = await app.request(`/api/books/${bookId}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(deleteRes.status).toBe(200);

    // Verify it no longer appears in list
    const listRes = await app.request(`/api/books?householdId=${house.id}`, { headers: { cookie } });
    const list = await listRes.json();
    expect(list.books).toHaveLength(0);

    // Verify GET /:id returns 404
    const getRes = await app.request(`/api/books/${bookId}`, { headers: { cookie } });
    expect(getRes.status).toBe(404);
  });

  it("DELETE /:id returns 404 for nonexistent book", async () => {
    const { cookie } = await signUp(app);
    const res = await app.request(`/api/books/${randomUUID()}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(res.status).toBe(404);
  });
});
