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

async function addShelf(cookie: string, householdId: string, bookcaseName: string) {
  const bcRes = await app.request("/api/bookcases", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ householdId, name: bookcaseName }),
  });
  const bookcase = (await bcRes.json()).bookcase as { id: string };
  const shelfRes = await app.request(`/api/bookcases/${bookcase.id}/shelves`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ label: "Top" }),
  });
  return (await shelfRes.json()).shelf as { id: string };
}

// Invites the given cookie's user into householdId, using ownerCookie's
// admin/owner privileges, and returns the now-dual-household session cookie.
async function inviteAndJoin(ownerCookie: string, householdId: string, joinerCookie: string) {
  const invRes = await app.request(`/api/households/${householdId}/invites`, {
    method: "POST",
    headers: { cookie: ownerCookie, "content-type": "application/json" },
    body: JSON.stringify({ email: `${randomUUID()}@test.local`, role: "member" }),
  });
  const invite = (await invRes.json()) as { token: string };
  await app.request(`/api/invites/${invite.token}/accept`, {
    method: "POST",
    headers: { cookie: joinerCookie },
  });
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

  it("DELETE /:id closes out the book's active loans so they drop off the active list", async () => {
    const { cookie } = await signUp(app);
    const house = await createHousehold(cookie);
    const created = await addBook(cookie, house.id, "Sapiens");
    const bookId = created.body.book.id;

    const loanRes = await app.request("/api/loans", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ bookId, contactName: "Alice", direction: "lent_out" }),
    });
    expect(loanRes.status).toBe(201);

    const deleteRes = await app.request(`/api/books/${bookId}`, { method: "DELETE", headers: { cookie } });
    expect(deleteRes.status).toBe(200);

    const activeLoans = await (
      await app.request(`/api/loans?householdId=${house.id}&active=true`, { headers: { cookie } })
    ).json();
    expect(activeLoans.loans).toHaveLength(0);
  });

  it("a user in two households cannot create a book pointing shelf_id at another household's shelf", async () => {
    const a = await signUp(app);
    const houseA = await createHousehold(a.cookie, "A");

    const b = await signUp(app);
    const houseB = await createHousehold(b.cookie, "B");
    const shelfB = await addShelf(b.cookie, houseB.id, "B Bookcase");

    // a joins household B too, so a's RLS membership check alone would allow
    // inserting a book row scoped to household A with shelf_id pointing at
    // household B's shelf — the route must additionally verify the shelf's
    // household matches the book's household.
    await inviteAndJoin(b.cookie, houseB.id, a.cookie);

    const res = await app.request("/api/books", {
      method: "POST",
      headers: { cookie: a.cookie, "content-type": "application/json" },
      body: JSON.stringify({
        householdId: houseA.id,
        edition: { title: "Cross-household", authors: "A" },
        ownership: "owned",
        shelf_id: shelfB.id,
      }),
    });
    expect(res.status).toBe(404);
  });

  it("a user in two households cannot PATCH a book's shelf_id to another household's shelf", async () => {
    const a = await signUp(app);
    const houseA = await createHousehold(a.cookie, "A");
    const book = await addBook(a.cookie, houseA.id, "Sapiens");

    const b = await signUp(app);
    const houseB = await createHousehold(b.cookie, "B");
    const shelfB = await addShelf(b.cookie, houseB.id, "B Bookcase");

    await inviteAndJoin(b.cookie, houseB.id, a.cookie);

    const res = await app.request(`/api/books/${book.body.book.id}`, {
      method: "PATCH",
      headers: { cookie: a.cookie, "content-type": "application/json" },
      body: JSON.stringify({ shelf_id: shelfB.id }),
    });
    expect(res.status).toBe(404);

    // Confirm the book's shelf_id wasn't changed.
    const unchanged = await (
      await app.request(`/api/books/${book.body.book.id}`, { headers: { cookie: a.cookie } })
    ).json();
    expect(unchanged.book.shelf_id).toBeNull();
  });

  it("GET /api/books/:bookId/tags lists the tags currently attached to a book", async () => {
    const { cookie } = await signUp(app);
    const house = await createHousehold(cookie);
    const created = await addBook(cookie, house.id, "Sapiens");
    const bookId = created.body.book.id;

    const tagRes = await app.request("/api/tags", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ householdId: house.id, name: "history" }),
    });
    const tag = (await tagRes.json()).tag as { id: string; name: string };

    await app.request(`/api/books/${bookId}/tags`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ tagId: tag.id }),
    });

    const res = await app.request(`/api/books/${bookId}/tags`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tags).toHaveLength(1);
    expect(body.tags[0]).toMatchObject({ id: tag.id, name: "history" });

    await app.request(`/api/books/${bookId}/tags/${tag.id}`, { method: "DELETE", headers: { cookie } });
    const afterRemove = await (
      await app.request(`/api/books/${bookId}/tags`, { headers: { cookie } })
    ).json();
    expect(afterRemove.tags).toHaveLength(0);
  });

  it("GET /api/books/:bookId/tags returns 404 for a nonexistent book", async () => {
    const { cookie } = await signUp(app);
    const res = await app.request(`/api/books/${randomUUID()}/tags`, { headers: { cookie } });
    expect(res.status).toBe(404);
  });

  it("GET /api/books/:bookId/tags: RLS isolation across households", async () => {
    const a = await signUp(app);
    const houseA = await createHousehold(a.cookie, "A");
    const book = await addBook(a.cookie, houseA.id, "Sapiens");
    const tagRes = await app.request("/api/tags", {
      method: "POST",
      headers: { cookie: a.cookie, "content-type": "application/json" },
      body: JSON.stringify({ householdId: houseA.id, name: "hidden" }),
    });
    const tag = (await tagRes.json()).tag as { id: string };
    await app.request(`/api/books/${book.body.book.id}/tags`, {
      method: "POST",
      headers: { cookie: a.cookie, "content-type": "application/json" },
      body: JSON.stringify({ tagId: tag.id }),
    });

    const b = await signUp(app);
    const res = await app.request(`/api/books/${book.body.book.id}/tags`, { headers: { cookie: b.cookie } });
    // b isn't a member of houseA, so RLS hides the book row itself -> 404.
    expect(res.status).toBe(404);
  });

  it("GET / paginates via offset/limit; a second page picks up where the first left off", async () => {
    const { cookie } = await signUp(app);
    const house = await createHousehold(cookie);
    await addBook(cookie, house.id, "Alpha");
    await addBook(cookie, house.id, "Bravo");
    await addBook(cookie, house.id, "Charlie");

    const page1 = await (
      await app.request(`/api/books?householdId=${house.id}&limit=2`, { headers: { cookie } })
    ).json();
    expect(page1.books.map((b: any) => b.edition.title)).toEqual(["Alpha", "Bravo"]);

    const page2 = await (
      await app.request(`/api/books?householdId=${house.id}&limit=2&offset=2`, { headers: { cookie } })
    ).json();
    expect(page2.books.map((b: any) => b.edition.title)).toEqual(["Charlie"]);
  });

  it("GET / search with a literal % or _ doesn't act as an unintended wildcard", async () => {
    const { cookie } = await signUp(app);
    const house = await createHousehold(cookie);
    await addBook(cookie, house.id, "50% Off");
    await addBook(cookie, house.id, "Something Else");

    const res = await (
      await app.request(`/api/books?householdId=${house.id}&q=${encodeURIComponent("50%")}`, { headers: { cookie } })
    ).json();
    expect(res.books).toHaveLength(1);
    expect(res.books[0].edition.title).toBe("50% Off");
  });

  it("GET / with no q param doesn't filter (unconditional LIKE '%%' bug)", async () => {
    const { cookie } = await signUp(app);
    const house = await createHousehold(cookie);
    await addBook(cookie, house.id, "Alpha");
    await addBook(cookie, house.id, "Bravo");

    const res = await (
      await app.request(`/api/books?householdId=${house.id}`, { headers: { cookie } })
    ).json();
    expect(res.books).toHaveLength(2);
  });
});
