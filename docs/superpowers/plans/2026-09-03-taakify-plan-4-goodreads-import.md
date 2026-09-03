# Taakify Plan 4: Goodreads CSV Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** let a household bulk-catalog an existing library by uploading a
Goodreads CSV export — each row becomes an `edition`+`book` and the
importing member's `reading_status`, with a per-row error report and no
data silently dropped.

**Architecture:** pure client-side. A hand-rolled RFC4180 CSV parser and a
Goodreads-column mapper live in `@taakify/shared` as pure, unit-tested
functions (this is the design spec's explicitly named highest-risk area —
see §9 below). A new web repo-layer function feeds each mapped row through
the *existing*, already-tested `createBook` / `upsertMyReadingStatus` repo
functions — the same outbox-backed, offline-safe write path a manual Add
uses — so no new API route or backend code is needed at all. A new page
(`Import.tsx`) drives a file picker and renders the results.

**Tech Stack:** TypeScript, React 19, Vitest + Testing Library (jsdom),
`@electric-sql/pglite` for repo-layer tests against a real in-memory
Postgres (no mocking of SQL). No new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-07-16-taakify-bookshelf-design.md`
(primarily Goal #5, Journey 2, §8 Error Handling, §9 Testing). Gap analysis
that produced this plan: `docs/superpowers/plans/2026-09-03-taakify-design-spec-gaps.md`
(gap #1, P0).

## Global Constraints

- Unicode throughout — local titles/authors are first-class (spec Goal #6).
  Never assume ASCII in the CSV parser or mapper.
- CSV import must produce a per-row error report; unmatched columns are
  preserved (folded into `notes`), never silently dropped (spec §8).
- Goodreads shelf mapping is fixed by the spec (Journey 2): `read` →
  `finished`, `to-read` → `want_to_read`; ratings are carried over.
- No proprietary/SaaS dependencies — everything ships as project code (spec
  Goal #7). The CSV parser is hand-rolled rather than adding a third-party
  library for a well-understood, small parsing problem.
- Every mutating repo function must go through `enqueue()` (the outbox),
  never write to the PGlite mirror directly outside of it — see
  `apps/web/src/lib/repo/books.ts`'s header comment for why (id convergence
  between optimistic writes and synced rows).

---

## File Structure

- `packages/shared/src/csv.ts` (new) — generic RFC4180 CSV text → rows
  parser. No Goodreads-specific knowledge; independently reusable.
- `packages/shared/src/goodreads-import.ts` (new) — Goodreads column
  mapping: one CSV row → a `MappedGoodreadsBook` (or a per-row error).
  Depends on `csv.ts`.
- `packages/shared/src/index.ts` (modify) — export both new modules.
- `apps/web/src/lib/repo/import.ts` (new) — orchestrates the shared mapper
  against `repo/books.ts`'s `createBook` and `repo/reading-status.ts`'s
  `upsertMyReadingStatus`, one row at a time, collecting a result summary.
- `apps/web/src/pages/Import.tsx` (new) — file picker, progress, and a
  results table (imported count + per-row failures).
- `apps/web/src/App.tsx` (modify) — register the `/import` route.
- `apps/web/src/pages/Add.tsx` (modify) — add a link to `/import` (same
  pattern as `Profile.tsx`'s existing link to `/bookcases`).

---

### Task 1: CSV parser (`@taakify/shared`)

**Files:**
- Create: `packages/shared/src/csv.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/csv.test.ts`

**Interfaces:**
- Produces: `parseCsv(text: string): ParsedCsv` where
  `interface ParsedCsv { headers: string[]; rows: string[][] }`. Task 2
  consumes this directly.

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/shared/test/csv.test.ts
import { describe, it, expect } from "vitest";
import { parseCsv } from "../src/csv.js";

describe("parseCsv", () => {
  it("parses a simple header + data rows", () => {
    const result = parseCsv("Title,Author\nDune,Frank Herbert\nEmma,Jane Austen\n");
    expect(result.headers).toEqual(["Title", "Author"]);
    expect(result.rows).toEqual([
      ["Dune", "Frank Herbert"],
      ["Emma", "Jane Austen"],
    ]);
  });

  it("handles a quoted field containing a comma", () => {
    const result = parseCsv('Title,Notes\n"Dune, Book One",great');
    expect(result.rows).toEqual([["Dune, Book One", "great"]]);
  });

  it("handles a quoted field containing an embedded newline", () => {
    const result = parseCsv('Title,Review\nDune,"Line one\nLine two"');
    expect(result.rows).toEqual([["Dune", "Line one\nLine two"]]);
  });

  it("handles an escaped double-quote inside a quoted field", () => {
    const result = parseCsv('Title,Notes\nDune,"She said ""wow"""');
    expect(result.rows).toEqual([["Dune", 'She said "wow"']]);
  });

  it("handles CRLF line endings", () => {
    const result = parseCsv("Title,Author\r\nDune,Frank Herbert\r\n");
    expect(result.headers).toEqual(["Title", "Author"]);
    expect(result.rows).toEqual([["Dune", "Frank Herbert"]]);
  });

  it("ignores a trailing blank line", () => {
    const result = parseCsv("Title\nDune\nEmma\n\n");
    expect(result.rows).toEqual([["Dune"], ["Emma"]]);
  });

  it("returns empty headers and rows for empty input", () => {
    const result = parseCsv("");
    expect(result).toEqual({ headers: [], rows: [] });
  });

  it("handles a header-only file with no data rows", () => {
    const result = parseCsv("Title,Author\n");
    expect(result.headers).toEqual(["Title", "Author"]);
    expect(result.rows).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @taakify/shared test -- csv.test.ts`
Expected: FAIL — `Cannot find module '../src/csv.js'` (or similar; the file doesn't exist yet).

- [ ] **Step 3: Write the implementation**

```typescript
// packages/shared/src/csv.ts
//
// Hand-rolled RFC4180 parser: quoted fields, embedded commas/newlines
// inside quotes, "" as an escaped quote, and CRLF or LF line endings.
// Deliberately not a third-party dependency — Goodreads exports are a
// small, well-understood CSV dialect, and the project avoids adding deps
// for problems this contained (see this plan's Global Constraints).

export interface ParsedCsv {
  headers: string[];
  rows: string[][];
}

export function parseCsv(text: string): ParsedCsv {
  const allRows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  function pushField() {
    row.push(field);
    field = "";
  }
  function pushRow() {
    pushField();
    allRows.push(row);
    row = [];
  }

  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      pushField();
      i++;
      continue;
    }
    if (ch === "\r") {
      // Normalize CRLF -> LF by dropping the \r; the following \n (if any)
      // is handled on the next loop iteration.
      i++;
      continue;
    }
    if (ch === "\n") {
      pushRow();
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  // Flush a final field/row for input with no trailing newline.
  if (field.length > 0 || row.length > 0) {
    pushRow();
  }

  // A trailing newline produces one spurious all-blank single-field row
  // ([""]) once the loop above finishes — drop it rather than treating it
  // as a real (header-only-length) data row.
  const nonEmpty = allRows.filter((r) => !(r.length === 1 && r[0] === ""));

  const [headers, ...dataRows] = nonEmpty;
  return { headers: headers ?? [], rows: dataRows };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @taakify/shared test -- csv.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Export from the package barrel**

```typescript
// packages/shared/src/index.ts
export * from "./types.js";
export * from "./logic.js";
export * from "./contracts.js";
export * from "./csv.js";
```

- [ ] **Step 6: Typecheck and commit**

Run: `pnpm --filter @taakify/shared typecheck`
Expected: no errors

```bash
git add packages/shared/src/csv.ts packages/shared/src/index.ts packages/shared/test/csv.test.ts
git commit -m "feat(shared): add RFC4180 CSV parser for Goodreads import"
```

---

### Task 2: Goodreads row mapper (`@taakify/shared`)

**Files:**
- Create: `packages/shared/src/goodreads-import.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/goodreads-import.test.ts`

**Interfaces:**
- Consumes: `parseCsv` from Task 1 (`./csv.js`), `Ownership` /
  `ReadingStatus` / `READING_STATUS_VALUES` from `./types.js` (already in
  the repo — see `packages/shared/src/types.ts:10-25`).
- Produces:
  - `interface MappedGoodreadsBook { rowNumber: number; title: string; authors: string; isbn: string | null; ownership: Ownership; status: ReadingStatus; rating: number | null; finished_at: string | null; notes: string | null }`
  - `interface GoodreadsImportError { rowNumber: number; message: string }`
  - `interface GoodreadsImportResult { books: MappedGoodreadsBook[]; errors: GoodreadsImportError[] }`
  - `mapGoodreadsCsv(text: string): GoodreadsImportResult` — Task 3 consumes
    this directly.

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/shared/test/goodreads-import.test.ts
import { describe, it, expect } from "vitest";
import { mapGoodreadsCsv } from "../src/goodreads-import.js";

const HEADER =
  "Book Id,Title,Author,ISBN,ISBN13,My Rating,Publisher,Binding,Date Read,Bookshelves,Exclusive Shelf,My Review,Private Notes";

function csv(...dataRows: string[]): string {
  return [HEADER, ...dataRows].join("\n");
}

describe("mapGoodreadsCsv", () => {
  it("maps a finished ('read') row with rating, ISBN, and a carried-over Date Read", () => {
    const result = mapGoodreadsCsv(
      csv(
        '1,Dune,Frank Herbert,="",="9780441172719",5,Ace,Paperback,2023/05/12,read,read,,'
      )
    );
    expect(result.errors).toEqual([]);
    expect(result.books).toEqual([
      {
        rowNumber: 2,
        title: "Dune",
        authors: "Frank Herbert",
        isbn: "9780441172719",
        ownership: "owned",
        status: "finished",
        rating: 5,
        finished_at: "2023-05-12",
        notes: null,
      },
    ]);
  });

  it("maps 'currently-reading' to reading and ignores Date Read for a non-finished row", () => {
    const result = mapGoodreadsCsv(
      csv('2,Emma,Jane Austen,,,0,,,2023/05/12,currently-reading,currently-reading,,')
    );
    expect(result.books[0]).toMatchObject({ status: "reading", finished_at: null, rating: null });
  });

  it("maps 'to-read' to want_to_read", () => {
    const result = mapGoodreadsCsv(csv('3,1984,George Orwell,,,0,,,,to-read,to-read,,'));
    expect(result.books[0]).toMatchObject({ status: "want_to_read" });
  });

  it("falls back to unread for an unrecognized Exclusive Shelf, and folds the shelf name into notes", () => {
    const result = mapGoodreadsCsv(csv('4,Foundation,Isaac Asimov,,,0,,,,favorites,favorites,,'));
    expect(result.books[0].status).toBe("unread");
    expect(result.books[0].notes).toContain("Goodreads shelf: favorites");
  });

  it("prefers ISBN13 over ISBN and strips the Excel-guard quoting", () => {
    const result = mapGoodreadsCsv(
      csv('5,Dune,Frank Herbert,="0441172717",="9780441172719",0,,,,to-read,to-read,,')
    );
    expect(result.books[0].isbn).toBe("9780441172719");
  });

  it("falls back to ISBN when ISBN13 is blank", () => {
    const result = mapGoodreadsCsv(csv('6,Dune,Frank Herbert,="0441172717",="",0,,,,to-read,to-read,,'));
    expect(result.books[0].isbn).toBe("0441172717");
  });

  it("folds unmapped, non-empty columns into notes as 'Header: value' lines", () => {
    const result = mapGoodreadsCsv(
      csv('7,Dune,Frank Herbert,,,0,Ace,Paperback,,to-read,to-read,So good,Gift from Sam')
    );
    expect(result.books[0].notes).toBe(
      ["Publisher: Ace", "Binding: Paperback", "My Review: So good", "Private Notes: Gift from Sam"].join("\n")
    );
  });

  it("omits notes entirely when there is nothing unmapped to preserve", () => {
    const result = mapGoodreadsCsv(csv('8,Dune,Frank Herbert,,,0,,,,to-read,to-read,,'));
    expect(result.books[0].notes).toBeNull();
  });

  it("treats My Rating of 0 (Goodreads' 'no rating') as null", () => {
    const result = mapGoodreadsCsv(csv('9,Dune,Frank Herbert,,,0,,,,to-read,to-read,,'));
    expect(result.books[0].rating).toBeNull();
  });

  it("ignores a malformed Date Read rather than failing the row", () => {
    const result = mapGoodreadsCsv(csv('10,Dune,Frank Herbert,,,5,,,not-a-date,read,read,,'));
    expect(result.errors).toEqual([]);
    expect(result.books[0].finished_at).toBeNull();
  });

  it("reports a missing Title as a per-row error instead of a partial book", () => {
    const result = mapGoodreadsCsv(csv('11,,Frank Herbert,,,0,,,,to-read,to-read,,'));
    expect(result.books).toEqual([]);
    expect(result.errors).toEqual([{ rowNumber: 2, message: "missing Title" }]);
  });

  it("assigns rowNumber starting at 2 (row 1 is the header) and continues past a bad row", () => {
    const result = mapGoodreadsCsv(
      csv(
        '11,,Missing Title,,,0,,,,to-read,to-read,,', // row 2: error
        '12,Valid Book,Someone,,,0,,,,to-read,to-read,,' // row 3: ok
      )
    );
    expect(result.errors).toEqual([{ rowNumber: 2, message: "missing Title" }]);
    expect(result.books).toEqual([expect.objectContaining({ rowNumber: 3, title: "Valid Book" })]);
  });

  it("preserves non-ASCII titles and authors unchanged", () => {
    const result = mapGoodreadsCsv(csv('13,百年孤独,Gabriel García Márquez,,,0,,,,to-read,to-read,,'));
    expect(result.books[0]).toMatchObject({ title: "百年孤独", authors: "Gabriel García Márquez" });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @taakify/shared test -- goodreads-import.test.ts`
Expected: FAIL — `Cannot find module '../src/goodreads-import.js'`

- [ ] **Step 3: Write the implementation**

```typescript
// packages/shared/src/goodreads-import.ts
//
// Maps a Goodreads CSV export to Taakify's data model, per the design
// spec's Journey 2 (docs/superpowers/specs/2026-07-16-taakify-bookshelf-design.md):
// "shelf mapping: read->finished, to-read->want_to_read; ratings carried"
// and §8: "per-row error report; unmatched columns preserved in notes,
// never silently dropped."
import { parseCsv } from "./csv.js";
import { type Ownership, type ReadingStatus } from "./types.js";

export interface MappedGoodreadsBook {
  rowNumber: number;
  title: string;
  authors: string;
  isbn: string | null;
  ownership: Ownership;
  status: ReadingStatus;
  rating: number | null;
  finished_at: string | null;
  notes: string | null;
}

export interface GoodreadsImportError {
  rowNumber: number;
  message: string;
}

export interface GoodreadsImportResult {
  books: MappedGoodreadsBook[];
  errors: GoodreadsImportError[];
}

// Goodreads' three standard exclusive shelves. A custom exclusive shelf
// (users can rename/add these) falls back to "unread" and the raw shelf
// name is preserved in notes rather than dropped.
const EXCLUSIVE_SHELF_TO_STATUS: Record<string, ReadingStatus> = {
  read: "finished",
  "currently-reading": "reading",
  "to-read": "want_to_read",
};

// Columns folded directly into a MappedGoodreadsBook field. Every other
// non-empty column in the export is preserved in `notes` instead of being
// dropped (spec §8).
const MAPPED_HEADERS = new Set([
  "Title",
  "Author",
  "ISBN",
  "ISBN13",
  "My Rating",
  "Date Read",
  "Exclusive Shelf",
  // "Bookshelves" duplicates "Exclusive Shelf" for the standard 3 shelves
  // plus any additional (non-exclusive) shelves; the exclusive one is what
  // drives status, so treat this column as informational-only and fold it
  // into notes like any other unmapped column rather than special-casing it.
]);

// Goodreads wraps ISBN/ISBN13 as ="0141439563" so spreadsheet software
// doesn't mangle leading zeros or treat the value as a number. Strip that
// guard; blank after stripping means "not present".
function cleanIsbn(raw: string): string | null {
  const stripped = raw.trim().replace(/^="?/, "").replace(/"$/, "");
  return stripped.length > 0 ? stripped : null;
}

// Goodreads exports "Date Read" as YYYY/MM/DD, or blank. Anything else
// (never set, or an unexpected format) is left out rather than failing the
// whole row -- one malformed date field shouldn't lose the rest of a book.
function parseDateRead(raw: string): string | null {
  const match = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(raw.trim());
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

function fieldValue(headers: string[], row: string[], header: string): string {
  const idx = headers.indexOf(header);
  return idx === -1 ? "" : (row[idx] ?? "");
}

function mapGoodreadsRow(
  headers: string[],
  row: string[]
): Omit<MappedGoodreadsBook, "rowNumber"> | { error: string } {
  const title = fieldValue(headers, row, "Title").trim();
  if (!title) return { error: "missing Title" };

  const authors = fieldValue(headers, row, "Author").trim();
  const isbn13 = cleanIsbn(fieldValue(headers, row, "ISBN13"));
  const isbn = isbn13 ?? cleanIsbn(fieldValue(headers, row, "ISBN"));

  const rawRating = fieldValue(headers, row, "My Rating").trim();
  const ratingNum = Number(rawRating);
  // Goodreads uses 0 to mean "no rating given" -- not a real 0-star rating
  // (the app's own rating column is 1-5, see reading-status.ts).
  const rating = rawRating && ratingNum >= 1 && ratingNum <= 5 ? ratingNum : null;

  const shelf = fieldValue(headers, row, "Exclusive Shelf").trim();
  const status = EXCLUSIVE_SHELF_TO_STATUS[shelf] ?? "unread";

  const finishedAt = status === "finished" ? parseDateRead(fieldValue(headers, row, "Date Read")) : null;

  const extraLines: string[] = [];
  if (shelf && !EXCLUSIVE_SHELF_TO_STATUS[shelf]) {
    extraLines.push(`Goodreads shelf: ${shelf}`);
  }
  for (let i = 0; i < headers.length; i++) {
    const header = headers[i];
    if (MAPPED_HEADERS.has(header)) continue;
    const value = (row[i] ?? "").trim();
    if (value) extraLines.push(`${header}: ${value}`);
  }
  const notes = extraLines.length > 0 ? extraLines.join("\n") : null;

  return {
    title,
    authors,
    isbn,
    ownership: "owned",
    status,
    rating,
    finished_at: finishedAt,
    notes,
  };
}

export function mapGoodreadsCsv(text: string): GoodreadsImportResult {
  const { headers, rows } = parseCsv(text);
  const books: MappedGoodreadsBook[] = [];
  const errors: GoodreadsImportError[] = [];

  rows.forEach((row, i) => {
    // +2: the header is row 1, `rows` is 0-indexed after it -- this lines
    // up with the row number a user sees opening the CSV in a spreadsheet.
    const rowNumber = i + 2;
    const result = mapGoodreadsRow(headers, row);
    if ("error" in result) {
      errors.push({ rowNumber, message: result.error });
    } else {
      books.push({ ...result, rowNumber });
    }
  });

  return { books, errors };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @taakify/shared test -- goodreads-import.test.ts`
Expected: PASS (13 tests)

- [ ] **Step 5: Export from the package barrel**

```typescript
// packages/shared/src/index.ts
export * from "./types.js";
export * from "./logic.js";
export * from "./contracts.js";
export * from "./csv.js";
export * from "./goodreads-import.js";
```

- [ ] **Step 6: Typecheck and commit**

Run: `pnpm --filter @taakify/shared typecheck`
Expected: no errors

```bash
git add packages/shared/src/goodreads-import.ts packages/shared/src/index.ts packages/shared/test/goodreads-import.test.ts
git commit -m "feat(shared): map Goodreads CSV rows to books + reading status"
```

---

### Task 3: Web repo layer — `importGoodreadsCsv`

**Files:**
- Create: `apps/web/src/lib/repo/import.ts`
- Test: `apps/web/src/lib/repo/import.test.ts`

**Interfaces:**
- Consumes: `mapGoodreadsCsv`, `MappedGoodreadsBook` from `@taakify/shared`
  (Task 2); `createBook` from `./books.js`
  (`apps/web/src/lib/repo/books.ts:158`, returns `Promise<string>` — the
  book id); `upsertMyReadingStatus` from `./reading-status.js`
  (`apps/web/src/lib/repo/reading-status.ts` — signature
  `(bookId: string, userId: string, input: UpsertReadingStatusInput) => Promise<void>`).
- Produces:
  - `interface ImportRowFailure { rowNumber: number; title: string; message: string }`
  - `interface ImportResult { totalRows: number; imported: number; failures: ImportRowFailure[] }`
  - `interface ImportGoodreadsCsvContext { householdId: string; userId: string; onProgress?: (done: number, total: number) => void }`
  - `importGoodreadsCsv(csvText: string, ctx: ImportGoodreadsCsvContext): Promise<ImportResult>` —
    Task 4 consumes this directly.

- [ ] **Step 1: Write the failing tests**

```typescript
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
import { importGoodreadsCsv } from "./import.js";

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

    expect(result).toEqual({ totalRows: 2, imported: 2, failures: [] });

    const { rows: books } = await db.query<{ ownership: string; title: string; isbn: string | null }>(
      `SELECT b.ownership, e.title, e.isbn FROM book b JOIN edition e ON e.id = b.edition_id
       WHERE b.household_id = $1 ORDER BY e.title`,
      [HOUSEHOLD]
    );
    expect(books).toEqual([
      { ownership: "owned", title: "1984", isbn: null },
      { ownership: "owned", title: "Dune", isbn: "9780441172719" },
    ]);

    const { rows: statuses } = await db.query<{ status: string; rating: number | null; finished_at: string | null }>(
      `SELECT rs.status, rs.rating, rs.finished_at FROM reading_status rs
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @taakify/web test -- src/lib/repo/import.test.ts`
Expected: FAIL — `Cannot find module './import.js'`

- [ ] **Step 3: Write the implementation**

```typescript
// apps/web/src/lib/repo/import.ts
//
// Orchestrates the shared Goodreads mapper (packages/shared/src/
// goodreads-import.ts) against the existing book and reading-status repo
// functions -- each imported row reuses the same outbox-backed, offline-safe
// write path as a manual Add (createBook, upsertMyReadingStatus), rather
// than a new bulk code path or API endpoint.
import { mapGoodreadsCsv, type MappedGoodreadsBook } from "@taakify/shared";
import { createBook } from "./books.js";
import { upsertMyReadingStatus } from "./reading-status.js";

export interface ImportRowFailure {
  rowNumber: number;
  title: string;
  message: string;
}

export interface ImportResult {
  totalRows: number;
  imported: number;
  failures: ImportRowFailure[];
}

export interface ImportGoodreadsCsvContext {
  householdId: string;
  userId: string;
  onProgress?: (done: number, total: number) => void;
}

export async function importGoodreadsCsv(
  csvText: string,
  ctx: ImportGoodreadsCsvContext
): Promise<ImportResult> {
  const { books, errors } = mapGoodreadsCsv(csvText);

  const failures: ImportRowFailure[] = errors.map((e) => ({
    rowNumber: e.rowNumber,
    title: "",
    message: e.message,
  }));

  let imported = 0;
  for (let i = 0; i < books.length; i++) {
    const book = books[i];
    try {
      await importOneBook(book, ctx);
      imported++;
    } catch (err) {
      failures.push({
        rowNumber: book.rowNumber,
        title: book.title,
        message: err instanceof Error ? err.message : "Import failed",
      });
    }
    ctx.onProgress?.(i + 1, books.length);
  }

  failures.sort((a, b) => a.rowNumber - b.rowNumber);
  return { totalRows: books.length + errors.length, imported, failures };
}

async function importOneBook(book: MappedGoodreadsBook, ctx: ImportGoodreadsCsvContext): Promise<void> {
  const bookId = await createBook({
    householdId: ctx.householdId,
    edition: {
      isbn: book.isbn ?? undefined,
      title: book.title,
      authors: book.authors || undefined,
    },
    ownership: book.ownership,
    notes: book.notes ?? undefined,
    createdBy: ctx.userId,
  });

  await upsertMyReadingStatus(bookId, ctx.userId, {
    status: book.status,
    finished_at: book.finished_at,
    rating: book.rating,
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @taakify/web test -- src/lib/repo/import.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm --filter @taakify/web typecheck`
Expected: no errors

```bash
git add apps/web/src/lib/repo/import.ts apps/web/src/lib/repo/import.test.ts
git commit -m "feat(web): add importGoodreadsCsv repo function"
```

---

### Task 4: Import page, route, and entry point

**Files:**
- Create: `apps/web/src/pages/Import.tsx`
- Modify: `apps/web/src/App.tsx` — register `/import`
- Modify: `apps/web/src/pages/Add.tsx` — add a link to `/import`
- Test: `apps/web/src/pages/Import.test.tsx`

**Interfaces:**
- Consumes: `importGoodreadsCsv`, `ImportRowFailure`, `ImportResult` from
  `../lib/repo/import.js` (Task 3); `useHousehold` from
  `../lib/household-context.js` (returns
  `{ user: { id, email, name }, household: { id, name, role }, members }`
  — see `apps/web/src/lib/household-context.tsx:11-20`); `friendlyError`
  from `../lib/error-messages.js`; `Table`/`TableHeader`/`TableBody`/
  `TableRow`/`TableHead`/`TableCell` from `../components/ui/table.js`
  (`apps/web/src/components/ui/table.tsx:105-114`).

- [ ] **Step 1: Write the failing tests**

```typescript
// apps/web/src/pages/Import.test.tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { Import } from "./Import.js";
import { importGoodreadsCsv } from "../lib/repo/import.js";
import { useHousehold } from "../lib/household-context.js";

vi.mock("../lib/repo/import.js", () => ({ importGoodreadsCsv: vi.fn() }));
vi.mock("../lib/household-context.js", () => ({ useHousehold: vi.fn() }));

const household = { id: "h1", name: "Family Library", role: "owner" };

function renderImport() {
  render(
    <MemoryRouter initialEntries={["/import"]}>
      <Import />
    </MemoryRouter>
  );
}

function csvFile(text: string): File {
  return new File([text], "goodreads.csv", { type: "text/csv" });
}

beforeEach(() => {
  vi.mocked(importGoodreadsCsv).mockReset();
  vi.mocked(useHousehold).mockReturnValue({
    user: { id: "u1", email: "a@b.com", name: "Ada" },
    household,
    members: [],
  });
});

describe("Import", () => {
  it("imports the selected file and shows a success summary", async () => {
    vi.mocked(importGoodreadsCsv).mockResolvedValue({ totalRows: 2, imported: 2, failures: [] });
    renderImport();

    const input = screen.getByLabelText("Goodreads CSV export");
    await userEvent.upload(input, csvFile("Title\nDune\n1984"));

    await waitFor(() =>
      expect(importGoodreadsCsv).toHaveBeenCalledWith("Title\nDune\n1984", {
        householdId: "h1",
        userId: "u1",
        onProgress: expect.any(Function),
      })
    );
    expect(await screen.findByText("Imported 2 of 2 rows.")).toBeInTheDocument();
  });

  it("renders a per-row failure table when some rows fail", async () => {
    vi.mocked(importGoodreadsCsv).mockResolvedValue({
      totalRows: 2,
      imported: 1,
      failures: [{ rowNumber: 3, title: "", message: "missing Title" }],
    });
    renderImport();

    await userEvent.upload(screen.getByLabelText("Goodreads CSV export"), csvFile("Title\nDune\n"));

    expect(await screen.findByText("missing Title")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText(/1 row\(s\) had errors/)).toBeInTheDocument();
  });

  it("shows a friendly error banner when the import call itself throws", async () => {
    vi.mocked(importGoodreadsCsv).mockRejectedValue(new TypeError("network down"));
    renderImport();

    await userEvent.upload(screen.getByLabelText("Goodreads CSV export"), csvFile("Title\nDune\n"));

    expect(await screen.findByText("Couldn't connect. Check your connection and try again.")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @taakify/web test -- src/pages/Import.test.tsx`
Expected: FAIL — `Cannot find module './Import.js'`

- [ ] **Step 3: Write the Import page**

```tsx
// apps/web/src/pages/Import.tsx
import { useRef, useState, type ChangeEvent } from "react";
import { useHousehold } from "../lib/household-context.js";
import { importGoodreadsCsv, type ImportRowFailure } from "../lib/repo/import.js";
import { friendlyError } from "../lib/error-messages.js";
import { Label } from "../components/ui/label.js";
import { Alert, AlertDescription } from "../components/ui/alert.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.js";

export function Import() {
  const { household, user } = useHousehold();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [fileName, setFileName] = useState("");
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [summary, setSummary] = useState<{ imported: number; totalRows: number } | null>(null);
  const [failures, setFailures] = useState<ImportRowFailure[]>([]);
  const [topError, setTopError] = useState("");

  async function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setTopError("");
    setSummary(null);
    setFailures([]);
    setProgress(null);
    setImporting(true);
    try {
      const text = await file.text();
      const result = await importGoodreadsCsv(text, {
        householdId: household.id,
        userId: user.id,
        onProgress: (done, total) => setProgress({ done, total }),
      });
      setSummary({ imported: result.imported, totalRows: result.totalRows });
      setFailures(result.failures);
    } catch (err) {
      setTopError(friendlyError(err));
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Import from Goodreads</h1>
      <p className="text-sm text-muted-foreground">
        Export your library from Goodreads (My Books → Import/Export) and upload the CSV here. Each
        row becomes a book, with your reading status and rating carried over.
      </p>

      <div className="space-y-1">
        <Label htmlFor="import-file">Goodreads CSV export</Label>
        <input
          id="import-file"
          ref={fileInputRef}
          type="file"
          accept=".csv,text/csv"
          onChange={handleFileChange}
          disabled={importing}
        />
      </div>

      {importing && progress && (
        <p className="text-sm text-muted-foreground">
          Importing {fileName}: {progress.done} of {progress.total}…
        </p>
      )}

      {topError && (
        <Alert variant="destructive">
          <AlertDescription>{topError}</AlertDescription>
        </Alert>
      )}

      {summary && (
        <Alert>
          <AlertDescription>
            Imported {summary.imported} of {summary.totalRows} rows.
            {failures.length > 0 && ` ${failures.length} row(s) had errors — see below.`}
          </AlertDescription>
        </Alert>
      )}

      {failures.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Row</TableHead>
              <TableHead>Title</TableHead>
              <TableHead>Error</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {failures.map((f) => (
              <TableRow key={f.rowNumber}>
                <TableCell>{f.rowNumber}</TableCell>
                <TableCell>{f.title || "—"}</TableCell>
                <TableCell>{f.message}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Register the route**

```typescript
// apps/web/src/App.tsx
import { Import } from "./pages/Import.js";
```

Add alongside the other imports (after `import { Add } from "./pages/Add.js";`), and add the route inside the `AppShell` route block:

```typescript
        <Route path="/add" element={<Add />} />
        <Route path="/import" element={<Import />} />
```

Update the block comment above the route list (currently lists
`/library, /library/:bookId, /add, /loans, /bookcases, and /profile`) to
include `/import`.

- [ ] **Step 5: Link to it from Add**

In `apps/web/src/pages/Add.tsx`, add the import:

```typescript
import { Link } from "react-router-dom";
```

And add a link below the batch-mode toggle, before the error/submit block:

```tsx
        <div className="flex items-center gap-2">
          <Switch id="add-batch-mode" checked={batchMode} onCheckedChange={setBatchMode} />
          <Label htmlFor="add-batch-mode">Batch mode (keep shelf &amp; ownership between adds)</Label>
        </div>

        <Link to="/import" className="block text-sm font-medium text-primary underline-offset-4 hover:underline">
          Import a library from Goodreads instead
        </Link>
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @taakify/web test -- src/pages/Import.test.tsx`
Expected: PASS (3 tests)

Then run the full web suite to confirm nothing else regressed (in
particular `App.test.tsx`, since `App.tsx`'s route table eagerly imports
every page, including the new `Import.tsx` → `repo/import.js` →
`repo/reading-status.js` chain):

Run: `pnpm --filter @taakify/web test`
Expected: all tests PASS

- [ ] **Step 7: Typecheck, build, and commit**

Run: `pnpm --filter @taakify/web typecheck && pnpm --filter @taakify/web build`
Expected: no errors

```bash
git add apps/web/src/pages/Import.tsx apps/web/src/pages/Import.test.tsx apps/web/src/App.tsx apps/web/src/pages/Add.tsx
git commit -m "feat(web): add Goodreads CSV import page"
```

---

## Self-Review

**Spec coverage:**
- Journey 2 bulk import ("Goodreads CSV → editions + books + importer's
  reading_status", shelf mapping, ratings carried) — Tasks 2-3.
- §8 "per-row error report; unmatched columns preserved in notes, never
  silently dropped" — Task 2 (`notes` folding, `GoodreadsImportError`) and
  Task 4 (failures table).
- §9 "Unit: Goodreads import mapper" (named as one of only two
  highest-risk areas) — Task 1 + Task 2's dedicated pure-function test
  suites, run independently of any UI or database.
- Goal #6 Unicode/local-title handling — covered by Task 2's non-ASCII
  test case.

**Placeholder scan:** no TBD/TODO markers; every step has runnable code
and an exact test/typecheck command.

**Type consistency:** `ImportGoodreadsCsvContext`, `ImportResult`, and
`ImportRowFailure` (Task 3) are used with identical shapes in Task 4's
`Import.tsx` and its tests. `MappedGoodreadsBook.rowNumber` (Task 2) is the
same field `importOneBook`/`importGoodreadsCsv` (Task 3) read to build
`ImportRowFailure.rowNumber` on a write-time failure.

**Not in scope for this plan** (tracked separately in the gap-analysis
doc): barcode scanning (gap #2) as a faster way to fill in books the CSV
export doesn't have ISBNs for; a Playwright E2E offline-import scenario
(gap #5).
