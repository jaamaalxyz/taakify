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

  it("a user in two households cannot attach household B's tag to household A's book", async () => {
    const a = await signUp(app);
    const houseA = await createHousehold(a.cookie, "A");
    const book = await addBook(a.cookie, houseA.id, "Sapiens");

    // b owns household B and has its own tag.
    const b = await signUp(app);
    const houseB = await createHousehold(b.cookie, "B");
    const tagB = await addTag(b.cookie, houseB.id, "b-only");

    // a joins household B too, so a's RLS membership check alone would allow
    // inserting a book_tag row scoped to household B's household_id — the
    // route must additionally verify the tag's household matches the book's.
    await inviteAndJoin(b.cookie, houseB.id, a.cookie);

    const res = await app.request(`/api/books/${book.id}/tags`, {
      method: "POST",
      headers: { cookie: a.cookie, "content-type": "application/json" },
      body: JSON.stringify({ tagId: tagB.body.tag.id }),
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

  // --- Client-supplied id + idempotent upsert (fix round) -----------------

  it("POST with a client-supplied id creates the tag under that exact id", async () => {
    const { cookie } = await signUp(app);
    const house = await createHousehold(cookie);
    const id = randomUUID();

    const res = await app.request("/api/tags", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ id, householdId: house.id, name: "client-id-tag" }),
    });
    expect(res.status).toBe(201);
    expect((await res.json()).tag.id).toBe(id);
  });

  it("POST retried with the same client-supplied id (and same name) returns the same row, not a duplicate", async () => {
    const { cookie } = await signUp(app);
    const house = await createHousehold(cookie);
    const id = randomUUID();
    const body = JSON.stringify({ id, householdId: house.id, name: "retried-tag" });

    const first = await app.request("/api/tags", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body,
    });
    expect(first.status).toBe(201);

    const retry = await app.request("/api/tags", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body,
    });
    expect(retry.status).toBe(201);
    expect((await retry.json()).tag.id).toBe(id);

    const list = await (
      await app.request(`/api/tags?householdId=${house.id}`, { headers: { cookie } })
    ).json();
    expect(list.tags).toHaveLength(1);
  });

  it("POST without a client-supplied id still server-generates one (backward compatible)", async () => {
    const { cookie } = await signUp(app);
    const house = await createHousehold(cookie);
    const created = await addTag(cookie, house.id, "no-client-id");
    expect(created.status).toBe(201);
    expect(created.body.tag.id).toBeTruthy();
  });

  it("two different client-supplied ids racing on the same name still resolve via the existing name-uniqueness fallback (residual documented gap)", async () => {
    const { cookie } = await signUp(app);
    const house = await createHousehold(cookie);
    const idA = randomUUID();
    const idB = randomUUID();

    const first = await app.request("/api/tags", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ id: idA, householdId: house.id, name: "same-name" }),
    });
    expect(first.status).toBe(201);
    expect((await first.json()).tag.id).toBe(idA);

    // A different id, same name: this is NOT a retry of the same create —
    // it's the documented residual gap (two different local optimistic ids
    // legitimately colliding on name). The existing get-existing-by-name
    // fallback wins: the second caller's id is discarded and the FIRST
    // tag's row is returned instead, with a 200 (not 201) to signal "this
    // already existed" per the route's original idempotent-get-or-create
    // contract.
    const second = await app.request("/api/tags", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ id: idB, householdId: house.id, name: "same-name" }),
    });
    expect(second.status).toBe(200);
    expect((await second.json()).tag.id).toBe(idA);

    const list = await (
      await app.request(`/api/tags?householdId=${house.id}`, { headers: { cookie } })
    ).json();
    expect(list.tags).toHaveLength(1);
  });

  // --- book_tag client-supplied id + idempotent upsert (Critical 3, final
  // review fix round) -----------------------------------------------------

  it("POST /books/:bookId/tags with a client-supplied id creates the book_tag row under that exact id", async () => {
    const { cookie } = await signUp(app);
    const house = await createHousehold(cookie);
    const book = await addBook(cookie, house.id, "Sapiens");
    const tag = await addTag(cookie, house.id, "history");
    const id = randomUUID();

    const res = await app.request(`/api/books/${book.id}/tags`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ id, tagId: tag.body.tag.id }),
    });
    expect(res.status).toBe(201);
    expect((await res.json()).bookTag.id).toBe(id);
  });

  it("POST /books/:bookId/tags retried with the same client-supplied id returns the same row, not a duplicate (Critical 3 regression test)", async () => {
    const { cookie } = await signUp(app);
    const house = await createHousehold(cookie);
    const book = await addBook(cookie, house.id, "Sapiens");
    const tag = await addTag(cookie, house.id, "history");
    const id = randomUUID();
    const body = JSON.stringify({ id, tagId: tag.body.tag.id });

    const first = await app.request(`/api/books/${book.id}/tags`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body,
    });
    expect(first.status).toBe(201);
    expect((await first.json()).bookTag.id).toBe(id);

    const retry = await app.request(`/api/books/${book.id}/tags`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body,
    });
    expect(retry.status).toBe(201);
    expect((await retry.json()).bookTag.id).toBe(id);

    // No duplicate chip: exactly one tag on the book afterward, same as
    // repo/tags.ts's listBookTags would read from the local mirror.
    const listed = await (
      await app.request(`/api/books/${book.id}/tags`, { headers: { cookie } })
    ).json();
    expect(listed.tags).toHaveLength(1);
  });

  it("POST /books/:bookId/tags without a client-supplied id still server-generates one (backward compatible)", async () => {
    const { cookie } = await signUp(app);
    const house = await createHousehold(cookie);
    const book = await addBook(cookie, house.id, "Sapiens");
    const tag = await addTag(cookie, house.id, "history");

    const res = await app.request(`/api/books/${book.id}/tags`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ tagId: tag.body.tag.id }),
    });
    expect(res.status).toBe(201);
    expect((await res.json()).bookTag.id).toBeTruthy();
  });
});
