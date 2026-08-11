import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
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
  getSynced,
  onSyncedChange,
  __resetSyncedForTests,
  __markUpToDateForTests,
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
