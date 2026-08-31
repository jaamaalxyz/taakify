import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { app } from "../src/app.js";
import { signUp } from "./helpers.js";

async function createHousehold(cookie: string, name = "Loans Test House") {
  const res = await app.request("/api/households", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return (await res.json()).household as { id: string };
}

async function addBook(
  cookie: string,
  householdId: string,
  title: string,
  ownership: "owned" | "borrowed_in" | "wishlist" = "owned"
) {
  const res = await app.request("/api/books", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ householdId, edition: { title, authors: "A" }, ownership }),
  });
  return (await res.json()).book as { id: string };
}

async function addContact(cookie: string, householdId: string, name: string) {
  const res = await app.request("/api/contacts", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ householdId, name }),
  });
  return (await res.json()).contact as { id: string };
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

async function createLoan(
  cookie: string,
  body: Record<string, unknown>
): Promise<{ status: number; body: any }> {
  const res = await app.request("/api/loans", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe("loans", () => {
  it("lends a book out, creating a contact by name; appears in active GET", async () => {
    const { cookie } = await signUp(app);
    const house = await createHousehold(cookie);
    const book = await addBook(cookie, house.id, "Dune");

    const created = await createLoan(cookie, {
      bookId: book.id,
      contactName: "Alice",
      direction: "lent_out",
      dueDate: "2099-01-01",
    });
    expect(created.status).toBe(201);
    expect(created.body.loan.direction).toBe("lent_out");
    expect(created.body.loan.due_date).toBe("2099-01-01");
    expect(created.body.loan.contact.name).toBe("Alice");
    expect(created.body.loan.book.id).toBe(book.id);
    expect(created.body.loan.book.edition.title).toBe("Dune");

    const list = await (
      await app.request(`/api/loans?householdId=${house.id}&active=true`, { headers: { cookie } })
    ).json();
    expect(list.loans).toHaveLength(1);
    expect(list.loans[0].id).toBe(created.body.loan.id);
  });

  it("stores the client-supplied outDate instead of defaulting to the server clock's date", async () => {
    const { cookie } = await signUp(app);
    const house = await createHousehold(cookie);
    const book = await addBook(cookie, house.id, "Dune");

    const created = await createLoan(cookie, {
      bookId: book.id,
      contactName: "Alice",
      direction: "lent_out",
      outDate: "2020-06-15",
    });
    expect(created.status).toBe(201);
    expect(created.body.loan.out_date).toBe("2020-06-15");
  });

  it("lends a book out reusing an existing contactId", async () => {
    const { cookie } = await signUp(app);
    const house = await createHousehold(cookie);
    const book = await addBook(cookie, house.id, "Dune");
    const contact = await addContact(cookie, house.id, "Bob");

    const created = await createLoan(cookie, {
      bookId: book.id,
      contactId: contact.id,
      direction: "lent_out",
    });
    expect(created.status).toBe(201);
    expect(created.body.loan.contact.id).toBe(contact.id);
    expect(created.body.loan.contact.name).toBe("Bob");
  });

  it("marks a loan returned via PATCH; moves from active to history", async () => {
    const { cookie } = await signUp(app);
    const house = await createHousehold(cookie);
    const book = await addBook(cookie, house.id, "Dune");
    const created = await createLoan(cookie, {
      bookId: book.id,
      contactName: "Carol",
      direction: "lent_out",
    });

    const patchRes = await app.request(`/api/loans/${created.body.loan.id}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ returned_date: "2026-01-01" }),
    });
    expect(patchRes.status).toBe(200);
    const patched = await patchRes.json();
    expect(patched.loan.returned_date).toBe("2026-01-01");

    const activeList = await (
      await app.request(`/api/loans?householdId=${house.id}&active=true`, { headers: { cookie } })
    ).json();
    expect(activeList.loans).toHaveLength(0);

    const allList = await (
      await app.request(`/api/loans?householdId=${house.id}`, { headers: { cookie } })
    ).json();
    expect(allList.loans).toHaveLength(1);
    expect(allList.loans[0].id).toBe(created.body.loan.id);
  });

  it("computes overdue: past due date + not returned = true", async () => {
    const { cookie } = await signUp(app);
    const house = await createHousehold(cookie);
    const book = await addBook(cookie, house.id, "Dune");
    await createLoan(cookie, {
      bookId: book.id,
      contactName: "Dan",
      direction: "lent_out",
      dueDate: "2000-01-01",
    });

    const list = await (
      await app.request(`/api/loans?householdId=${house.id}`, { headers: { cookie } })
    ).json();
    expect(list.loans[0].overdue).toBe(true);
  });

  it("computes overdue: future due date = false", async () => {
    const { cookie } = await signUp(app);
    const house = await createHousehold(cookie);
    const book = await addBook(cookie, house.id, "Dune");
    await createLoan(cookie, {
      bookId: book.id,
      contactName: "Erin",
      direction: "lent_out",
      dueDate: "2099-01-01",
    });

    const list = await (
      await app.request(`/api/loans?householdId=${house.id}`, { headers: { cookie } })
    ).json();
    expect(list.loans[0].overdue).toBe(false);
  });

  it("computes overdue: no due date = false", async () => {
    const { cookie } = await signUp(app);
    const house = await createHousehold(cookie);
    const book = await addBook(cookie, house.id, "Dune");
    await createLoan(cookie, {
      bookId: book.id,
      contactName: "Frank",
      direction: "lent_out",
    });

    const list = await (
      await app.request(`/api/loans?householdId=${house.id}`, { headers: { cookie } })
    ).json();
    expect(list.loans[0].overdue).toBe(false);
  });

  it("borrowed-in book with an active borrowed_in loan is excluded from owned filter", async () => {
    const { cookie } = await signUp(app);
    const house = await createHousehold(cookie);
    const book = await addBook(cookie, house.id, "Borrowed Book", "borrowed_in");
    await createLoan(cookie, {
      bookId: book.id,
      contactName: "Grace",
      direction: "borrowed_in",
    });

    const owned = await (
      await app.request(`/api/books?householdId=${house.id}&ownership=owned`, { headers: { cookie } })
    ).json();
    expect(owned.books.find((b: any) => b.id === book.id)).toBeUndefined();
  });

  it("GET /api/loans?bookId= filters to only that book's loans", async () => {
    const { cookie } = await signUp(app);
    const house = await createHousehold(cookie);
    const bookA = await addBook(cookie, house.id, "Dune");
    const bookB = await addBook(cookie, house.id, "Emma");
    const loanA = await createLoan(cookie, {
      bookId: bookA.id,
      contactName: "Ivy",
      direction: "lent_out",
    });
    await createLoan(cookie, {
      bookId: bookB.id,
      contactName: "Jack",
      direction: "lent_out",
    });

    const list = await (
      await app.request(`/api/loans?householdId=${house.id}&bookId=${bookA.id}`, { headers: { cookie } })
    ).json();
    expect(list.loans).toHaveLength(1);
    expect(list.loans[0].id).toBe(loanA.body.loan.id);
    expect(list.loans[0].book.id).toBe(bookA.id);
  });

  it("RLS: bookId filter can't be used to peek at another household's loan via a foreign bookId", async () => {
    // householdId is always RLS-scoped to the caller's own household — this
    // proves the bookId param can't be paired with a foreign householdId
    // (b's own household) plus a's book id to leak a's loan data. The route
    // enforces `l.household_id = $1` unconditionally, but this test locks
    // that guarantee in so a future refactor of the where-array builder
    // can't silently regress it.
    const a = await signUp(app);
    const houseA = await createHousehold(a.cookie, "A");
    const bookA = await addBook(a.cookie, houseA.id, "Secret Book");
    await createLoan(a.cookie, { bookId: bookA.id, contactName: "Hank", direction: "lent_out" });

    const b = await signUp(app);
    const houseB = await createHousehold(b.cookie, "B");
    const list = await (
      await app.request(`/api/loans?householdId=${houseB.id}&bookId=${bookA.id}`, {
        headers: { cookie: b.cookie },
      })
    ).json();
    expect(list.loans).toHaveLength(0);
  });

  it("RLS: household B never sees household A's loans", async () => {
    const a = await signUp(app);
    const houseA = await createHousehold(a.cookie, "A");
    const bookA = await addBook(a.cookie, houseA.id, "Secret Book");
    await createLoan(a.cookie, { bookId: bookA.id, contactName: "Hank", direction: "lent_out" });

    const b = await signUp(app);
    const houseB = await createHousehold(b.cookie, "B");
    const list = await (
      await app.request(`/api/loans?householdId=${houseB.id}`, { headers: { cookie: b.cookie } })
    ).json();
    expect(list.loans).toHaveLength(0);
  });

  it("a user in two households cannot create a loan using another household's contactId", async () => {
    const a = await signUp(app);
    const houseA = await createHousehold(a.cookie, "A");
    const bookA = await addBook(a.cookie, houseA.id, "Book A");

    const b = await signUp(app);
    const houseB = await createHousehold(b.cookie, "B");
    const contactB = await addContact(b.cookie, houseB.id, "B-only Contact");

    // a joins household B too, so a's RLS membership check alone would allow
    // inserting a loan row scoped to household B — the route must additionally
    // verify the contact's household matches the book's derived household.
    await inviteAndJoin(b.cookie, houseB.id, a.cookie);

    const res = await createLoan(a.cookie, {
      bookId: bookA.id,
      contactId: contactB.id,
      direction: "lent_out",
    });
    expect(res.status).toBe(404);
  });

  it("requires bookId", async () => {
    const { cookie } = await signUp(app);
    const res = await createLoan(cookie, { contactName: "X", direction: "lent_out" });
    expect(res.status).toBe(400);
  });

  it("requires exactly one of contactId or contactName", async () => {
    const { cookie } = await signUp(app);
    const house = await createHousehold(cookie);
    const book = await addBook(cookie, house.id, "Dune");
    const res = await createLoan(cookie, { bookId: book.id, direction: "lent_out" });
    expect(res.status).toBe(400);
  });

  it("404s for a nonexistent book", async () => {
    const { cookie } = await signUp(app);
    const res = await createLoan(cookie, {
      bookId: randomUUID(),
      contactName: "X",
      direction: "lent_out",
    });
    expect(res.status).toBe(404);
  });

  it("PATCH 404s for a nonexistent loan", async () => {
    const { cookie } = await signUp(app);
    const res = await app.request(`/api/loans/${randomUUID()}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ returned_date: "2026-01-01" }),
    });
    expect(res.status).toBe(404);
  });

  it("GET requires householdId", async () => {
    const { cookie } = await signUp(app);
    const res = await app.request("/api/loans", { headers: { cookie } });
    expect(res.status).toBe(400);
  });

  it("requires auth on POST, PATCH, GET", async () => {
    const postRes = await app.request("/api/loans", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(postRes.status).toBe(401);

    const patchRes = await app.request(`/api/loans/${randomUUID()}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(patchRes.status).toBe(401);

    const getRes = await app.request("/api/loans?householdId=x");
    expect(getRes.status).toBe(401);
  });

  // --- Client-supplied id + idempotent upsert (fix round) -----------------
  // repo/loans.ts generates the loan's id (and, when creating a contact
  // inline via contactName, that contact's id too, sent as `newContactId`)
  // client-side so the server row converges on the same id(s) instead of
  // permanently duplicating once Electric syncs it down.

  it("POST with a client-supplied id (and newContactId for an inline contact) creates both under those exact ids", async () => {
    const { cookie } = await signUp(app);
    const house = await createHousehold(cookie);
    const book = await addBook(cookie, house.id, "Dune");
    const loanId = randomUUID();
    const contactId = randomUUID();

    const res = await createLoan(cookie, {
      id: loanId,
      bookId: book.id,
      contactName: "Client Id Contact",
      newContactId: contactId,
      direction: "lent_out",
    });
    expect(res.status).toBe(201);
    expect(res.body.loan.id).toBe(loanId);
    expect(res.body.loan.contact.id).toBe(contactId);
    expect(res.body.loan.contact.name).toBe("Client Id Contact");
  });

  it("POST retried with the same client-supplied id (and newContactId) returns the same rows, not duplicates", async () => {
    const { cookie } = await signUp(app);
    const house = await createHousehold(cookie);
    const book = await addBook(cookie, house.id, "Dune");
    const loanId = randomUUID();
    const contactId = randomUUID();
    const body = {
      id: loanId,
      bookId: book.id,
      contactName: "Retried Contact",
      newContactId: contactId,
      direction: "lent_out" as const,
    };

    const first = await createLoan(cookie, body);
    expect(first.status).toBe(201);

    const retry = await createLoan(cookie, body);
    expect(retry.status).toBe(201);
    expect(retry.body.loan.id).toBe(loanId);
    expect(retry.body.loan.contact.id).toBe(contactId);

    const list = await (
      await app.request(`/api/loans?householdId=${house.id}`, { headers: { cookie } })
    ).json();
    expect(list.loans).toHaveLength(1);

    const contacts = await (
      await app.request(`/api/contacts?householdId=${house.id}`, { headers: { cookie } })
    ).json();
    expect(contacts.contacts.filter((c: any) => c.id === contactId)).toHaveLength(1);
  });

  it("POST without a client-supplied id (or newContactId) still server-generates them (backward compatible)", async () => {
    const { cookie } = await signUp(app);
    const house = await createHousehold(cookie);
    const book = await addBook(cookie, house.id, "Dune");

    const created = await createLoan(cookie, {
      bookId: book.id,
      contactName: "No Client Id",
      direction: "lent_out",
    });
    expect(created.status).toBe(201);
    expect(created.body.loan.id).toBeTruthy();
    expect(created.body.loan.contact.id).toBeTruthy();
  });
});
