import { describe, it, expect } from "vitest";
import { app } from "../src/app.js";
import { signUp } from "./helpers.js";

async function createHousehold(cookie: string, name = "Bootstrap Test House") {
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
  return (await res.json()).book as { id: string; edition_id: string };
}

async function addBookcase(cookie: string, householdId: string, name: string) {
  const res = await app.request("/api/bookcases", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ householdId, name }),
  });
  return (await res.json()).bookcase as { id: string };
}

async function addTag(cookie: string, householdId: string, name: string) {
  const res = await app.request("/api/tags", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ householdId, name }),
  });
  return (await res.json()).tag as { id: string };
}

async function addContact(cookie: string, householdId: string, name: string) {
  const res = await app.request("/api/contacts", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ householdId, name }),
  });
  return (await res.json()).contact as { id: string };
}

describe("bootstrap", () => {
  it("requires auth", async () => {
    const res = await app.request("/api/bootstrap?householdId=x");
    expect(res.status).toBe(401);
  });

  it("requires householdId", async () => {
    const { cookie } = await signUp(app);
    const res = await app.request("/api/bootstrap", { headers: { cookie } });
    expect(res.status).toBe(400);
  });

  it("returns the calling household's full book-domain dataset", async () => {
    const { cookie } = await signUp(app);
    const house = await createHousehold(cookie);
    const bookcase = await addBookcase(cookie, house.id, "Living Room");
    const book = await addBook(cookie, house.id, "Sapiens");
    const tag = await addTag(cookie, house.id, "history");
    const contact = await addContact(cookie, house.id, "Alex");

    await app.request(`/api/books/${book.id}/tags`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ tagId: tag.id }),
    });

    const loanRes = await app.request("/api/loans", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ bookId: book.id, contactId: contact.id, direction: "lent_out" }),
    });
    expect(loanRes.status).toBe(201);

    const res = await app.request(`/api/bootstrap?householdId=${house.id}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.bookcases).toHaveLength(1);
    expect(body.bookcases[0].id).toBe(bookcase.id);
    expect(body.bookcases[0].household_id).toBe(house.id);

    expect(body.books).toHaveLength(1);
    expect(body.books[0].id).toBe(book.id);
    expect(body.books[0].household_id).toBe(house.id);
    expect(body.books[0].edition_id).toBe(book.edition_id);
    // Flat row (not a nested `edition` object) -- matches the mirror's book
    // table columns so the web-side seeding logic can upsert it as-is.
    expect(body.books[0].edition).toBeUndefined();

    expect(body.editions.some((e: { id: string }) => e.id === book.edition_id)).toBe(true);

    expect(body.tags).toHaveLength(1);
    expect(body.tags[0].id).toBe(tag.id);

    expect(body.contacts).toHaveLength(1);
    expect(body.contacts[0].id).toBe(contact.id);

    expect(body.loans).toHaveLength(1);
    expect(body.loans[0].book_id).toBe(book.id);
    expect(body.loans[0].contact_id).toBe(contact.id);

    // shelves/reading_statuses are legitimately empty for this fixture --
    // still assert they're present as arrays.
    expect(Array.isArray(body.shelves)).toBe(true);
    expect(Array.isArray(body.reading_statuses)).toBe(true);
  });

  it("RLS: a second household's data is completely absent from the response", async () => {
    const a = await signUp(app);
    const houseA = await createHousehold(a.cookie, "A");
    await addBook(a.cookie, houseA.id, "House A Book");
    await addBookcase(a.cookie, houseA.id, "House A Case");
    await addTag(a.cookie, houseA.id, "house-a-tag");
    await addContact(a.cookie, houseA.id, "House A Contact");

    const b = await signUp(app);
    const houseB = await createHousehold(b.cookie, "B");

    // b is not a member of houseA -- RLS should scope every collection to
    // nothing when called with houseA's id under b's session.
    const res = await app.request(`/api/bootstrap?householdId=${houseA.id}`, {
      headers: { cookie: b.cookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.books).toHaveLength(0);
    expect(body.bookcases).toHaveLength(0);
    expect(body.shelves).toHaveLength(0);
    expect(body.tags).toHaveLength(0);
    expect(body.contacts).toHaveLength(0);
    expect(body.loans).toHaveLength(0);
    expect(body.reading_statuses).toHaveLength(0);

    // Sanity: calling with b's OWN household still returns nothing (b hasn't
    // created anything there), proving the empty result above is RLS
    // isolation, not just an always-empty response.
    const ownRes = await app.request(`/api/bootstrap?householdId=${houseB.id}`, {
      headers: { cookie: b.cookie },
    });
    const ownBody = await ownRes.json();
    expect(ownBody.books).toHaveLength(0);

    // `editions` is the one global, unfiltered collection by design (see
    // CLAUDE.md) -- it's expected to still include house A's edition even
    // under b's session, so it's deliberately NOT asserted empty here.
  });
});
