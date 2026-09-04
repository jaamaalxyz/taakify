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
