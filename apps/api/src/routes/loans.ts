import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { withUser } from "../db/tenant.js";
import { requireUser, type SessionUser } from "../middleware/session.js";
import { dateStr } from "../lib/date.js";
import { LOAN_DIRECTION_VALUES, type LoanDirection } from "@taakify/shared";

export const loans = new Hono<{ Variables: { user: SessionUser } }>();

loans.use("*", requireUser);

const NESTED_SELECT = `
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

function nestLoan(row: any) {
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
    contact: {
      id: row.contact_id,
      name: row.contact_name,
    },
  };
}

// POST /api/loans — body { bookId, contactId?, contactName?, direction, dueDate? }.
// household_id is never taken from the request body; it's derived server-side
// from the book row (same pattern as reading-status.ts). If contactId is
// given, we additionally verify it belongs to the book's household — a
// caller who is a member of two households could otherwise attach a
// cross-tenant contact (RLS alone only guarantees the new loan row's own
// household_id is *a* household the caller belongs to, not necessarily the
// book's household). See tags.ts's book_tag/tagId check for the same risk.
loans.post("/", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{
    id?: string;
    bookId?: string;
    contactId?: string;
    contactName?: string;
    // id to assign the contact this request creates inline when
    // contactName (not contactId) is given — distinct from contactId,
    // which always means "reference an existing contact." See books.ts's
    // edition.id for the same "inline-created row" client-id pattern.
    newContactId?: string;
    direction?: LoanDirection;
    // Client-computed local calendar date (repo/loans.ts's todayStr()) for
    // when the loan was made. Sent explicitly rather than relying on this
    // column's `DEFAULT CURRENT_DATE` (migrations/0002_core.sql) -- that
    // default evaluates in the server/container's timezone (likely UTC),
    // which can disagree with the optimistic local PGlite row's browser-local
    // date by a day once the two converge (Minor finding, PR #15 review).
    outDate?: string;
    dueDate?: string;
  }>().catch(() => null);

  if (!body?.bookId) return c.json({ error: "bookId is required" }, 400);
  if (!body.direction || !LOAN_DIRECTION_VALUES.includes(body.direction)) {
    return c.json({ error: "direction must be 'lent_out' or 'borrowed_in'" }, 400);
  }
  // Exactly one of contactId/contactName is required. If both are supplied,
  // contactId wins (an explicit reference to an existing contact takes
  // precedence over a name that might create a duplicate).
  if (!body.contactId && !body.contactName) {
    return c.json({ error: "contactId or contactName is required" }, 400);
  }

  const result = await withUser(user.id, async (client) => {
    const { rows: bookRows } = await client.query(
      "SELECT household_id FROM book WHERE id = $1 AND deleted_at IS NULL",
      [body.bookId]
    );
    if (!bookRows[0]) return "not_found" as const;
    const householdId = bookRows[0].household_id;

    let contactId = body.contactId;
    if (contactId) {
      const { rows: contactRows } = await client.query(
        "SELECT household_id FROM contact WHERE id = $1 AND deleted_at IS NULL",
        [contactId]
      );
      if (!contactRows[0] || contactRows[0].household_id !== householdId) return "not_found" as const;
    } else {
      // Client-supplied id + upsert: see books.ts's POST / for the full
      // rationale (repo/loans.ts's optimistic local INSERT generates this
      // contact's id up front, same as its inline-edition counterpart).
      const { rows: newContact } = await client.query(
        `INSERT INTO contact (id, household_id, name, created_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
         RETURNING id`,
        [body.newContactId ?? randomUUID(), householdId, body.contactName, user.id]
      );
      contactId = newContact[0].id;
    }

    // Same client-supplied-id + upsert pattern for the loan row itself.
    const loanId = body.id ?? randomUUID();
    await client.query(
      `INSERT INTO loan (id, household_id, book_id, contact_id, direction, out_date, due_date, created_by)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, CURRENT_DATE), $7, $8)
       ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id`,
      [loanId, householdId, body.bookId, contactId, body.direction, body.outDate ?? null, body.dueDate ?? null, user.id]
    );

    const { rows } = await client.query(NESTED_SELECT + " WHERE l.id = $1 AND l.deleted_at IS NULL", [loanId]);
    return rows[0];
  }).catch((err) => {
    if ((err as { code?: string }).code === "42501") return "forbidden" as const;
    throw err;
  });

  if (result === "forbidden") return c.json({ error: "forbidden" }, 403);
  if (result === "not_found" || !result) return c.json({ error: "not found" }, 404);
  return c.json({ loan: nestLoan(result) }, 201);
});

// PATCH /api/loans/:id — body { returned_date?, due_date? }.
loans.patch("/:id", async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  const allowed = ["returned_date", "due_date"] as const;
  const sets: string[] = [];
  const params: unknown[] = [c.req.param("id")];
  let i = 2;
  for (const key of allowed) {
    if (key in body) { sets.push(`${key} = $${i}`); params.push(body[key]); i++; }
  }
  if (!sets.length) return c.json({ error: "nothing to update" }, 400);

  // Single transaction for the UPDATE and the re-select: a second, separate
  // withUser call for the re-select would open a race window where a
  // concurrent soft-delete between the two calls causes a spurious 404
  // after a successful write.
  const loanRow = await withUser(user.id, async (client) => {
    const { rows } = await client.query(
      `UPDATE loan SET ${sets.join(", ")}, updated_at = now()
       WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
      params
    );
    if (!rows[0]) return null;

    const { rows: loanRows } = await client.query(
      NESTED_SELECT + " WHERE l.id = $1 AND l.deleted_at IS NULL",
      [c.req.param("id")]
    );
    return loanRows[0] ?? null;
  });
  if (!loanRow) return c.json({ error: "not found" }, 404);
  return c.json({ loan: nestLoan(loanRow) });
});

// GET /api/loans?householdId=&active=&contactId=&bookId=
loans.get("/", async (c) => {
  const user = c.get("user");
  const householdId = c.req.query("householdId");
  if (!householdId) return c.json({ error: "householdId is required" }, 400);

  const active = c.req.query("active");
  const contactId = c.req.query("contactId");
  const bookId = c.req.query("bookId");

  const where: string[] = ["l.household_id = $1", "l.deleted_at IS NULL"];
  const params: unknown[] = [householdId];
  let i = 2;
  if (active === "true") { where.push("l.returned_date IS NULL"); }
  if (contactId) { where.push(`l.contact_id = $${i}`); params.push(contactId); i++; }
  if (bookId) { where.push(`l.book_id = $${i}`); params.push(bookId); i++; }

  const rows = await withUser(user.id, (client) =>
    client.query(
      NESTED_SELECT + ` WHERE ${where.join(" AND ")} ORDER BY l.out_date DESC`,
      params
    ).then((r) => r.rows)
  );

  return c.json({ loans: rows.map(nestLoan) });
});
