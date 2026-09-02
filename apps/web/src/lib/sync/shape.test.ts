import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import mirrorSchema from "../db/mirror-schema.sql?raw";

// shape.ts imports the real singleton mirror (`db`/`ready` from
// ../db/pglite.js), which is backed by `idb://` (IndexedDB) storage --
// browser-only, and not something jsdom's test environment provides. These
// tests exercise `applyChangeTo` against their own in-memory PGlite instance
// (see `db` below) and never touch the singleton, so it's mocked out here
// purely to avoid an unhandled IndexedDB-open rejection during import.
vi.mock("../db/pglite.js", () => ({
  db: undefined,
  ready: Promise.resolve(),
}));

import {
  applyChangeTo,
  bootstrapInto,
  getSynced,
  onSyncedChange,
  getSyncStale,
  onSyncStaleChange,
  STALE_FRESHNESS_TIMEOUT_MS,
  onMirrorChange,
  __resetSyncedForTests,
  __resetMirrorChangeForTests,
  __resetSyncStaleForTests,
  __markUpToDateForTests,
  __noteTableFreshForTests,
  __noteTableErroredForTests,
  __recomputeStaleForTests,
  __totalShapeCountForTests,
} from "./shape.js";

// In-memory PGlite (no dataDir), matching the pattern in
// apps/web/src/lib/db/mirror-schema.test.ts -- no browser idb:// filesystem
// needed for these tests.
const db = new PGlite();

beforeAll(async () => {
  await db.exec(mirrorSchema);
});

afterAll(async () => {
  await db.close();
});

function bookcase(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    household_id: "00000000-0000-0000-0000-00000000000a",
    name: "Living Room",
    created_by: "user-1",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    deleted_at: null,
    ...overrides,
  };
}

describe("applyChangeTo", () => {
  it("materializes a row on insert", async () => {
    const row = bookcase();
    await applyChangeTo(db, "bookcase", "insert", row);

    const { rows } = await db.query<{ name: string }>(`SELECT name FROM bookcase WHERE id = $1`, [row.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Living Room");
  });

  it("overwrites fields on an update with a newer updated_at", async () => {
    const row = bookcase({ name: "Renamed", updated_at: "2026-01-02T00:00:00.000Z" });
    await applyChangeTo(db, "bookcase", "update", row);

    const { rows } = await db.query<{ name: string }>(`SELECT name FROM bookcase WHERE id = $1`, [row.id]);
    expect(rows[0].name).toBe("Renamed");
  });

  it("does NOT overwrite when the update's updated_at is older than what's stored (last-write-wins)", async () => {
    const staleRow = bookcase({ name: "Stale Replay", updated_at: "2026-01-01T00:00:00.000Z" });
    await applyChangeTo(db, "bookcase", "update", staleRow);

    const { rows } = await db.query<{ name: string }>(
      `SELECT name FROM bookcase WHERE id = $1`,
      [staleRow.id]
    );
    // Still "Renamed" from the previous (newer) update -- the stale replay
    // must not regress it.
    expect(rows[0].name).toBe("Renamed");
  });

  it("removes the row on delete", async () => {
    const row = bookcase();
    await applyChangeTo(db, "bookcase", "delete", row);

    const { rows } = await db.query(`SELECT * FROM bookcase WHERE id = $1`, [row.id]);
    expect(rows).toHaveLength(0);
  });

  it("applies edition rows too (global catalog table, no household_id)", async () => {
    const edition = {
      id: "00000000-0000-0000-0000-000000000002",
      isbn: "9780000000000",
      title: "A Book",
      authors: "Someone",
      language: null,
      publisher: null,
      published_year: null,
      cover_url: null,
      series_name: null,
      series_number: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      deleted_at: null,
    };
    await applyChangeTo(db, "edition", "insert", edition);

    const { rows } = await db.query<{ title: string }>(`SELECT title FROM edition WHERE id = $1`, [edition.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("A Book");
  });
});

describe("bootstrapInto (Task 8 cold-start seed)", () => {
  const bootstrapDb = new PGlite();

  beforeAll(async () => {
    await bootstrapDb.exec(mirrorSchema);
  });

  afterAll(async () => {
    await bootstrapDb.close();
  });

  it("fetches /api/bootstrap and upserts every collection into its mirror table", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        bookcases: [bookcase({ id: "10000000-0000-0000-0000-000000000001" })],
        editions: [
          {
            id: "10000000-0000-0000-0000-000000000002",
            isbn: null,
            title: "Bootstrapped Book",
            authors: "Someone",
            language: null,
            publisher: null,
            published_year: null,
            cover_url: null,
            series_name: null,
            series_number: null,
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:00.000Z",
            deleted_at: null,
          },
        ],
        // shelves/books/reading_statuses/tags/contacts/loans intentionally
        // omitted from this fixture to exercise the "missing key" no-op path.
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await bootstrapInto(bootstrapDb, "household-1");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/bootstrap?householdId=household-1",
      expect.objectContaining({ credentials: "include" })
    );

    const { rows: bookcaseRows } = await bootstrapDb.query(
      `SELECT name FROM bookcase WHERE id = $1`,
      ["10000000-0000-0000-0000-000000000001"]
    );
    expect(bookcaseRows).toHaveLength(1);

    const { rows: editionRows } = await bootstrapDb.query<{ title: string }>(
      `SELECT title FROM edition WHERE id = $1`,
      ["10000000-0000-0000-0000-000000000002"]
    );
    expect(editionRows[0].title).toBe("Bootstrapped Book");

    vi.unstubAllGlobals();
  });

  it("throws on a non-2xx response (bootstrap(), not bootstrapInto(), is responsible for swallowing)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    await expect(bootstrapInto(bootstrapDb, "household-1")).rejects.toThrow(/status 500/);

    vi.unstubAllGlobals();
  });

  it("a bootstrap-seeded row never clobbers a newer row already in the mirror (same upsert guard as applyChangeTo)", async () => {
    const id = "10000000-0000-0000-0000-000000000003";
    // Simulate the shape stream having already landed a newer row for this
    // id (e.g. bootstrap's fetch was slow and a live update arrived first).
    await applyChangeTo(
      bootstrapDb,
      "bookcase",
      "insert",
      bookcase({ id, name: "Already Synced", updated_at: "2026-02-01T00:00:00.000Z" })
    );

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          bookcases: [bookcase({ id, name: "Stale Bootstrap Row", updated_at: "2026-01-01T00:00:00.000Z" })],
        }),
      })
    );

    await bootstrapInto(bootstrapDb, "household-1");

    const { rows } = await bootstrapDb.query<{ name: string }>(`SELECT name FROM bookcase WHERE id = $1`, [id]);
    expect(rows[0].name).toBe("Already Synced");

    vi.unstubAllGlobals();
  });
});

describe("synced signal", () => {
  it("stays false until every shape has reported up-to-date, then flips true and notifies once", () => {
    __resetSyncedForTests();
    expect(getSynced()).toBe(false);

    let notifications = 0;
    const unsubscribe = onSyncedChange(() => {
      notifications++;
    });

    const total = __totalShapeCountForTests();
    for (let i = 0; i < total - 1; i++) {
      __markUpToDateForTests(`table-${i}`);
      expect(getSynced()).toBe(false);
    }
    expect(notifications).toBe(0);

    __markUpToDateForTests(`table-${total - 1}`);
    expect(getSynced()).toBe(true);
    expect(notifications).toBe(1);

    // Reporting the same table (or any table) again after synced is already
    // true must not re-notify.
    __markUpToDateForTests(`table-${total - 1}`);
    expect(notifications).toBe(1);

    unsubscribe();
  });

  it("stops delivering to a listener after unsubscribe", () => {
    __resetSyncedForTests();
    let notified = false;
    const unsubscribe = onSyncedChange(() => {
      notified = true;
    });
    unsubscribe();

    for (let i = 0; i < __totalShapeCountForTests(); i++) {
      __markUpToDateForTests(`table-${i}`);
    }
    expect(getSynced()).toBe(true);
    expect(notified).toBe(false);
  });
});

// Issue #18: the cold-start `stalled` signal only arms inside startSync()'s
// one-shot timer, so an Electric outage that happens AFTER the app already
// reached `synced` had no signal at all -- reads silently served a stale
// mirror, writes kept queueing/retrying, with nothing telling the user.
//
// Deliberately NOT driven by ShapeStream's error callback alone (see
// shape.ts's comment on this section for why: the client's own fetch-layer
// retry, maxRetries: Infinity, means a real outage mostly never reaches an
// error callback at all). These tests exercise the freshness-watchdog path
// (a table that stops confirming up-to-date, full stop) as the primary
// mechanism, plus the explicit-error path as a faster secondary signal.
describe("mid-session stale signal (issue #18)", () => {
  afterEach(() => {
    __resetSyncedForTests();
    __resetSyncStaleForTests();
    vi.useRealTimers();
  });

  it("stays false for a table error that happens before the cold start ever synced (already covered by `stalled`)", () => {
    __resetSyncedForTests();
    __resetSyncStaleForTests();
    expect(getSynced()).toBe(false);

    __noteTableErroredForTests("book");

    expect(getSyncStale()).toBe(false);
  });

  it("flips true on a table error AFTER the initial synced flip, and notifies", () => {
    for (let i = 0; i < __totalShapeCountForTests(); i++) {
      __markUpToDateForTests(`table-${i}`);
      __noteTableFreshForTests(`table-${i}`);
    }
    expect(getSynced()).toBe(true);

    let notifications = 0;
    const unsubscribe = onSyncStaleChange(() => notifications++);

    __noteTableErroredForTests("book");

    expect(getSyncStale()).toBe(true);
    expect(notifications).toBe(1);
    unsubscribe();
  });

  it("clears once the errored table freshens again (reaches up-to-date again)", () => {
    for (let i = 0; i < __totalShapeCountForTests(); i++) {
      __markUpToDateForTests(`table-${i}`);
      __noteTableFreshForTests(`table-${i}`);
    }
    __noteTableErroredForTests("book");
    expect(getSyncStale()).toBe(true);

    __noteTableFreshForTests("book");

    expect(getSyncStale()).toBe(false);
  });

  it("stays true while any one of several errored tables hasn't freshened yet", () => {
    for (let i = 0; i < __totalShapeCountForTests(); i++) {
      __markUpToDateForTests(`table-${i}`);
      __noteTableFreshForTests(`table-${i}`);
    }
    __noteTableErroredForTests("book");
    __noteTableErroredForTests("loan");
    expect(getSyncStale()).toBe(true);

    __noteTableFreshForTests("book");
    expect(getSyncStale()).toBe(true); // "loan" still errored

    __noteTableFreshForTests("loan");
    expect(getSyncStale()).toBe(false);
  });

  it("flips true once a table has gone quiet for longer than STALE_FRESHNESS_TIMEOUT_MS, with no error ever having fired", () => {
    vi.useFakeTimers();
    for (let i = 0; i < __totalShapeCountForTests(); i++) {
      __markUpToDateForTests(`table-${i}`);
      __noteTableFreshForTests(`table-${i}`);
    }
    expect(getSyncStale()).toBe(false);

    vi.advanceTimersByTime(STALE_FRESHNESS_TIMEOUT_MS + 1);
    __recomputeStaleForTests();

    expect(getSyncStale()).toBe(true);
  });

  it("clears the timeout-based stale flag once the quiet table freshens again", () => {
    vi.useFakeTimers();
    for (let i = 0; i < __totalShapeCountForTests(); i++) {
      __markUpToDateForTests(`table-${i}`);
      __noteTableFreshForTests(`table-${i}`);
    }
    vi.advanceTimersByTime(STALE_FRESHNESS_TIMEOUT_MS + 1);
    __recomputeStaleForTests();
    expect(getSyncStale()).toBe(true);

    __noteTableFreshForTests("table-0");
    // Every table was frozen at the same tick above, so freshening only
    // one of them isn't enough -- freshen them all, matching what actually
    // happens once the shape stream catches back up (every subscription
    // gets a fresh up-to-date once reconnected).
    for (let i = 1; i < __totalShapeCountForTests(); i++) {
      __noteTableFreshForTests(`table-${i}`);
    }

    expect(getSyncStale()).toBe(false);
  });
});

// Important finding (final whole-branch review): no screen re-read the
// mirror when a remote change streamed in underneath it. onMirrorChange
// gives screens a way to know "something changed, maybe re-fetch".
describe("onMirrorChange", () => {
  afterEach(() => {
    __resetMirrorChangeForTests();
  });

  it("notifies subscribers (debounced) after applyChangeTo applies an insert", async () => {
    let notifications = 0;
    const unsubscribe = onMirrorChange(() => {
      notifications++;
    });

    await applyChangeTo(db, "bookcase", "insert", bookcase());
    expect(notifications).toBe(0); // debounced, not synchronous

    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(notifications).toBe(1);

    unsubscribe();
  });

  it("notifies after a delete too", async () => {
    const row = bookcase({ id: "00000000-0000-0000-0000-000000000099" });
    await applyChangeTo(db, "bookcase", "insert", row);
    await new Promise((resolve) => setTimeout(resolve, 250));

    let notified = false;
    const unsubscribe = onMirrorChange(() => {
      notified = true;
    });
    await applyChangeTo(db, "bookcase", "delete", row);
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(notified).toBe(true);
    unsubscribe();
  });

  it("coalesces a burst of changes into a single notification", async () => {
    let notifications = 0;
    const unsubscribe = onMirrorChange(() => {
      notifications++;
    });

    for (let i = 0; i < 5; i++) {
      await applyChangeTo(
        db,
        "bookcase",
        "insert",
        bookcase({ id: `00000000-0000-0000-0000-00000000020${i}` })
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(notifications).toBe(1);
    unsubscribe();
  });

  it("stops delivering to a listener after unsubscribe", async () => {
    let notified = false;
    const unsubscribe = onMirrorChange(() => {
      notified = true;
    });
    unsubscribe();

    await applyChangeTo(db, "bookcase", "insert", bookcase({ id: "00000000-0000-0000-0000-000000000098" }));
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(notified).toBe(false);
  });
});
