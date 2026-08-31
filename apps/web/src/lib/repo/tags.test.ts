// Repo-layer unit tests against a real (in-memory) PGlite instance --
// Important 7, final whole-branch review: no repo/*.ts file had unit tests
// before this round, which is the structural reason Critical 3 (tags.ts's
// attachBookTag never sending its optimistic id to the server) survived
// past task-level review. Matches outbox.test.ts's/shape.test.ts's existing
// convention: mock ../db/pglite.js's singleton to a real, working in-memory
// PGlite (schema applied), so these tests exercise the actual SQL this repo
// file runs, not a mocked db.query().
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";

vi.mock("../db/pglite.js", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const mirrorSchema = (await import("../db/mirror-schema.sql?raw")).default;
  const testDb = new PGlite();
  return { db: testDb, ready: testDb.exec(mirrorSchema) };
});

import { db, ready } from "../db/pglite.js";
import { listBookTags, findOrCreateTag, attachBookTag, removeBookTag } from "./tags.js";

const HOUSEHOLD = "00000000-0000-0000-0000-00000000000a";
const EDITION = "00000000-0000-0000-0000-00000000000b";
const USER = "user-1";

async function seedBook(id: string) {
  await db.query(
    `INSERT INTO book (id, household_id, edition_id, ownership, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, 'owned', $4, now(), now())`,
    [id, HOUSEHOLD, EDITION, USER]
  );
}

beforeEach(async () => {
  await ready;
  await db.exec("DELETE FROM outbox");
  await db.exec("DELETE FROM book_tag");
  await db.exec("DELETE FROM tag");
  await db.exec("DELETE FROM book");
  // enqueue() now fires a background flush on every call (Critical 1 fix);
  // stub fetch to fail fast so these tests never make a real network call
  // -- they only assert on the local mirror + outbox state, not on
  // send/retry behavior (that's outbox.test.ts's job).
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("no network in tests")));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await db.close();
});

describe("findOrCreateTag", () => {
  it("creates a new tag locally and enqueues POST /api/tags with the same client-generated id", async () => {
    const tag = await findOrCreateTag(HOUSEHOLD, "sci-fi", USER);

    const { rows: tagRows } = await db.query<{ id: string; name: string }>(
      "SELECT id, name FROM tag WHERE id = $1",
      [tag.id]
    );
    expect(tagRows[0]).toMatchObject({ id: tag.id, name: "sci-fi" });

    const { rows: outboxRows } = await db.query<{ body: { id: string; name: string } }>(
      "SELECT body FROM outbox WHERE endpoint = '/api/tags'"
    );
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0].body).toMatchObject({ id: tag.id, name: "sci-fi" });
  });

  it("returns the existing local tag without any new write when one already exists", async () => {
    const first = await findOrCreateTag(HOUSEHOLD, "history", USER);
    const second = await findOrCreateTag(HOUSEHOLD, "history", USER);
    expect(second.id).toBe(first.id);

    const { rows } = await db.query<{ c: number }>(
      "SELECT count(*)::int AS c FROM outbox WHERE endpoint = '/api/tags'"
    );
    expect(rows[0].c).toBe(1);
  });
});

describe("attachBookTag (Critical 3 regression)", () => {
  it("sends the optimistic local book_tag id in the request body, so a retry converges on the same row", async () => {
    const bookId = "00000000-0000-0000-0000-000000000010";
    await seedBook(bookId);
    const tag = await findOrCreateTag(HOUSEHOLD, "sci-fi", USER);

    await attachBookTag(bookId, HOUSEHOLD, tag.id);

    const { rows: bookTagRows } = await db.query<{ id: string; tag_id: string }>(
      "SELECT id, tag_id FROM book_tag WHERE book_id = $1",
      [bookId]
    );
    expect(bookTagRows).toHaveLength(1);
    const localId = bookTagRows[0].id;

    const { rows: outboxRows } = await db.query<{ body: { id: string; tagId: string } }>(
      `SELECT body FROM outbox WHERE endpoint = '/api/books/${bookId}/tags'`
    );
    expect(outboxRows).toHaveLength(1);
    // This is exactly the assertion that would have caught Critical 3: the
    // request body must carry the SAME id as the optimistic local row, not
    // just { tagId }.
    expect(outboxRows[0].body).toEqual({ id: localId, tagId: tag.id });
  });

  it("records the BOOK as the touched entity, so a dead-lettered tag add badges the book (issue #16)", async () => {
    const bookId = "00000000-0000-0000-0000-000000000013";
    await seedBook(bookId);
    const tag = await findOrCreateTag(HOUSEHOLD, "sci-fi", USER);

    await attachBookTag(bookId, HOUSEHOLD, tag.id);

    const { rows } = await db.query<{ touched: { table: string; id: string }[] }>(
      `SELECT touched FROM outbox WHERE endpoint = '/api/books/${bookId}/tags'`
    );
    // Not the derived (book_tag, <row id>) pair -- no surface renders
    // book_tag rows, so that would badge nothing.
    expect(rows[0].touched).toEqual([{ table: "book", id: bookId }]);
  });

  it("listBookTags returns exactly one row per attached tag", async () => {
    const bookId = "00000000-0000-0000-0000-000000000011";
    await seedBook(bookId);
    const tag = await findOrCreateTag(HOUSEHOLD, "history", USER);
    await attachBookTag(bookId, HOUSEHOLD, tag.id);

    const tags = await listBookTags(bookId);
    expect(tags).toHaveLength(1);
    expect(tags[0].id).toBe(tag.id);
  });
});

describe("removeBookTag", () => {
  it("soft-deletes the book_tag row locally and enqueues the DELETE", async () => {
    const bookId = "00000000-0000-0000-0000-000000000012";
    await seedBook(bookId);
    const tag = await findOrCreateTag(HOUSEHOLD, "romance", USER);
    await attachBookTag(bookId, HOUSEHOLD, tag.id);

    await removeBookTag(bookId, tag.id);

    const tags = await listBookTags(bookId);
    expect(tags).toHaveLength(0);

    const { rows } = await db.query(
      `SELECT * FROM outbox WHERE endpoint = '/api/books/${bookId}/tags/${tag.id}' AND method = 'DELETE'`
    );
    expect(rows).toHaveLength(1);
  });

  it("records the BOOK as the touched entity, not the derived (book_tag, bookId) mismatch (issue #16)", async () => {
    const bookId = "00000000-0000-0000-0000-000000000014";
    await seedBook(bookId);
    const tag = await findOrCreateTag(HOUSEHOLD, "romance", USER);
    await attachBookTag(bookId, HOUSEHOLD, tag.id);

    await removeBookTag(bookId, tag.id);

    const { rows } = await db.query<{ touched: { table: string; id: string }[] }>(
      `SELECT touched FROM outbox WHERE endpoint = '/api/books/${bookId}/tags/${tag.id}' AND method = 'DELETE'`
    );
    // The statement's first bound param is bookId but its table is book_tag
    // (PK neither bookId nor tagId) -- without the explicit override the
    // derived pair pointed at a nonexistent row.
    expect(rows[0].touched).toEqual([{ table: "book", id: bookId }]);
  });
});
