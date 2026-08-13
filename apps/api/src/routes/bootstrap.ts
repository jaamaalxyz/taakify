import { Hono } from "hono";
import { withUser } from "../db/tenant.js";
import { requireUser, type SessionUser } from "../middleware/session.js";

export const bootstrap = new Hono<{ Variables: { user: SessionUser } }>();

bootstrap.use("*", requireUser);

// Column lists mirror apps/web/src/lib/db/mirror-schema.sql exactly (and, in
// turn, apps/web/src/lib/sync/shape.ts's COLUMNS) — the web-side seeding
// logic upserts each collection straight into the matching PGlite mirror
// table using these same field names, so the shapes here are NOT the nested
// (book+edition, loan+book+contact, ...) envelopes the list/detail routes in
// books.ts/loans.ts/shelves.ts return; they're flat rows, one per mirror
// table.
const TENANT_TABLE_COLUMNS: Record<string, string[]> = {
  bookcase: ["id", "household_id", "name", "created_by", "created_at", "updated_at", "deleted_at"],
  shelf: [
    "id",
    "household_id",
    "bookcase_id",
    "position",
    "label",
    "created_by",
    "created_at",
    "updated_at",
    "deleted_at",
  ],
  book: [
    "id",
    "household_id",
    "edition_id",
    "ownership",
    "format",
    "shelf_id",
    "do_not_lend",
    "wishlist_priority",
    "notes",
    "created_by",
    "created_at",
    "updated_at",
    "deleted_at",
  ],
  reading_status: [
    "id",
    "household_id",
    "book_id",
    "user_id",
    "status",
    "started_at",
    "finished_at",
    "rating",
    "review_note",
    "created_at",
    "updated_at",
    "deleted_at",
  ],
  tag: ["id", "household_id", "name", "created_by", "created_at", "updated_at", "deleted_at"],
  contact: [
    "id",
    "household_id",
    "name",
    "phone",
    "email",
    "linked_user_id",
    "created_by",
    "created_at",
    "updated_at",
    "deleted_at",
  ],
  loan: [
    "id",
    "household_id",
    "book_id",
    "contact_id",
    "direction",
    "out_date",
    "due_date",
    "returned_date",
    "notes",
    "created_by",
    "created_at",
    "updated_at",
    "deleted_at",
  ],
};

const EDITION_COLUMNS = [
  "id",
  "isbn",
  "title",
  "authors",
  "language",
  "publisher",
  "published_year",
  "cover_url",
  "series_name",
  "series_number",
  "created_at",
  "updated_at",
  "deleted_at",
];

// GET /api/bootstrap?householdId=... — one-round-trip seed fetch for the
// PGlite mirror's cold start (Task 8). Returns the household's full
// book-domain dataset as flat rows keyed by mirror table name, so the web
// sync layer (apps/web/src/lib/sync/shape.ts's bootstrap()) can upsert each
// collection directly with the same ON CONFLICT (id) DO UPDATE pattern the
// Electric shape stream uses — no reconciliation needed since both are keyed
// by the same server-assigned row ids.
//
// RLS (migrations/0003_rls.sql) already scopes every query below to
// households the caller belongs to via app_user_households(); a caller who
// isn't a member of `householdId` gets empty arrays back, not a 403 — same
// as tags.ts's GET / and every other list endpoint that takes householdId
// as a query param instead of a path param.
bootstrap.get("/", async (c) => {
  const user = c.get("user");
  const householdId = c.req.query("householdId");
  if (!householdId) return c.json({ error: "householdId is required" }, 400);

  const result = await withUser(user.id, async (client) => {
    const tenantRows: Record<string, unknown[]> = {};
    for (const [table, columns] of Object.entries(TENANT_TABLE_COLUMNS)) {
      const { rows } = await client.query(
        `SELECT ${columns.join(", ")} FROM ${table} WHERE household_id = $1 AND deleted_at IS NULL`,
        [householdId]
      );
      tenantRows[table] = rows;
    }

    // `edition` is a global shared catalog with no household_id (see
    // CLAUDE.md and shape.ts's subscribeTable("edition", undefined,
    // undefined) precedent) — every household can already read every
    // edition row via the API, so returning the whole catalog unfiltered
    // here is consistent with that existing trust model, not new scope.
    const { rows: editions } = await client.query(
      `SELECT ${EDITION_COLUMNS.join(", ")} FROM edition`
    );

    return { tenantRows, editions };
  });

  return c.json({
    bookcases: result.tenantRows.bookcase,
    shelves: result.tenantRows.shelf,
    books: result.tenantRows.book,
    reading_statuses: result.tenantRows.reading_status,
    tags: result.tenantRows.tag,
    contacts: result.tenantRows.contact,
    loans: result.tenantRows.loan,
    editions: result.editions,
  });
});
