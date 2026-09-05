// Home-screen repo layer (design-spec gap #3): read-only aggregation over
// the local PGlite mirror for the four Home sections -- overdue loans,
// to-return loans, per-member currently-reading, and recently-added books.
// Every function here only reads; nothing calls enqueue(). Mirrors the
// join/filter patterns in loans.ts/books.ts/reading-status.ts, but none of
// their exported functions cover these specific filter combinations, so
// this module owns its own (smaller) projections rather than reusing theirs.
import { db, ready } from "../db/pglite.js";
import type { Book, Loan } from "@taakify/shared";

export const SECTION_CAP = 5;

// due_date/out_date/returned_date are `date` columns -- PGlite can return
// these as a JS Date object rather than a string depending on how the
// value was written, so every date column here is cast to text in SQL
// (Postgres preserves the original column alias through a cast) rather
// than normalized client-side.
const LOAN_SELECT = `
  SELECT l.id, l.household_id, l.direction,
         l.out_date::text AS out_date, l.due_date::text AS due_date, l.returned_date::text AS returned_date,
         l.notes, l.updated_at,
         (l.returned_date IS NULL AND l.due_date IS NOT NULL AND l.due_date < CURRENT_DATE) AS overdue,
         b.id AS book_id, b.ownership, b.format, b.shelf_id, b.do_not_lend, b.wishlist_priority,
         e.id AS edition_id, e.title, e.authors, e.cover_url, e.isbn, e.language,
         c.id AS contact_id, c.name AS contact_name
  FROM loan l
  JOIN book b ON b.id = l.book_id
  JOIN edition e ON e.id = b.edition_id
  JOIN contact c ON c.id = l.contact_id
`;

type LoanRow = {
  id: string;
  household_id: string;
  direction: Loan["direction"];
  out_date: string | null;
  due_date: string | null;
  returned_date: string | null;
  notes: string | null;
  updated_at: string;
  overdue: boolean;
  book_id: string;
  ownership: Book["ownership"];
  format: string | null;
  shelf_id: string | null;
  do_not_lend: boolean;
  wishlist_priority: Book["wishlist_priority"];
  edition_id: string;
  title: string;
  authors: string;
  cover_url: string | null;
  isbn: string | null;
  language: string | null;
  contact_id: string;
  contact_name: string;
};

function mapLoanRow(row: LoanRow): Loan {
  return {
    id: row.id,
    household_id: row.household_id,
    direction: row.direction,
    out_date: row.out_date,
    due_date: row.due_date,
    returned_date: row.returned_date,
    notes: row.notes,
    updated_at: row.updated_at,
    overdue: row.overdue,
    book: {
      id: row.book_id,
      ownership: row.ownership,
      format: row.format,
      shelf_id: row.shelf_id,
      do_not_lend: row.do_not_lend,
      wishlist_priority: row.wishlist_priority,
      edition: {
        id: row.edition_id,
        title: row.title,
        authors: row.authors,
        cover_url: row.cover_url,
        isbn: row.isbn,
        language: row.language,
      },
    },
    contact: { id: row.contact_id, name: row.contact_name },
  };
}

export async function listOverdueLoans(householdId: string): Promise<Loan[]> {
  await ready;
  const { rows } = await db.query<LoanRow>(
    `${LOAN_SELECT}
     WHERE l.household_id = $1 AND l.deleted_at IS NULL AND l.returned_date IS NULL
       AND l.due_date IS NOT NULL AND l.due_date < CURRENT_DATE
     ORDER BY l.due_date ASC
     LIMIT $2`,
    [householdId, SECTION_CAP]
  );
  return rows.map(mapLoanRow);
}

// Deliberately excludes anything listOverdueLoans returns: the
// `due_date < CURRENT_DATE` cutoff there and `due_date >= CURRENT_DATE`
// here are mutually exclusive, so no loan appears in both sections.
export async function listToReturnLoans(householdId: string): Promise<Loan[]> {
  await ready;
  const { rows } = await db.query<LoanRow>(
    `${LOAN_SELECT}
     WHERE l.household_id = $1 AND l.deleted_at IS NULL AND l.returned_date IS NULL
       AND l.direction = 'borrowed_in'
       AND (l.due_date IS NULL OR l.due_date >= CURRENT_DATE)
     ORDER BY l.due_date ASC NULLS LAST
     LIMIT $2`,
    [householdId, SECTION_CAP]
  );
  return rows.map(mapLoanRow);
}

export interface ReadingStatusWithBook {
  user_id: string;
  started_at: string | null;
  book: Book;
}

type ReadingRow = {
  user_id: string;
  started_at: string | null;
  book_id: string;
  ownership: Book["ownership"];
  format: string | null;
  shelf_id: string | null;
  do_not_lend: boolean;
  wishlist_priority: Book["wishlist_priority"];
  edition_id: string;
  title: string;
  authors: string;
  cover_url: string | null;
  isbn: string | null;
  language: string | null;
};

// No LIMIT here -- results are grouped and capped per-member client-side
// (Home.tsx), since capping in SQL would risk starving a member with many
// active reads in favor of one with few.
export async function listCurrentlyReading(householdId: string): Promise<ReadingStatusWithBook[]> {
  await ready;
  const { rows } = await db.query<ReadingRow>(
    `SELECT rs.user_id, rs.started_at::text AS started_at,
            b.id AS book_id, b.ownership, b.format, b.shelf_id, b.do_not_lend, b.wishlist_priority,
            e.id AS edition_id, e.title, e.authors, e.cover_url, e.isbn, e.language
     FROM reading_status rs
     JOIN book b ON b.id = rs.book_id
     JOIN edition e ON e.id = b.edition_id
     WHERE rs.household_id = $1 AND rs.status = 'reading' AND rs.deleted_at IS NULL AND b.deleted_at IS NULL
     ORDER BY rs.updated_at DESC`,
    [householdId]
  );
  return rows.map((row) => ({
    user_id: row.user_id,
    started_at: row.started_at,
    book: {
      id: row.book_id,
      ownership: row.ownership,
      format: row.format,
      shelf_id: row.shelf_id,
      do_not_lend: row.do_not_lend,
      wishlist_priority: row.wishlist_priority,
      edition: {
        id: row.edition_id,
        title: row.title,
        authors: row.authors,
        cover_url: row.cover_url,
        isbn: row.isbn,
        language: row.language,
      },
    },
  }));
}

type RecentBookRow = {
  id: string;
  ownership: Book["ownership"];
  format: string | null;
  shelf_id: string | null;
  do_not_lend: boolean;
  wishlist_priority: Book["wishlist_priority"];
  notes: string | null;
  edition_id: string;
  title: string;
  authors: string;
  cover_url: string | null;
  isbn: string | null;
  language: string | null;
};

export async function listRecentlyAdded(householdId: string, limit: number = SECTION_CAP): Promise<Book[]> {
  await ready;
  const { rows } = await db.query<RecentBookRow>(
    `SELECT b.id, b.ownership, b.format, b.shelf_id, b.do_not_lend, b.wishlist_priority, b.notes,
            e.id AS edition_id, e.title, e.authors, e.cover_url, e.isbn, e.language
     FROM book b
     JOIN edition e ON e.id = b.edition_id
     WHERE b.household_id = $1 AND b.deleted_at IS NULL
     ORDER BY b.created_at DESC
     LIMIT $2`,
    [householdId, limit]
  );
  return rows.map((row) => ({
    id: row.id,
    ownership: row.ownership,
    format: row.format,
    shelf_id: row.shelf_id,
    do_not_lend: row.do_not_lend,
    wishlist_priority: row.wishlist_priority,
    notes: row.notes,
    edition: {
      id: row.edition_id,
      title: row.title,
      authors: row.authors,
      cover_url: row.cover_url,
      isbn: row.isbn,
      language: row.language,
    },
  }));
}
