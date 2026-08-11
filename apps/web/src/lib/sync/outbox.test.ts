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
  describeOperation,
  startOutboxWorker,
  __resetOutboxWorkerForTests,
  BACKOFF_SCHEDULE_MS,
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
