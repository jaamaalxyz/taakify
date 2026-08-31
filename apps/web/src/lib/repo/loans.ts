// Loans repo layer — mirrors GET/POST /api/loans and PATCH /api/loans/:id
// in apps/api/src/routes/loans.ts, including the nested book/contact shape
// and the `overdue` computed column.
import { db, ready } from "../db/pglite.js";
import { enqueue } from "../sync/outbox.js";
import { OPTIMISTIC_UPDATED_AT } from "../sync/optimistic-clock.js";
import type { Loan, LoanDirection, Ownership, WishlistPriority } from "@taakify/shared";

type LoanRow = {
  id: string;
  household_id: string;
  direction: LoanDirection;
  out_date: string | Date | null;
  due_date: string | Date | null;
  returned_date: string | Date | null;
  notes: string | null;
  updated_at: string;
  overdue: boolean;
  book_id: string;
  ownership: Ownership;
  format: string | null;
  shelf_id: string | null;
  do_not_lend: boolean;
  wishlist_priority: WishlistPriority | null;
  edition_id: string;
  title: string;
  authors: string;
  cover_url: string | null;
  isbn: string | null;
  language: string | null;
  contact_id: string;
  contact_name: string;
};

// PGlite's date-typed columns can come back as either a 'YYYY-MM-DD' string
// or a JS Date depending on driver config — normalize either to the plain
// date string every screen expects (mirrors apps/api/src/lib/date.ts's
// dateStr(), which the server applies before ever sending JSON).
function dateStr(v: string | Date | null): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v.length > 10 ? v.slice(0, 10) : v;
  const y = v.getFullYear();
  const m = String(v.getMonth() + 1).padStart(2, "0");
  const d = String(v.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

const LOAN_SELECT = `
  SELECT l.id, l.household_id, l.direction, l.out_date, l.due_date, l.returned_date,
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

function mapLoanRow(row: LoanRow): Loan {
  return {
    id: row.id,
    household_id: row.household_id,
    direction: row.direction,
    out_date: dateStr(row.out_date),
    due_date: dateStr(row.due_date),
    returned_date: dateStr(row.returned_date),
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

export interface ListLoansOptions {
  householdId: string;
  active?: boolean;
  contactId?: string;
  bookId?: string;
}

export async function listLoans(opts: ListLoansOptions): Promise<Loan[]> {
  await ready;
  const where: string[] = ["l.household_id = $1", "l.deleted_at IS NULL"];
  const params: unknown[] = [opts.householdId];
  let i = 2;
  if (opts.active) where.push("l.returned_date IS NULL");
  if (opts.contactId) {
    where.push(`l.contact_id = $${i}`);
    params.push(opts.contactId);
    i++;
  }
  if (opts.bookId) {
    where.push(`l.book_id = $${i}`);
    params.push(opts.bookId);
    i++;
  }

  const { rows } = await db.query<LoanRow>(
    `${LOAN_SELECT} WHERE ${where.join(" AND ")} ORDER BY l.out_date DESC`,
    params
  );
  return rows.map(mapLoanRow);
}

export interface CreateLoanInput {
  bookId: string;
  contactId?: string;
  contactName?: string;
  direction: LoanDirection;
  dueDate?: string;
  createdBy: string;
}

// Returns the client-generated loan id, which is also the id the server
// row will end up with (see books.ts's header comment for the general
// client-supplied-id rationale). The inline contact creation this function
// does when contactName is given instead of contactId gets the same
// treatment via `newContactId` (see the comment above that branch).
//
// Both the inline contact INSERT (when needed) and the loan INSERT that
// references it are collected into `statements` and passed to a single
// enqueue() call, so they land atomically with the outbox row in one PGlite
// transaction — same fix as createBook's edition INSERT (books.ts). Before
// this fix, the contact INSERT ran as a bare, separate `db.query()` call
// before enqueue() was even invoked: a crash (or a closed tab) between the
// two left an orphaned local contact row with no outbox entry ever queued
// to send it to the server (Important finding, final whole-branch review).
export async function createLoan(input: CreateLoanInput): Promise<string> {
  await ready;
  const { rows: bookRows } = await db.query<{ household_id: string }>(
    "SELECT household_id FROM book WHERE id = $1 AND deleted_at IS NULL",
    [input.bookId]
  );
  const householdId = bookRows[0]?.household_id ?? null;

  let contactId = input.contactId;
  // When creating a contact inline (contactName, not contactId), generate
  // its id up front and send it to the server as `newContactId` — distinct
  // from `contactId`, which always means "reference an existing contact" —
  // so the server's inline contact INSERT uses the SAME id as this
  // optimistic local INSERT (see loans.ts's POST / route; fixes the
  // duplicate-row bug this id would otherwise cause once the real synced
  // contact row lands under a different id).
  let newContactId: string | undefined;
  const now = new Date().toISOString();
  const statements: { sql: string; params: unknown[] }[] = [];
  if (!contactId && input.contactName) {
    newContactId = crypto.randomUUID();
    contactId = newContactId;
    statements.push({
      sql: `INSERT INTO contact (id, household_id, name, created_by, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)`,
      params: [contactId, householdId, input.contactName, input.createdBy, now, OPTIMISTIC_UPDATED_AT],
    });
  }

  const loanId = crypto.randomUUID();
  statements.push({
    sql: `INSERT INTO loan (id, household_id, book_id, contact_id, direction, out_date, due_date, created_by, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, CURRENT_DATE, $6, $7, $8, $9)`,
    params: [
      loanId,
      householdId,
      input.bookId,
      contactId,
      input.direction,
      input.dueDate ?? null,
      input.createdBy,
      now,
      OPTIMISTIC_UPDATED_AT,
    ],
  });

  await enqueue(
    "/api/loans",
    "POST",
    {
      id: loanId,
      bookId: input.bookId,
      contactId: input.contactId,
      contactName: input.contactName,
      newContactId,
      direction: input.direction,
      dueDate: input.dueDate,
    },
    statements
  );
  return loanId;
}

export interface UpdateLoanInput {
  returned_date?: string | null;
  due_date?: string | null;
}

export async function updateLoan(loanId: string, input: UpdateLoanInput): Promise<void> {
  await ready;
  const allowed = ["returned_date", "due_date"] as const;
  const sets: string[] = [];
  const params: unknown[] = [loanId];
  let i = 2;
  for (const key of allowed) {
    if (key in input) {
      sets.push(`${key} = $${i}`);
      params.push((input as Record<string, unknown>)[key]);
      i++;
    }
  }
  if (!sets.length) return;

  // See optimistic-clock.ts — updated_at is a sentinel, not the browser's
  // clock, so a fast local clock can't cause the LWW guard to reject the
  // server's real row once this write syncs back down.
  params.push(OPTIMISTIC_UPDATED_AT);
  await enqueue(`/api/loans/${loanId}`, "PATCH", input, {
    sql: `UPDATE loan SET ${sets.join(", ")}, updated_at = $${i} WHERE id = $1 AND deleted_at IS NULL`,
    params,
  });
}
