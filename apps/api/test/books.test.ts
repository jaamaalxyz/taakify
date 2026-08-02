import { describe, it, expect } from "vitest";
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
});
