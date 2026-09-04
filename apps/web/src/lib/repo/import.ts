// apps/web/src/lib/repo/import.ts
//
// Orchestrates the shared Goodreads mapper (packages/shared/src/
// goodreads-import.ts) against the existing book and reading-status repo
// functions -- each imported row reuses the same outbox-backed, offline-safe
// write path as a manual Add (createBook, upsertMyReadingStatus), rather
// than a new bulk code path or API endpoint.
//
// Rows are de-duplicated against the household's existing mirror rows (by
// ISBN, or title+author when the export has no ISBN) and against earlier
// rows in the same file, so importing the same CSV twice -- or importing
// over a library that was partly added by hand -- skips instead of
// duplicating. The UI gets a parse-only preview (previewGoodreadsCsv) to
// show "Found N books" before any write happens, and shouldCancel lets a
// long import be stopped mid-run.
import { mapGoodreadsCsv, type MappedGoodreadsBook } from "@taakify/shared";
import { db, ready } from "../db/pglite.js";
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
  cancelled: boolean;
}

export interface ImportPreview {
  // null = the file maps fine; "not_goodreads"/"no_books" otherwise (the
  // UI renders the friendly message for each).
  fileError: "not_goodreads" | "no_books" | null;
  bookCount: number;
  errorCount: number;
}

export interface ImportGoodreadsCsvContext {
  householdId: string;
  userId: string;
  onProgress?: (done: number, total: number) => void;
  // Polled before each row; a long import can be stopped by the user.
  shouldCancel?: () => boolean;
}

export function previewGoodreadsCsv(csvText: string): ImportPreview {
  const { books, errors, fileError } = mapGoodreadsCsv(csvText);
  return { fileError, bookCount: books.length, errorCount: errors.length };
}

function dedupKey(book: MappedGoodreadsBook): string {
  // ISBN is authoritative when present; otherwise fall back to a
  // case-insensitive title+author match -- the same pair the existing-book
  // query below checks.
  return book.isbn
    ? `isbn:${book.isbn}`
    : `t:${book.title.trim().toLowerCase()}|a:${book.authors.trim().toLowerCase()}`;
}

async function bookAlreadyInHousehold(book: MappedGoodreadsBook, householdId: string): Promise<boolean> {
  const base = `FROM book b JOIN edition e ON e.id = b.edition_id
       WHERE b.household_id = $1 AND b.deleted_at IS NULL AND `;
  if (book.isbn) {
    const { rows } = await db.query(`SELECT 1 ${base}e.isbn = $2 LIMIT 1`, [householdId, book.isbn]);
    if (rows.length > 0) return true;
  }
  // No-ISBN exports (or an ISBN the household doesn't have yet) fall back
  // to a case-insensitive title+author match.
  const { rows } = await db.query(
    `SELECT 1 ${base}lower(e.title) = lower($2) AND lower(e.authors) = lower($3) LIMIT 1`,
    [householdId, book.title, book.authors]
  );
  return rows.length > 0;
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

  await ready;

  let imported = 0;
  let cancelled = false;
  const seenKeys = new Set<string>();
  for (let i = 0; i < books.length; i++) {
    const book = books[i];
    if (ctx.shouldCancel?.()) {
      cancelled = true;
      break;
    }
    try {
      const key = dedupKey(book);
      if (seenKeys.has(key) || (await bookAlreadyInHousehold(book, ctx.householdId))) {
        failures.push({
          rowNumber: book.rowNumber,
          title: book.title,
          message: "Already in your library — skipped",
        });
        continue;
      }
      seenKeys.add(key);
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
  return { totalRows: books.length + errors.length, imported, failures, cancelled };
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
