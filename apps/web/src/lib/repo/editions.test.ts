// uploadEditionCover tests against a real in-memory PGlite mirror (same
// pattern as home.test.ts): the outbox insert and the optimistic
// edition.cover_url write happen in one transaction, so both are asserted
// against the actual database state.
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

vi.mock("../db/pglite.js", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const mirrorSchema = (await import("../db/mirror-schema.sql?raw")).default;
  const testDb = new PGlite();
  return { db: testDb, ready: testDb.exec(mirrorSchema) };
});

import { db, ready } from "../db/pglite.js";
import { uploadEditionCover } from "./editions.js";

const EDITION = "00000000-0000-0000-0000-0000000000aa";
const DATA_URL = "data:image/jpeg;base64,Zm9v";

beforeEach(async () => {
  await ready;
  await db.exec("DELETE FROM outbox");
  await db.exec("DELETE FROM edition");
  await db.query(
    `INSERT INTO edition (id, title, authors, created_at, updated_at)
     VALUES ($1, 'Local Book', 'A', now(), now())`,
    [EDITION]
  );
});

afterAll(async () => {
  await db.close();
});

describe("uploadEditionCover", () => {
  it("records the outbox row with the data-url body", async () => {
    await uploadEditionCover(EDITION, DATA_URL);

    const { rows } = await db.query<{ endpoint: string; method: string; body: { data_url: string } }>(
      "SELECT endpoint, method, body FROM outbox LIMIT 1"
    );
    expect(rows[0].endpoint).toBe(`/api/editions/${EDITION}/cover`);
    expect(rows[0].method).toBe("POST");
    expect(rows[0].body).toEqual({ data_url: DATA_URL });
  });

  it("optimistically writes the data url into the mirror's edition.cover_url", async () => {
    await uploadEditionCover(EDITION, DATA_URL);

    const { rows } = await db.query<{ cover_url: string | null }>(
      "SELECT cover_url FROM edition WHERE id = $1",
      [EDITION]
    );
    // The data URL is a temporary preview: when the replayed upload lands
    // and Electric streams the row back, the real object URL overwrites it.
    expect(rows[0].cover_url).toBe(DATA_URL);
  });

  it("touches the edition row so the Unsynced badge surfaces it", async () => {
    await uploadEditionCover(EDITION, DATA_URL);

    const { rows } = await db.query<{ touched: Array<{ table: string; id: string }> | null }>(
      "SELECT touched FROM outbox LIMIT 1"
    );
    expect(rows[0].touched).toEqual([{ table: "edition", id: EDITION }]);
  });
});
