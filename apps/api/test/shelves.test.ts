import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { app } from "../src/app.js";
import { signUp } from "./helpers.js";

async function createHousehold(cookie: string, name = "Shelves Test House") {
  const res = await app.request("/api/households", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return (await res.json()).household as { id: string };
}

async function addBookcase(cookie: string, householdId: string, name = "Living Room") {
  const res = await app.request("/api/bookcases", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ householdId, name }),
  });
  return { status: res.status, body: await res.json() };
}

describe("bookcases + shelves", () => {
  it("creates a bookcase and lists it with an empty shelves array", async () => {
    const { cookie } = await signUp(app);
    const house = await createHousehold(cookie);
    const created = await addBookcase(cookie, house.id, "Living Room");
    expect(created.status).toBe(201);
    expect(created.body.bookcase.id).toBeTruthy();
    expect(created.body.bookcase.name).toBe("Living Room");

    const list = await (
      await app.request(`/api/bookcases?householdId=${house.id}`, { headers: { cookie } })
    ).json();
    expect(list.bookcases).toHaveLength(1);
    expect(list.bookcases[0].name).toBe("Living Room");
    expect(list.bookcases[0].shelves).toEqual([]);
  });

  it("POST /api/bookcases requires householdId and name", async () => {
    const { cookie } = await signUp(app);
    const res = await app.request("/api/bookcases", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("GET /api/bookcases requires householdId", async () => {
    const { cookie } = await signUp(app);
    const res = await app.request("/api/bookcases", { headers: { cookie } });
    expect(res.status).toBe(400);
  });

  it("creates shelves under a bookcase with auto-incrementing position, nested in the list", async () => {
    const { cookie } = await signUp(app);
    const house = await createHousehold(cookie);
    const bc = await addBookcase(cookie, house.id);

    const shelf1 = await app.request(`/api/bookcases/${bc.body.bookcase.id}/shelves`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ label: "Fiction" }),
    });
    expect(shelf1.status).toBe(201);
    const shelf1Body = await shelf1.json();
    expect(shelf1Body.shelf.position).toBe(1);

    const shelf2 = await app.request(`/api/bookcases/${bc.body.bookcase.id}/shelves`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ label: "Nonfiction" }),
    });
    expect(shelf2.status).toBe(201);
    const shelf2Body = await shelf2.json();
    expect(shelf2Body.shelf.position).toBe(2);

    // client-supplied position must be ignored
    const shelf3 = await app.request(`/api/bookcases/${bc.body.bookcase.id}/shelves`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ label: "Ignored position", position: 999 }),
    });
    const shelf3Body = await shelf3.json();
    expect(shelf3Body.shelf.position).toBe(3);

    const list = await (
      await app.request(`/api/bookcases?householdId=${house.id}`, { headers: { cookie } })
    ).json();
    expect(list.bookcases[0].shelves).toHaveLength(3);
    expect(list.bookcases[0].shelves.map((s: any) => s.label)).toEqual([
      "Fiction",
      "Nonfiction",
      "Ignored position",
    ]);
  });

  it("concurrent POST /:id/shelves calls never produce duplicate positions", async () => {
    const { cookie } = await signUp(app);
    const house = await createHousehold(cookie);
    const bc = await addBookcase(cookie, house.id);

    const post = async (label: string) => {
      const res = await app.request(`/api/bookcases/${bc.body.bookcase.id}/shelves`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ label }),
      });
      return res.json();
    };

    const results = await Promise.all([
      post("Concurrent A"),
      post("Concurrent B"),
      post("Concurrent C"),
    ]);
    const positions = results.map((r: any) => r.shelf.position).sort((a: number, b: number) => a - b);
    expect(positions).toEqual([1, 2, 3]);
    expect(new Set(positions).size).toBe(3);
  });

  it("POST /:id/shelves returns 404 for a nonexistent bookcase", async () => {
    const { cookie } = await signUp(app);
    const res = await app.request(`/api/bookcases/${randomUUID()}/shelves`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ label: "Fiction" }),
    });
    expect(res.status).toBe(404);
  });

  it("PATCH /api/shelves/:id updates label and position", async () => {
    const { cookie } = await signUp(app);
    const house = await createHousehold(cookie);
    const bc = await addBookcase(cookie, house.id);
    const shelfRes = await app.request(`/api/bookcases/${bc.body.bookcase.id}/shelves`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ label: "Fiction" }),
    });
    const shelf = (await shelfRes.json()).shelf;

    const patched = await app.request(`/api/shelves/${shelf.id}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ label: "Sci-Fi", position: 5 }),
    });
    expect(patched.status).toBe(200);
    const patchedBody = await patched.json();
    expect(patchedBody.shelf.label).toBe("Sci-Fi");
    expect(patchedBody.shelf.position).toBe(5);
  });

  it("PATCH /api/shelves/:id with empty body returns 400", async () => {
    const { cookie } = await signUp(app);
    const house = await createHousehold(cookie);
    const bc = await addBookcase(cookie, house.id);
    const shelfRes = await app.request(`/api/bookcases/${bc.body.bookcase.id}/shelves`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ label: "Fiction" }),
    });
    const shelf = (await shelfRes.json()).shelf;

    const res = await app.request(`/api/shelves/${shelf.id}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("PATCH /api/shelves/:id rejects a non-integer, non-numeric, or sub-1 position with 400", async () => {
    const { cookie } = await signUp(app);
    const house = await createHousehold(cookie);
    const bc = await addBookcase(cookie, house.id);
    const shelfRes = await app.request(`/api/bookcases/${bc.body.bookcase.id}/shelves`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ label: "Fiction" }),
    });
    const shelf = (await shelfRes.json()).shelf;

    for (const badPosition of [1.5, "abc", 0, -1, true, null]) {
      const res = await app.request(`/api/shelves/${shelf.id}`, {
        method: "PATCH",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ position: badPosition }),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("position must be a positive integer");
    }
  });

  it("PATCH /api/shelves/:id returns 404 for a nonexistent shelf", async () => {
    const { cookie } = await signUp(app);
    const res = await app.request(`/api/shelves/${randomUUID()}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ label: "x" }),
    });
    expect(res.status).toBe(404);
  });

  it("DELETE /api/shelves/:id soft-deletes and removes it from the nested list", async () => {
    const { cookie } = await signUp(app);
    const house = await createHousehold(cookie);
    const bc = await addBookcase(cookie, house.id);
    const shelfRes = await app.request(`/api/bookcases/${bc.body.bookcase.id}/shelves`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ label: "Fiction" }),
    });
    const shelf = (await shelfRes.json()).shelf;

    const del = await app.request(`/api/shelves/${shelf.id}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(del.status).toBe(200);

    const list = await (
      await app.request(`/api/bookcases?householdId=${house.id}`, { headers: { cookie } })
    ).json();
    expect(list.bookcases[0].shelves).toHaveLength(0);
  });

  it("DELETE /api/shelves/:id returns 404 for a nonexistent shelf", async () => {
    const { cookie } = await signUp(app);
    const res = await app.request(`/api/shelves/${randomUUID()}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(res.status).toBe(404);
  });

  it("RLS: household B never sees household A's bookcases or shelves", async () => {
    const a = await signUp(app);
    const houseA = await createHousehold(a.cookie, "A");
    const bcA = await addBookcase(a.cookie, houseA.id, "A's case");
    await app.request(`/api/bookcases/${bcA.body.bookcase.id}/shelves`, {
      method: "POST",
      headers: { cookie: a.cookie, "content-type": "application/json" },
      body: JSON.stringify({ label: "A's shelf" }),
    });

    const b = await signUp(app);
    const houseB = await createHousehold(b.cookie, "B");
    const list = await (
      await app.request(`/api/bookcases?householdId=${houseB.id}`, { headers: { cookie: b.cookie } })
    ).json();
    expect(list.bookcases).toHaveLength(0);

    // Cross-household access to a specific bookcase's shelves endpoint is also rejected (404).
    const crossPost = await app.request(`/api/bookcases/${bcA.body.bookcase.id}/shelves`, {
      method: "POST",
      headers: { cookie: b.cookie, "content-type": "application/json" },
      body: JSON.stringify({ label: "Sneaky" }),
    });
    expect(crossPost.status).toBe(404);
  });

  it("requires auth", async () => {
    const res = await app.request("/api/bookcases?householdId=x");
    expect(res.status).toBe(401);
    const res2 = await app.request(`/api/shelves/${randomUUID()}`, { method: "DELETE" });
    expect(res2.status).toBe(401);
  });
});
