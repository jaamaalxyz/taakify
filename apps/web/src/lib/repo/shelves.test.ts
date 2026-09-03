// Repo-layer unit tests against a real (in-memory) PGlite instance --
// see tags.test.ts / loans.test.ts's header comments for the general
// rationale. Priority target here is issue #13's reorderShelves: it must
// write every shelf's new position atomically (one outbox row, one PGlite
// transaction), matching the server's atomic reorder endpoint.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../db/pglite.js", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const mirrorSchema = (await import("../db/mirror-schema.sql?raw")).default;
  const testDb = new PGlite();
  return { db: testDb, ready: testDb.exec(mirrorSchema) };
});

import { db, ready } from "../db/pglite.js";
import { reorderShelves } from "./shelves.js";

const HOUSEHOLD = "00000000-0000-0000-0000-00000000000a";
const BOOKCASE = "00000000-0000-0000-0000-00000000000b";
const USER = "user-1";

async function seedBookcaseAndShelves(shelves: { id: string; position: number; label: string }[]) {
  await db.query(
    `INSERT INTO bookcase (id, household_id, name, created_by, created_at, updated_at)
     VALUES ($1, $2, 'Living Room', $3, now(), now())`,
    [BOOKCASE, HOUSEHOLD, USER]
  );
  for (const s of shelves) {
    await db.query(
      `INSERT INTO shelf (id, household_id, bookcase_id, position, label, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now(), now())`,
      [s.id, HOUSEHOLD, BOOKCASE, s.position, s.label, USER]
    );
  }
}

beforeEach(async () => {
  await ready;
  await db.exec("DELETE FROM outbox");
  await db.exec("DELETE FROM shelf");
  await db.exec("DELETE FROM bookcase");
  // enqueue() fires a background flush on every call; stub fetch to fail
  // fast so these tests never make a real network call.
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("no network in tests")));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("reorderShelves (issue #13)", () => {
  it("writes every shelf's new position atomically as ONE outbox entry", async () => {
    const a = "00000000-0000-0000-0000-000000000010";
    const b = "00000000-0000-0000-0000-000000000011";
    const c = "00000000-0000-0000-0000-000000000012";
    await seedBookcaseAndShelves([
      { id: a, position: 1, label: "Fiction" },
      { id: b, position: 2, label: "Nonfiction" },
      { id: c, position: 3, label: "Reference" },
    ]);

    await reorderShelves(BOOKCASE, [c, a, b]);

    const { rows: outboxRows } = await db.query<{ endpoint: string; method: string; body: unknown }>(
      "SELECT endpoint, method, body FROM outbox"
    );
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]).toMatchObject({
      endpoint: `/api/bookcases/${BOOKCASE}/reorder`,
      method: "POST",
      body: { shelfIds: [c, a, b] },
    });

    const { rows: shelfRows } = await db.query<{ id: string; position: number }>(
      "SELECT id, position FROM shelf WHERE bookcase_id = $1 ORDER BY position",
      [BOOKCASE]
    );
    expect(shelfRows).toEqual([
      { id: c, position: 1 },
      { id: a, position: 2 },
      { id: b, position: 3 },
    ]);
  });

  it("a fast second call always sees the first call's optimistic positions (same PGlite transaction, no interleaving)", async () => {
    const a = "00000000-0000-0000-0000-000000000020";
    const b = "00000000-0000-0000-0000-000000000021";
    await seedBookcaseAndShelves([
      { id: a, position: 1, label: "Fiction" },
      { id: b, position: 2, label: "Nonfiction" },
    ]);

    await reorderShelves(BOOKCASE, [b, a]);
    await reorderShelves(BOOKCASE, [a, b]);

    const { rows: outboxRows } = await db.query("SELECT * FROM outbox");
    expect(outboxRows).toHaveLength(2);

    const { rows: shelfRows } = await db.query<{ id: string; position: number }>(
      "SELECT id, position FROM shelf WHERE bookcase_id = $1 ORDER BY position",
      [BOOKCASE]
    );
    expect(shelfRows).toEqual([
      { id: a, position: 1 },
      { id: b, position: 2 },
    ]);
  });
});
