import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";

// In-memory PGlite (no dataDir -> no idb://), matching the convention in
// mirror-schema.test.ts / shape.test.ts. Unlike shape.test.ts (which mocks
// ../db/pglite.js to `undefined` because applyChangeTo takes its db
// explicitly), outbox.ts's public API (enqueue/flush/retry) always goes
// through the module-level `db`/`ready` singleton, so the mock below wires
// a *working* in-memory PGlite in as that singleton instead.
//
// The factory does its own dynamic imports and constructs its own PGlite
// instance internally (rather than referencing an outer top-level const)
// because `vi.mock` factories are hoisted above normal imports/statements --
// a plain top-level `const testDb` would still be in its temporal dead zone
// when the factory runs. Tests below get the same instance back via the
// `db`/`ready` re-import right after this call.
vi.mock("../db/pglite.js", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const mirrorSchema = (await import("../db/mirror-schema.sql?raw")).default;
  const testDb = new PGlite();
  return { db: testDb, ready: testDb.exec(mirrorSchema) };
});

// sonner's toast is mocked so dead-letter tests can assert on the call
// without a real Toaster mounted (same pattern as Add.test.tsx).
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

import { toast } from "sonner";
import { db, ready } from "../db/pglite.js";
import {
  enqueue,
  flush,
  retry,
  dismiss,
  listDeadLettered,
  listDismissedTouchedEntities,
  countPending,
  countDead,
  onOutboxChange,
  describeOperation,
  startOutboxWorker,
  __resetOutboxWorkerForTests,
  __resetAuthToastForTests,
  BACKOFF_SCHEDULE_MS,
  AUTH_RETRY_DELAY_MS,
} from "./outbox.js";

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
  vi.clearAllMocks();
});

afterEach(() => {
  __resetOutboxWorkerForTests();
  __resetAuthToastForTests();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

afterAll(async () => {
  await db.close();
});

describe("enqueue", () => {
  it("inserts an outbox row and applies the optimistic local write in one transaction", async () => {
    const bookId = "00000000-0000-0000-0000-000000000001";
    await seedBook(bookId);

    const id = await enqueue(`/api/books/${bookId}`, "PATCH", { do_not_lend: true }, {
      sql: `UPDATE book SET do_not_lend = $2 WHERE id = $1`,
      params: [bookId, true],
    });

    const { rows: outboxRows } = await db.query(`SELECT * FROM outbox WHERE id = $1`, [id]);
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]).toMatchObject({
      endpoint: `/api/books/${bookId}`,
      method: "PATCH",
      status: "pending",
      attempts: 0,
    });

    const { rows: bookRows } = await db.query<{ do_not_lend: boolean }>(
      `SELECT do_not_lend FROM book WHERE id = $1`,
      [bookId]
    );
    expect(bookRows[0].do_not_lend).toBe(true);
  });

  it("works without an optimistic write (just the outbox row)", async () => {
    const id = await enqueue("/api/contacts", "POST", { name: "Alex" });
    const { rows } = await db.query<{ body: unknown }>(`SELECT body FROM outbox WHERE id = $1`, [id]);
    expect(rows[0].body).toEqual({ name: "Alex" });
  });

  it("accepts an array of optimistic writes, applying all of them in order in the same transaction as the outbox insert (fix round: repo/books.ts's createBook needs an edition INSERT before the book INSERT that references it)", async () => {
    const bookId = "00000000-0000-0000-0000-000000000002";
    const editionId = "00000000-0000-0000-0000-000000000003";

    await enqueue(
      "/api/books",
      "POST",
      { id: bookId, edition: { id: editionId, title: "Dune" } },
      [
        {
          sql: `INSERT INTO edition (id, title, created_at, updated_at) VALUES ($1, $2, now(), now())`,
          params: [editionId, "Dune"],
        },
        {
          sql: `INSERT INTO book (id, household_id, edition_id, ownership, created_by, created_at, updated_at)
                VALUES ($1, $2, $3, 'owned', 'user-1', now(), now())`,
          params: [bookId, HOUSEHOLD, editionId],
        },
      ]
    );

    const { rows: editionRows } = await db.query<{ id: string; title: string }>(
      `SELECT id, title FROM edition WHERE id = $1`,
      [editionId]
    );
    expect(editionRows).toHaveLength(1);
    expect(editionRows[0]).toMatchObject({ title: "Dune" });

    const { rows: bookRows } = await db.query<{ id: string; edition_id: string }>(
      `SELECT id, edition_id FROM book WHERE id = $1`,
      [bookId]
    );
    expect(bookRows).toHaveLength(1);
    expect(bookRows[0].edition_id).toBe(editionId);
  });
});

describe("flush", () => {
  it("sends a pending row via fetch with credentials included, and deletes it on 2xx", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const id = await enqueue("/api/contacts", "POST", { name: "Alex" });
    await flush();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/contacts",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({ name: "Alex" }),
      })
    );

    const { rows } = await db.query(`SELECT * FROM outbox WHERE id = $1`, [id]);
    expect(rows).toHaveLength(0);
  });

  it("increments attempts and schedules a backoff retry on a non-2xx response, without deleting the row", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    vi.stubGlobal("fetch", fetchMock);

    const id = await enqueue("/api/loans", "POST", { book_id: "b1" });
    const before = Date.now();
    await flush();

    const { rows } = await db.query<{ attempts: number; status: string; next_retry_at: string }>(
      `SELECT attempts, status, next_retry_at FROM outbox WHERE id = $1`,
      [id]
    );
    expect(rows[0].attempts).toBe(1);
    expect(rows[0].status).toBe("pending");
    expect(new Date(rows[0].next_retry_at).getTime()).toBe(before + BACKOFF_SCHEDULE_MS[0]);

    // Flushing again before the backoff window elapses must not re-send.
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Advancing past the backoff window makes it due again.
    await vi.advanceTimersByTimeAsync(BACKOFF_SCHEDULE_MS[0] + 1);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("treats a network error (fetch rejection) the same as a non-2xx response", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    const id = await enqueue("/api/loans", "POST", { book_id: "b1" });
    await flush();

    const { rows } = await db.query<{ attempts: number; status: string }>(
      `SELECT attempts, status FROM outbox WHERE id = $1`,
      [id]
    );
    expect(rows[0].attempts).toBe(1);
    expect(rows[0].status).toBe("pending");
  });

  it("never picks up dead or dismissed rows", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await db.query(
      `INSERT INTO outbox (id, endpoint, method, status) VALUES
       ('00000000-0000-0000-0000-000000000010', '/api/tags', 'POST', 'dead'),
       ('00000000-0000-0000-0000-000000000011', '/api/tags', 'POST', 'dismissed')`
    );

    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("dead-lettering", () => {
  it("marks the row dead after exhausting the backoff schedule and fires a toast.error with a Retry action", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    vi.stubGlobal("fetch", fetchMock);

    const id = await enqueue("/api/loans/loan-1", "PATCH", { returned_date: "2026-01-01" });

    await flush(); // attempt 1
    for (let i = 0; i < BACKOFF_SCHEDULE_MS.length - 1; i++) {
      await vi.advanceTimersByTimeAsync(BACKOFF_SCHEDULE_MS[i] + 1);
      await flush(); // attempts 2..N
    }

    const { rows } = await db.query<{ status: string; attempts: number }>(
      `SELECT status, attempts FROM outbox WHERE id = $1`,
      [id]
    );
    expect(rows[0].status).toBe("dead");
    expect(rows[0].attempts).toBe(BACKOFF_SCHEDULE_MS.length);

    expect(toast.error).toHaveBeenCalledTimes(1);
    const [message, options] = vi.mocked(toast.error).mock.calls[0];
    expect(message).toBe("Couldn't save: mark loan returned");
    expect(options?.action).toMatchObject({ label: "Retry" });

    // A dead row is no longer picked up by flush().
    fetchMock.mockClear();
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("re-queues via the toast's Retry action: resets attempts/status and flushes immediately", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    vi.stubGlobal("fetch", fetchMock);

    const id = await enqueue("/api/contacts", "POST", { name: "Alex" });
    await flush();
    for (let i = 0; i < BACKOFF_SCHEDULE_MS.length - 1; i++) {
      await vi.advanceTimersByTimeAsync(BACKOFF_SCHEDULE_MS[i] + 1);
      await flush();
    }
    const { rows: deadRows } = await db.query<{ status: string }>(`SELECT status FROM outbox WHERE id = $1`, [id]);
    expect(deadRows[0].status).toBe("dead");

    const [, options] = vi.mocked(toast.error).mock.calls[0];
    fetchMock.mockClear();
    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    // Simulate clicking the Retry button on the toast.
    const action = options?.action as { label: string; onClick: (e: unknown) => void } | undefined;
    action?.onClick(new MouseEvent("click"));
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalled();
    const { rows } = await db.query(`SELECT * FROM outbox WHERE id = $1`, [id]);
    expect(rows).toHaveLength(0); // the retried fetch succeeded, so the row was deleted
  });

  it("retry() directly resets attempts/status/next_retry_at and re-flushes", async () => {
    await db.query(
      `INSERT INTO outbox (id, endpoint, method, body, attempts, status, next_retry_at)
       VALUES ('00000000-0000-0000-0000-000000000020', '/api/tags', 'POST', '{"name":"x"}'::jsonb, 5, 'dead', NULL)`
    );
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    await retry("00000000-0000-0000-0000-000000000020");

    expect(fetchMock).toHaveBeenCalled();
    const { rows } = await db.query(`SELECT * FROM outbox WHERE id = $1`, [
      "00000000-0000-0000-0000-000000000020",
    ]);
    expect(rows).toHaveLength(0);
  });
});

describe("flush failure classification (review Important 1+2)", () => {
  it("passes an AbortSignal timeout on every replayed request", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchMock = vi.fn().mockImplementation((_endpoint: string, init?: RequestInit) => {
      capturedInit = init;
      return Promise.resolve({ ok: true, status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await enqueue("/api/contacts", "POST", { name: "Alex" });
    await flush();

    expect(capturedInit?.signal).toBeInstanceOf(AbortSignal);
  });

  it("treats a fetch abort/timeout like a network failure: retry with backoff, not dead-letter", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValue(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    vi.stubGlobal("fetch", fetchMock);

    const id = await enqueue("/api/loans", "POST", { book_id: "b1" });
    await flush();

    const { rows } = await db.query<{ attempts: number; status: string; permanent: boolean }>(
      `SELECT attempts, status, permanent FROM outbox WHERE id = $1`,
      [id]
    );
    expect(rows[0].attempts).toBe(1);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].permanent).toBe(false);
  });

  it("dead-letters a 4xx immediately on the first failure, marked permanent, with a no-Retry toast", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 400 });
    vi.stubGlobal("fetch", fetchMock);

    const id = await enqueue("/api/loans/loan-1", "PATCH", { returned_date: "2026-01-01" });
    await flush();

    const { rows } = await db.query<{ attempts: number; status: string; permanent: boolean; next_retry_at: string | null }>(
      `SELECT attempts, status, permanent, next_retry_at FROM outbox WHERE id = $1`,
      [id]
    );
    expect(rows[0].status).toBe("dead");
    expect(rows[0].attempts).toBe(1);
    expect(rows[0].permanent).toBe(true);
    expect(rows[0].next_retry_at).toBeNull();

    expect(toast.error).toHaveBeenCalledTimes(1);
    const [message, options] = vi.mocked(toast.error).mock.calls[0];
    expect(message).toBe("Couldn't save: mark loan returned — the server rejected this change");
    expect(options?.action).toBeUndefined();

    // Dead rows are never picked up again.
    fetchMock.mockClear();
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps 408 and 429 retryable (transient-by-definition 4xx statuses)", async () => {
    for (const status of [408, 429]) {
      await db.exec("DELETE FROM outbox");
      vi.clearAllMocks();
      const fetchMock = vi.fn().mockResolvedValue({ ok: false, status });
      vi.stubGlobal("fetch", fetchMock);

      const id = await enqueue("/api/loans", "POST", { book_id: "b1" });
      await flush();

      const { rows } = await db.query<{ attempts: number; status: string; permanent: boolean }>(
        `SELECT attempts, status, permanent FROM outbox WHERE id = $1`,
        [id]
      );
      expect(rows[0].attempts).toBe(1);
      expect(rows[0].status).toBe("pending");
      expect(rows[0].permanent).toBe(false);
    }
  });

  it("pauses on 401 without consuming attempts, toasts once per episode, and resumes after the auth window", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    vi.stubGlobal("fetch", fetchMock);

    const id = await enqueue("/api/contacts", "POST", { name: "Alex" });
    const before = Date.now();
    await flush();

    // Not an attempt, not a dead letter: the row waits out the auth window.
    const { rows } = await db.query<{ attempts: number; status: string; next_retry_at: string }>(
      `SELECT attempts, status, next_retry_at FROM outbox WHERE id = $1`,
      [id]
    );
    expect(rows[0].attempts).toBe(0);
    expect(rows[0].status).toBe("pending");
    expect(new Date(rows[0].next_retry_at).getTime()).toBe(before + AUTH_RETRY_DELAY_MS);

    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.error).mock.calls[0][0]).toContain("sign in again");

    // Not due again until the auth window elapses; still-toastless while paused.
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(AUTH_RETRY_DELAY_MS + 1);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(toast.error).toHaveBeenCalledTimes(1); // same episode, no re-toast
  });

  it("a 401 stops the flush pass: later due rows are not sent behind it", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    vi.stubGlobal("fetch", fetchMock);

    // Seeded directly (not via enqueue) so both rows exist before the one
    // pass under test runs -- enqueue() fires its own background flush,
    // which would process the first row in an earlier, separate pass.
    await db.query(
      `INSERT INTO outbox (id, endpoint, method, status) VALUES
       ('00000000-0000-0000-0000-000000000040', '/api/contacts', 'POST', 'pending'),
       ('00000000-0000-0000-0000-000000000041', '/api/tags', 'POST', 'pending')`
    );
    await flush();

    // Whichever row went first 401'd and broke the pass; the other must
    // not have been attempted.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a successful send resets the 401 episode, so a later expiry toasts again", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    vi.stubGlobal("fetch", fetchMock);

    // Episode 1.
    await enqueue("/api/contacts", "POST", { name: "Alex" });
    await flush();
    expect(toast.error).toHaveBeenCalledTimes(1);

    // The session recovers and the paused row goes through.
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    await vi.advanceTimersByTimeAsync(AUTH_RETRY_DELAY_MS + 1);
    await flush();
    expect(await countPending()).toBe(0);

    // Episode 2 warns again.
    fetchMock.mockResolvedValue({ ok: false, status: 401 });
    await enqueue("/api/tags", "POST", { name: "sci-fi" });
    await flush();
    expect(toast.error).toHaveBeenCalledTimes(2);
  });
});

describe("describeOperation", () => {
  it("names a book creation by title", () => {
    expect(describeOperation("/api/books", "POST", { edition: { title: "Dune" } })).toBe('add "Dune"');
  });

  it("falls back to a generic description for POST /api/books without a title", () => {
    expect(describeOperation("/api/books", "POST", {})).toBe("add a book");
  });

  it("names a contact creation by name", () => {
    expect(describeOperation("/api/contacts", "POST", { name: "Alex" })).toBe("add contact Alex");
  });

  it("returns undefined for an unrecognized endpoint (generic toast fallback)", () => {
    expect(describeOperation("/api/unknown-thing", "POST", {})).toBeUndefined();
  });
});

describe("dismiss / listDeadLettered / counts (Task 7)", () => {
  async function deadLetterOne(endpoint: string, method: string, body?: unknown) {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    vi.stubGlobal("fetch", fetchMock);
    const id = await enqueue(endpoint, method, body);
    await flush();
    for (let i = 0; i < BACKOFF_SCHEDULE_MS.length - 1; i++) {
      await vi.advanceTimersByTimeAsync(BACKOFF_SCHEDULE_MS[i] + 1);
      await flush();
    }
    vi.useRealTimers();
    return id;
  }

  it("countPending counts only status = 'pending' rows, not dismissed ones", async () => {
    await enqueue("/api/contacts", "POST", { name: "Alex" });
    const dismissedId = await enqueue("/api/tags", "POST", { name: "history" });
    await dismiss(dismissedId);

    expect(await countPending()).toBe(1);
  });

  it("countDead counts status = 'dead' rows", async () => {
    expect(await countDead()).toBe(0);
    await deadLetterOne("/api/loans/loan-1", "PATCH", { returned_date: "2026-01-01" });
    expect(await countDead()).toBe(1);
  });

  it("listDeadLettered returns dead rows (with enough fields for describeOperation) but excludes dismissed ones", async () => {
    const deadId = await deadLetterOne("/api/loans/loan-1", "PATCH", { returned_date: "2026-01-01" });
    const dismissedId = await enqueue("/api/tags", "POST", { name: "history" });
    await dismiss(dismissedId);

    const rows = await listDeadLettered();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(deadId);
    expect(describeOperation(rows[0].endpoint, rows[0].method, rows[0].body)).toBe("mark loan returned");
  });

  it("dismiss sets status to 'dismissed', which flush() never picks up again", async () => {
    // Deliberately no successful-fetch stub in place yet when enqueue()
    // runs: since enqueue() now triggers a background flush of its own
    // (Critical 1 fix), stubbing an immediately-ok fetch *before* enqueue
    // would race dismiss() below -- the auto-flush could delete the row
    // out from under this test before dismiss() ever runs. The unstubbed
    // `fetch` here fails (no fetch implementation registered), which
    // exercises the same "leave it pending" path without that race; the
    // real assertions (dismiss -> status, then flush() never re-sends) only
    // care about behavior after the success stub is installed below.
    const id = await enqueue("/api/tags", "POST", { name: "history" });

    await dismiss(id);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    const { rows } = await db.query<{ status: string }>(`SELECT status FROM outbox WHERE id = $1`, [id]);
    expect(rows[0].status).toBe("dismissed");

    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retry() flips a dead row's status back to 'pending' (verified against real PGlite, not a mock)", async () => {
    const id = await deadLetterOne("/api/tags", "POST", { name: "sci-fi" });
    const { rows: before } = await db.query<{ status: string }>(`SELECT status FROM outbox WHERE id = $1`, [id]);
    expect(before[0].status).toBe("dead");

    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    vi.stubGlobal("fetch", fetchMock);
    await retry(id);

    // retry() also flushes immediately; with a still-failing fetch the row
    // is re-armed as 'pending' (not re-dead-lettered, since attempts reset
    // to 0 then increments to 1 on this single failed attempt).
    const { rows: after } = await db.query<{ status: string; attempts: number }>(
      `SELECT status, attempts FROM outbox WHERE id = $1`,
      [id]
    );
    expect(after[0].status).toBe("pending");
    expect(after[0].attempts).toBe(1);
  });

  it("onOutboxChange fires on enqueue, dead-lettering, retry, and dismiss", async () => {
    const listener = vi.fn();
    const unsubscribe = onOutboxChange(listener);

    await enqueue("/api/tags", "POST", { name: "history" });
    expect(listener).toHaveBeenCalledTimes(1);

    const deadId = await deadLetterOne("/api/loans/loan-1", "PATCH", { returned_date: "2026-01-01" });
    expect(listener.mock.calls.length).toBeGreaterThan(1);

    listener.mockClear();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    await retry(deadId);
    expect(listener).toHaveBeenCalled();

    listener.mockClear();
    const id2 = await enqueue("/api/tags", "POST", { name: "romance" });
    listener.mockClear();
    await dismiss(id2);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    listener.mockClear();
    await enqueue("/api/tags", "POST", { name: "poetry" });
    expect(listener).not.toHaveBeenCalled();
  });

  // --- touched-entity tracking (Important 6, final review fix round) -----

  it("enqueue records which mirror row(s) an optimistic write touched", async () => {
    const bookId = "00000000-0000-0000-0000-000000000030";
    await seedBook(bookId);

    const id = await enqueue(`/api/books/${bookId}`, "PATCH", { do_not_lend: true }, {
      sql: `UPDATE book SET do_not_lend = $2 WHERE id = $1`,
      params: [bookId, true],
    });

    const { rows } = await db.query<{ touched: unknown }>(`SELECT touched FROM outbox WHERE id = $1`, [id]);
    expect(rows[0].touched).toEqual([{ table: "book", id: bookId }]);
  });

  it("enqueue records every touched entity when multiple optimistic statements are given", async () => {
    const bookId = "00000000-0000-0000-0000-000000000031";
    const editionId = "00000000-0000-0000-0000-000000000032";

    const id = await enqueue(
      "/api/books",
      "POST",
      { id: bookId, edition: { id: editionId, title: "Dune" } },
      [
        {
          sql: `INSERT INTO edition (id, title, created_at, updated_at) VALUES ($1, $2, now(), now())`,
          params: [editionId, "Dune"],
        },
        {
          sql: `INSERT INTO book (id, household_id, edition_id, ownership, created_by, created_at, updated_at)
                VALUES ($1, $2, $3, 'owned', 'user-1', now(), now())`,
          params: [bookId, HOUSEHOLD, editionId],
        },
      ]
    );

    const { rows } = await db.query<{ touched: unknown }>(`SELECT touched FROM outbox WHERE id = $1`, [id]);
    expect(rows[0].touched).toEqual([
      { table: "edition", id: editionId },
      { table: "book", id: bookId },
    ]);
  });

  it("enqueue without an optimistic write records no touched entities", async () => {
    const id = await enqueue("/api/contacts", "POST", { name: "Alex" });
    const { rows } = await db.query<{ touched: unknown }>(`SELECT touched FROM outbox WHERE id = $1`, [id]);
    expect(rows[0].touched).toBeNull();
  });

  it("listDismissedTouchedEntities returns touched entities only for dismissed rows", async () => {
    const bookId = "00000000-0000-0000-0000-000000000033";
    await seedBook(bookId);

    const dismissedId = await enqueue(`/api/books/${bookId}`, "PATCH", { do_not_lend: true }, {
      sql: `UPDATE book SET do_not_lend = $2 WHERE id = $1`,
      params: [bookId, true],
    });
    // Not dismissed -- must not show up.
    await enqueue("/api/contacts", "POST", { name: "Alex" }, {
      sql: `INSERT INTO contact (id, household_id, name, created_by, created_at, updated_at) VALUES ($1, $2, $3, $4, now(), now())`,
      params: ["00000000-0000-0000-0000-000000000034", HOUSEHOLD, "Alex", "user-1"],
    });

    await dismiss(dismissedId);

    const entities = await listDismissedTouchedEntities();
    expect(entities).toEqual([{ table: "book", id: bookId }]);
  });
});

describe("background worker", () => {
  it("flushes when the browser fires the online event", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    await enqueue("/api/tags", "POST", { name: "sci-fi" });

    startOutboxWorker();
    window.dispatchEvent(new Event("online"));
    // `flush()` chains several real microtask hops (await ready, await
    // db.query, await fetch, await db.query again) that a couple of bare
    // `await Promise.resolve()`s don't fully drain -- a short real timer
    // tick does.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(fetchMock).toHaveBeenCalled();
  });

  it("flushes on the periodic timer", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    await enqueue("/api/tags", "POST", { name: "history" });

    startOutboxWorker();
    await vi.advanceTimersByTimeAsync(5000);

    expect(fetchMock).toHaveBeenCalled();
  });

  it("is idempotent: calling it twice doesn't double-register the timer/listener", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    await enqueue("/api/tags", "POST", { name: "history" });

    startOutboxWorker();
    startOutboxWorker();
    await vi.advanceTimersByTimeAsync(5000);

    // If the interval had been registered twice, flush (which is itself
    // reentrancy-guarded) would still only actually hit fetch once per due
    // row per pass -- but two intervals firing would show up as more than
    // one flush pass's worth of *ordering*. The reentrancy guard makes a
    // strict call-count assertion unreliable here, so this test instead
    // guards against the interval itself being registered twice by
    // checking flush was not somehow invoked with overlapping passes
    // (fetchMock is called exactly once for the single enqueued row).
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
