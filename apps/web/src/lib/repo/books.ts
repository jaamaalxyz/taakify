// Books repo layer: reads hit the local PGlite mirror directly (kept fresh
// by the Electric shape stream, Task 4); writes go through the outbox
// (Task 5) so they're queued for the real API and applied optimistically to
// the mirror in the same transaction.
//
// This mirrors GET/POST/PATCH/DELETE /api/books* in
// apps/api/src/routes/books.ts — same filters, same joins, same computed
// nesting (`edition` embedded on each book) — just running against the
// local mirror tables (mirror-schema.sql) instead of the server's Postgres.
//
// Known gap (see task-6-report.md for detail): none of the write endpoints
// this file targets accept a client-supplied id (CreateBookRequest has no
// `id` field — apps/api/src/routes/books.ts always calls `crypto.randomUUID()`
// itself for both the book row and, when needed, a newly-created edition
// row). So the id used in each optimistic local INSERT below is a
// local-only id that will differ from the id the server eventually assigns.
// Once Task 4's shape stream syncs the real server row down, the household
// will see both the optimistic local row and the real one until a future
// task reconciles them (out of scope here — Task 5's outbox does not thread
// the server's response body back to the caller today).
import { db, ready } from "../db/pglite.js";
import { enqueue } from "../sync/outbox.js";
import type { Book, Ownership, WishlistPriority } from "@taakify/shared";

type BookRow = {
  id: string;
  ownership: Ownership;
  format: string | null;
  shelf_id: string | null;
  do_not_lend: boolean;
  wishlist_priority: WishlistPriority | null;
  notes: string | null;
  updated_at: string;
  edition_id: string;
  title: string;
  authors: string;
  cover_url: string | null;
  isbn: string | null;
  language: string | null;
};

function mapBookRow(row: BookRow): Book {
  return {
    id: row.id,
    ownership: row.ownership,
    format: row.format,
    shelf_id: row.shelf_id,
    do_not_lend: row.do_not_lend,
    wishlist_priority: row.wishlist_priority,
    notes: row.notes,
    updated_at: row.updated_at,
    edition: {
      id: row.edition_id,
      title: row.title,
      authors: row.authors,
      cover_url: row.cover_url,
      isbn: row.isbn,
      language: row.language,
    },
  };
}

const BOOK_SELECT = `
  SELECT b.id, b.ownership, b.format, b.shelf_id, b.do_not_lend, b.wishlist_priority, b.notes, b.updated_at,
         e.id AS edition_id, e.title, e.authors, e.cover_url, e.isbn, e.language
  FROM book b JOIN edition e ON e.id = b.edition_id
`;

export interface ListBooksOptions {
  householdId: string;
  q?: string;
  ownership?: Ownership;
  // The reading-status filter is scoped to a single member (the caller, on
  // every screen that uses it today) — mirrors books.ts's `status` query
  // param, which is always evaluated against `user.id` server-side.
  statusUserId?: string;
  status?: string;
  tag?: string;
  shelfId?: string;
  offset?: number;
  limit?: number;
}

// Matches the server's default LIMIT (books.ts) and its 200 cap.
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

export async function listBooks(opts: ListBooksOptions): Promise<Book[]> {
  await ready;
  const where: string[] = ["b.household_id = $1", "b.deleted_at IS NULL"];
  const params: unknown[] = [opts.householdId];
  let i = 2;

  if (opts.q) {
    // Escape LIKE metacharacters the same way the server does, so a literal
    // "%"/"_" in the search box doesn't act as an unintended wildcard.
    const escaped = opts.q.toLowerCase().replace(/[\\%_]/g, "\\$&");
    where.push(`(lower(e.title) LIKE $${i} ESCAPE '\\' OR lower(e.authors) LIKE $${i} ESCAPE '\\')`);
    params.push(`%${escaped}%`);
    i++;
  }
  if (opts.ownership) {
    where.push(`b.ownership = $${i}`);
    params.push(opts.ownership);
    i++;
  }
  if (opts.shelfId) {
    where.push(`b.shelf_id = $${i}`);
    params.push(opts.shelfId);
    i++;
  }
  if (opts.status && opts.statusUserId) {
    where.push(
      `EXISTS (SELECT 1 FROM reading_status rs WHERE rs.book_id = b.id AND rs.user_id = $${i} AND rs.status = $${i + 1} AND rs.deleted_at IS NULL)`
    );
    params.push(opts.statusUserId, opts.status);
    i += 2;
  }
  if (opts.tag) {
    where.push(
      `EXISTS (SELECT 1 FROM book_tag bt JOIN tag t ON t.id = bt.tag_id WHERE bt.book_id = b.id AND t.name = $${i} AND bt.deleted_at IS NULL)`
    );
    params.push(opts.tag);
    i++;
  }

  const limit = Math.min(opts.limit && opts.limit > 0 ? opts.limit : DEFAULT_LIMIT, MAX_LIMIT);
  const offset = Math.max(opts.offset ?? 0, 0);
  params.push(limit, offset);

  const { rows } = await db.query<BookRow>(
    `${BOOK_SELECT} WHERE ${where.join(" AND ")} ORDER BY e.title LIMIT $${i} OFFSET $${i + 1}`,
    params
  );
  return rows.map(mapBookRow);
}

export async function getBook(bookId: string): Promise<Book | null> {
  await ready;
  const { rows } = await db.query<BookRow>(`${BOOK_SELECT} WHERE b.id = $1 AND b.deleted_at IS NULL`, [bookId]);
  return rows[0] ? mapBookRow(rows[0]) : null;
}

export interface CreateBookInput {
  householdId: string;
  editionId?: string;
  edition?: { isbn?: string; title: string; authors?: string; language?: string; cover_url?: string };
  ownership: Ownership;
  shelf_id?: string;
  do_not_lend?: boolean;
  wishlist_priority?: WishlistPriority;
  notes?: string;
  createdBy: string;
}

// Returns the locally-generated book id so callers can navigate to it, etc.
// (it will NOT match the server's eventual id — see the header comment.)
export async function createBook(input: CreateBookInput): Promise<string> {
  await ready;
  const bookId = crypto.randomUUID();
  const now = new Date().toISOString();

  let editionId = input.editionId;
  const statements: { sql: string; params: unknown[] }[] = [];
  if (!editionId && input.edition) {
    editionId = crypto.randomUUID();
    statements.push({
      sql: `INSERT INTO edition (id, isbn, title, authors, language, cover_url, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
      params: [
        editionId,
        input.edition.isbn ?? null,
        input.edition.title,
        input.edition.authors ?? "",
        input.edition.language ?? null,
        input.edition.cover_url ?? null,
        now,
      ],
    });
  }
  statements.push({
    sql: `INSERT INTO book (id, household_id, edition_id, ownership, shelf_id, do_not_lend, wishlist_priority, notes, created_by, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`,
    params: [
      bookId,
      input.householdId,
      editionId,
      input.ownership,
      input.shelf_id ?? null,
      input.do_not_lend ?? false,
      input.wishlist_priority ?? null,
      input.notes ?? null,
      input.createdBy,
      now,
    ],
  });

  // Multiple statements need to land in one PGlite transaction (the edition
  // insert must precede the book insert that references it) — enqueue only
  // takes a single optimistic statement, so run the edition insert directly
  // first and pass the book insert as the outbox's optimistic write. If the
  // edition insert succeeds but the process dies before enqueue() runs, the
  // mirror is left with an orphaned edition row and no outbox entry — a
  // narrow window, and edition rows are inert (no FK, no cleanup needed), so
  // this is an acceptable tradeoff rather than a correctness bug.
  for (const stmt of statements.slice(0, -1)) {
    await db.query(stmt.sql, stmt.params);
  }
  const bookInsert = statements[statements.length - 1];

  await enqueue(
    "/api/books",
    "POST",
    {
      householdId: input.householdId,
      editionId: input.editionId,
      edition: input.edition,
      ownership: input.ownership,
      shelf_id: input.shelf_id,
      do_not_lend: input.do_not_lend,
      wishlist_priority: input.wishlist_priority,
      notes: input.notes,
    },
    { sql: bookInsert.sql, params: bookInsert.params }
  );

  return bookId;
}

export interface UpdateBookInput {
  shelf_id?: string | null;
  ownership?: Ownership;
  do_not_lend?: boolean;
  wishlist_priority?: WishlistPriority | null;
  notes?: string | null;
}

export async function updateBook(bookId: string, input: UpdateBookInput): Promise<void> {
  await ready;
  const allowed = ["shelf_id", "ownership", "do_not_lend", "wishlist_priority", "notes"] as const;
  const sets: string[] = [];
  const params: unknown[] = [bookId];
  let i = 2;
  for (const key of allowed) {
    if (key in input) {
      sets.push(`${key} = $${i}`);
      params.push((input as Record<string, unknown>)[key]);
      i++;
    }
  }
  if (!sets.length) return;

  await enqueue(`/api/books/${bookId}`, "PATCH", input, {
    sql: `UPDATE book SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 AND deleted_at IS NULL`,
    params,
  });
}

export async function deleteBook(bookId: string): Promise<void> {
  await ready;
  await enqueue(`/api/books/${bookId}`, "DELETE", undefined, {
    sql: `UPDATE book SET deleted_at = now(), updated_at = now() WHERE id = $1 AND deleted_at IS NULL`,
    params: [bookId],
  });
}
