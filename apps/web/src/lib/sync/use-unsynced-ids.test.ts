// Direct unit test against a real (in-memory) PGlite instance, same pattern
// as outbox.test.ts -- this hook is thin enough that testing it directly
// (rather than only indirectly through a consuming page) is worth the
// setup, since it's shared by BookCard, LoanRow, and BookDetail.
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";

vi.mock("../db/pglite.js", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const mirrorSchema = (await import("../db/mirror-schema.sql?raw")).default;
  const testDb = new PGlite();
  return { db: testDb, ready: testDb.exec(mirrorSchema) };
});

import { db, ready } from "../db/pglite.js";
import { enqueue, dismiss, retry } from "./outbox.js";
import { useUnsyncedIds } from "./use-unsynced-ids.js";

const HOUSEHOLD = "00000000-0000-0000-0000-00000000000a";
const EDITION = "00000000-0000-0000-0000-00000000000b";

async function seedBook(id: string) {
  await db.query(
    `INSERT INTO book (id, household_id, edition_id, ownership, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, 'owned', 'user-1', now(), now())`,
    [id, HOUSEHOLD, EDITION]
  );
}

beforeEach(async () => {
  await ready;
  await db.exec("DELETE FROM outbox");
  await db.exec("DELETE FROM book");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await db.close();
});

describe("useUnsyncedIds", () => {
  it("includes an id touched by a dismissed row, scoped to the requested table", async () => {
    const bookId = "00000000-0000-0000-0000-000000000040";
    await seedBook(bookId);
    const outboxId = await enqueue(`/api/books/${bookId}`, "PATCH", { do_not_lend: true }, {
      sql: `UPDATE book SET do_not_lend = $2 WHERE id = $1`,
      params: [bookId, true],
    });
    await dismiss(outboxId);

    const { result } = renderHook(() => useUnsyncedIds("book"));

    await waitFor(() => expect(result.current.has(bookId)).toBe(true));
  });

  it("does not include an id from a different table", async () => {
    const bookId = "00000000-0000-0000-0000-000000000041";
    await seedBook(bookId);
    const outboxId = await enqueue(`/api/books/${bookId}`, "PATCH", { do_not_lend: true }, {
      sql: `UPDATE book SET do_not_lend = $2 WHERE id = $1`,
      params: [bookId, true],
    });
    await dismiss(outboxId);

    const { result } = renderHook(() => useUnsyncedIds("loan"));

    // Give the hook's initial async query a chance to resolve before
    // asserting the negative.
    await waitFor(() => expect(result.current).toBeInstanceOf(Set));
    expect(result.current.has(bookId)).toBe(false);
  });

  it("clears once the row is retried and succeeds (outbox row deleted)", async () => {
    const bookId = "00000000-0000-0000-0000-000000000042";
    await seedBook(bookId);
    const outboxId = await enqueue(`/api/books/${bookId}`, "PATCH", { do_not_lend: true }, {
      sql: `UPDATE book SET do_not_lend = $2 WHERE id = $1`,
      params: [bookId, true],
    });
    await dismiss(outboxId);

    const { result } = renderHook(() => useUnsyncedIds("book"));
    await waitFor(() => expect(result.current.has(bookId)).toBe(true));

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    await act(async () => {
      await retry(outboxId);
    });

    await waitFor(() => expect(result.current.has(bookId)).toBe(false));
  });
});
