// apps/web/src/lib/repo/import.test.ts
//
// Repo-layer test against a real (in-memory) PGlite instance, same
// approach as shelves.test.ts / loans.test.ts: exercise the real SQL the
// mirror runs, not a mocked query layer.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../db/pglite.js", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const mirrorSchema = (await import("../db/mirror-schema.sql?raw")).default;
  const testDb = new PGlite();
  return { db: testDb, ready: testDb.exec(mirrorSchema) };
});

import { db, ready } from "../db/pglite.js";
import { importGoodreadsCsv, previewGoodreadsCsv } from "./import.js";

const HOUSEHOLD = "00000000-0000-0000-0000-00000000000a";
const USER = "user-1";

const HEADER = "Title,Author,ISBN,ISBN13,My Rating,Date Read,Exclusive Shelf";
function csv(...dataRows: string[]): string {
  return [HEADER, ...dataRows].join("\n");
}

beforeEach(async () => {
  await ready;
  await db.exec("DELETE FROM outbox");
  await db.exec("DELETE FROM reading_status");
  await db.exec("DELETE FROM book");
  await db.exec("DELETE FROM edition");
  // enqueue() fires a background flush on every call; stub fetch to fail
  // fast so these tests never make a real network call.
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("no network in tests")));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("importGoodreadsCsv", () => {
  it("creates an edition + book + reading_status row per valid CSV row", async () => {
    const result = await importGoodreadsCsv(
      csv(
        'Dune,Frank Herbert,,="9780441172719",5,2023/05/12,read',
        '1984,George Orwell,,,0,,to-read'
      ),
      { householdId: HOUSEHOLD, userId: USER }
    );

    expect(result).toEqual({ totalRows: 2, imported: 2, failures: [], cancelled: false });

    const { rows: books } = await db.query<{ ownership: string; title: string; isbn: string | null }>(
      `SELECT b.ownership, e.title, e.isbn FROM book b JOIN edition e ON e.id = b.edition_id
       WHERE b.household_id = $1 ORDER BY e.title`,
      [HOUSEHOLD]
    );
    expect(books).toEqual([
      { ownership: "wishlist", title: "1984", isbn: null },
      { ownership: "owned", title: "Dune", isbn: "9780441172719" },
    ]);

    const { rows: statuses } = await db.query<{ status: string; rating: number | null; finished_at: string | null }>(
      `SELECT rs.status, rs.rating, rs.finished_at::text FROM reading_status rs
       JOIN book b ON b.id = rs.book_id JOIN edition e ON e.id = b.edition_id
       WHERE rs.household_id = $1 ORDER BY e.title`,
      [HOUSEHOLD]
    );
    expect(statuses).toEqual([
      { status: "want_to_read", rating: null, finished_at: null },
      { status: "finished", rating: 5, finished_at: "2023-05-12" },
    ]);
  });

  it("reports a mapper-level error (e.g. missing Title) without creating a book, and continues with later rows", async () => {
    const result = await importGoodreadsCsv(
      csv(',Frank Herbert,,,0,,to-read', 'Dune,Frank Herbert,,,0,,to-read'),
      { householdId: HOUSEHOLD, userId: USER }
    );

    expect(result.totalRows).toBe(2);
    expect(result.imported).toBe(1);
    expect(result.failures).toEqual([{ rowNumber: 2, title: "", message: "missing Title" }]);

    const { rows: books } = await db.query("SELECT id FROM book WHERE household_id = $1", [HOUSEHOLD]);
    expect(books).toHaveLength(1);
  });

  it("reports onProgress as each row completes", async () => {
    const seen: Array<[number, number]> = [];
    await importGoodreadsCsv(csv('Dune,Frank Herbert,,,0,,to-read', '1984,George Orwell,,,0,,to-read'), {
      householdId: HOUSEHOLD,
      userId: USER,
      onProgress: (done, total) => seen.push([done, total]),
    });
    expect(seen).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });
});

describe("duplicate protection", () => {
  it("skips rows whose book already exists in the household (by ISBN or title+author)", async () => {
    // First import creates both books.
    const first = await importGoodreadsCsv(
      csv('Dune,Frank Herbert,,="9780441172719",5,,read', '1984,George Orwell,,,0,,to-read'),
      { householdId: HOUSEHOLD, userId: USER }
    );
    expect(first.imported).toBe(2);

    // Re-importing the same CSV imports nothing; both rows are skipped.
    const second = await importGoodreadsCsv(
      csv('Dune,Frank Herbert,,="9780441172719",5,,read', '1984,George Orwell,,,0,,to-read'),
      { householdId: HOUSEHOLD, userId: USER }
    );
    expect(second.imported).toBe(0);
    expect(second.failures).toEqual([
      { rowNumber: 2, title: "Dune", message: "Already in your library — skipped" },
      { rowNumber: 3, title: "1984", message: "Already in your library — skipped" },
    ]);

    const { rows: books } = await db.query("SELECT id FROM book WHERE household_id = $1", [HOUSEHOLD]);
    expect(books).toHaveLength(2);
  });

  it("skips a duplicate row within the same file", async () => {
    const result = await importGoodreadsCsv(
      csv('Dune,Frank Herbert,,,0,,to-read', 'Dune,Frank Herbert,,,0,,to-read'),
      { householdId: HOUSEHOLD, userId: USER }
    );
    expect(result.imported).toBe(1);
    expect(result.failures).toEqual([
      { rowNumber: 3, title: "Dune", message: "Already in your library — skipped" },
    ]);
  });

  it("matches title+author case-insensitively when the export has no ISBN", async () => {
    await importGoodreadsCsv(csv('Dune,Frank Herbert,,,0,,to-read'), { householdId: HOUSEHOLD, userId: USER });
    const result = await importGoodreadsCsv(csv('dune,frank herbert,,,0,,read'), {
      householdId: HOUSEHOLD,
      userId: USER,
    });
    expect(result.imported).toBe(0);
    expect(result.failures).toHaveLength(1);
  });
});

describe("cancellation", () => {
  it("stops importing when shouldCancel returns true and reports cancelled", async () => {
    let calls = 0;
    const result = await importGoodreadsCsv(
      csv('Dune,Frank Herbert,,,0,,to-read', '1984,George Orwell,,,0,,to-read', 'Emma,Jane Austen,,,0,,to-read'),
      {
        householdId: HOUSEHOLD,
        userId: USER,
        // Cancel after the first row has been checked.
        shouldCancel: () => calls++ > 0,
      }
    );
    expect(result.cancelled).toBe(true);
    expect(result.imported).toBe(1);

    const { rows: books } = await db.query("SELECT id FROM book WHERE household_id = $1", [HOUSEHOLD]);
    expect(books).toHaveLength(1);
  });
});

describe("previewGoodreadsCsv", () => {
  it("reports counts without writing anything", async () => {
    const preview = previewGoodreadsCsv(csv('Dune,Frank Herbert,,,0,,to-read', ',No Title,,,0,,to-read'));
    expect(preview).toEqual({ fileError: null, bookCount: 1, errorCount: 1 });

    const { rows: books } = await db.query("SELECT id FROM book WHERE household_id = $1", [HOUSEHOLD]);
    expect(books).toHaveLength(0);
  });

  it("surfaces file-level errors", () => {
    expect(previewGoodreadsCsv("Name,Creator\nDune,Frank Herbert\n")).toEqual({
      fileError: "not_goodreads",
      bookCount: 0,
      errorCount: 0,
    });
    expect(previewGoodreadsCsv("Title,Author\n")).toEqual({
      fileError: "no_books",
      bookCount: 0,
      errorCount: 0,
    });
  });
});
