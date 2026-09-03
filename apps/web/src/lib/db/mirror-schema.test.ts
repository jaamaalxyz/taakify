import { describe, it, expect, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import mirrorSchema from "./mirror-schema.sql?raw";

// In-memory PGlite (no dataDir -> no IndexedDB, no persistence) so this test
// doesn't touch the browser-only idb:// filesystem pglite.ts uses. Matches
// the pattern already proven out in spike/electric-pglite-spike.ts.
const db = new PGlite();

afterAll(async () => {
  await db.close();
});

const MIRROR_TABLES = [
  "edition",
  "bookcase",
  "shelf",
  "book",
  "reading_status",
  "tag",
  "book_tag",
  "contact",
  "loan",
  "outbox",
];

describe("mirror-schema.sql", () => {
  // First exec pays the full wasm compile; well over the 5s default under
  // parallel-suite load, so give it headroom (subsequent tests reuse it).
  it("creates every mirror table without error", { timeout: 30_000 }, async () => {
    await expect(db.exec(mirrorSchema)).resolves.toBeDefined();
  });

  it("is idempotent (safe to run twice, per the IF NOT EXISTS clauses)", async () => {
    await expect(db.exec(mirrorSchema)).resolves.toBeDefined();
  });

  it.each(MIRROR_TABLES)("creates table %s", async (table) => {
    const { rows } = await db.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
      [table]
    );
    expect(rows).toHaveLength(1);
  });

  it.each(MIRROR_TABLES)("allows a trivial SELECT from %s", async (table) => {
    await expect(db.query(`SELECT * FROM ${table} LIMIT 0`)).resolves.toBeDefined();
  });

  it("gives outbox rows sensible defaults for a freshly-enqueued write", async () => {
    const { rows } = await db.query<{
      attempts: number;
      status: string;
      next_retry_at: string | null;
      created_at: string;
    }>(
      `INSERT INTO outbox (id, endpoint, method, body)
       VALUES ('00000000-0000-0000-0000-000000000001', '/api/books', 'POST', '{"title":"t"}'::jsonb)
       RETURNING attempts, status, next_retry_at, created_at`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ attempts: 0, status: "pending", next_retry_at: null });
    expect(rows[0].created_at).toBeTruthy();
  });
});
