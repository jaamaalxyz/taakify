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

// Whole-file problems surfaced before any row is mapped, so the UI can show
// one clear message ("this isn't a Goodreads export") instead of a wall of
// per-row "missing Title" errors.
export type GoodreadsFileError = "not_goodreads" | "no_books";

export interface GoodreadsImportResult {
  books: MappedGoodreadsBook[];
  errors: GoodreadsImportError[];
  fileError: GoodreadsFileError | null;
}

// Goodreads' three standard exclusive shelves. A custom exclusive shelf
// (users can rename/add these) falls back to "unread" and the raw shelf
// name is preserved in notes rather than dropped.
const EXCLUSIVE_SHELF_TO_STATUS: Record<string, ReadingStatus> = {
  read: "finished",
  "currently-reading": "reading",
  "to-read": "want_to_read",
};

// A "to-read" shelf is a wishlist -- those books usually aren't on the
// shelf at home -- so they import as wishlist ownership rather than owned.
const WISHLIST_SHELVES = new Set(["to-read"]);

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
  const ownership: Ownership = WISHLIST_SHELVES.has(shelf) ? "wishlist" : "owned";

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
    ownership,
    status,
    rating,
    finished_at: finishedAt,
    notes,
  };
}

export function mapGoodreadsCsv(text: string): GoodreadsImportResult {
  const { headers, rows } = parseCsv(text);

  // A real Goodreads export always has a Title column. Without it, mapping
  // every row would just produce N "missing Title" errors -- better to say
  // up front that the file isn't what we asked for.
  if (!headers.includes("Title")) {
    return { books: [], errors: [], fileError: "not_goodreads" };
  }

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

  if (books.length === 0 && errors.length === 0) {
    return { books, errors, fileError: "no_books" };
  }

  return { books, errors, fileError: null };
}
