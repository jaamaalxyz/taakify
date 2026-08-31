import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { withUser } from "../db/tenant.js";
import { type SessionUser } from "../middleware/session.js";
import type { Ownership, WishlistPriority } from "@taakify/shared";

export const books = new Hono<{ Variables: { user: SessionUser } }>();

// GET /api/books?householdId=...&q=...&ownership=...&status=...&tag=...&shelf_id=...&offset=...&limit=...
books.get("/", async (c) => {
  const user = c.get("user");
  const householdId = c.req.query("householdId");
  if (!householdId) return c.json({ error: "householdId is required" }, 400);

  const rawQ = (c.req.query("q") ?? "").trim();
  const ownership = c.req.query("ownership");
  const status = c.req.query("status");
  const tag = c.req.query("tag");
  const shelfId = c.req.query("shelf_id");
  // Capped at 200 to prevent abuse; default 100 matches the previous
  // hard-coded LIMIT so existing callers that don't pass limit/offset are
  // unaffected. NaN (bad input) falls back to the default via `||`.
  const limit = Math.min(Number(c.req.query("limit")) || 100, 200);
  const offset = Math.max(Number(c.req.query("offset")) || 0, 0);

  const rows = await withUser(user.id, async (client) => {
    // Dynamic filters built from whitelisted params; values bound as params.
    const where: string[] = ["b.household_id = $1", "b.deleted_at IS NULL"];
    const params: unknown[] = [householdId];
    let i = 2;
    if (rawQ) {
      // Escape LIKE metacharacters in user input so a literal "%"/"_" in a
      // search term doesn't act as an unintended wildcard.
      const escaped = rawQ.toLowerCase().replace(/[\\%_]/g, "\\$&");
      where.push(`(lower(e.title) LIKE $${i} ESCAPE '\\' OR lower(e.authors) LIKE $${i} ESCAPE '\\')`);
      params.push(`%${escaped}%`); i++;
    }
    if (ownership) { where.push(`b.ownership = $${i}`); params.push(ownership); i++; }
    if (shelfId) { where.push(`b.shelf_id = $${i}`); params.push(shelfId); i++; }
    if (status) {
      where.push(`EXISTS (SELECT 1 FROM reading_status rs WHERE rs.book_id = b.id AND rs.user_id = $${i} AND rs.status = $${i + 1} AND rs.deleted_at IS NULL)`);
      params.push(user.id, status); i += 2;
    }
    if (tag) {
      where.push(`EXISTS (SELECT 1 FROM book_tag bt JOIN tag t ON t.id = bt.tag_id WHERE bt.book_id = b.id AND t.name = $${i} AND bt.deleted_at IS NULL)`);
      params.push(tag); i++;
    }
    params.push(limit, offset);
    const { rows } = await client.query(
      `SELECT b.id, b.ownership, b.format, b.shelf_id, b.do_not_lend, b.wishlist_priority, b.notes,
              e.id AS edition_id, e.title, e.authors, e.cover_url, e.isbn, e.language
       FROM book b JOIN edition e ON e.id = b.edition_id
       WHERE ${where.join(" AND ")}
       ORDER BY e.title LIMIT $${i} OFFSET $${i + 1}`,
      params
    );
    return rows;
  });

  // Transform flat rows to nested edition structure
  const books = rows.map((row: any) => ({
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
    }
  }));

  return c.json({ books });
});

// POST /api/books — creates an edition row when editionId is absent.
books.post("/", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{
    id?: string;
    householdId: string;
    editionId?: string;
    edition?: { id?: string; isbn?: string; title: string; authors?: string; language?: string; cover_url?: string };
    ownership: Ownership;
    shelf_id?: string;
    do_not_lend?: boolean;
    wishlist_priority?: WishlistPriority;
    notes?: string;
  }>().catch(() => null);
  if (!body?.householdId || !body?.ownership) return c.json({ error: "householdId and ownership required" }, 400);
  if (!body.editionId && !body.edition?.title) return c.json({ error: "editionId or edition.title required" }, 400);

  const result = await withUser(user.id, async (client) => {
    // A caller can belong to multiple households; without this check they
    // could create a book in household A pointing at household B's shelf
    // (RLS only scopes the new book row's own household_id to *a* household
    // the caller belongs to, not necessarily the shelf's household). Same
    // class of check as tags.ts's book_tag/tagId check and loans.ts's
    // loan/contactId check.
    if (body.shelf_id) {
      const { rows: shelfRows } = await client.query(
        "SELECT household_id FROM shelf WHERE id = $1 AND deleted_at IS NULL",
        [body.shelf_id]
      );
      if (!shelfRows[0] || shelfRows[0].household_id !== body.householdId) return "not_found" as const;
    }

    let editionId = body.editionId;
    if (!editionId && body.edition) {
      // Client-supplied id (repo/books.ts's optimistic local edition INSERT
      // generates one so the mirror row and the server row converge on sync
      // — see task-6-report.md's "no client-supplied id" gap and its fix).
      // ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id is a deliberate
      // no-op (id is the conflict key); its only purpose is making this an
      // upsert so RETURNING always yields exactly one row whether this is a
      // fresh insert or a retry of an outbox row that already landed.
      const e = await client.query(
        `INSERT INTO edition (id, isbn, title, authors, language, cover_url)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
         RETURNING id, isbn, title, authors, language, cover_url`,
        [body.edition.id ?? randomUUID(), body.edition.isbn ?? null, body.edition.title, body.edition.authors ?? "", body.edition.language ?? null, body.edition.cover_url ?? null]
      );
      editionId = e.rows[0].id;
    }
    // Fetch edition data regardless of which path (inline create or reuse)
    const { rows: editionRows } = await client.query(
      `SELECT id, isbn, title, authors, language, cover_url FROM edition WHERE id = $1`,
      [editionId]
    );
    if (!editionRows[0]) return null;
    const editionData = editionRows[0];

    // Same client-supplied-id + upsert pattern as the edition insert above.
    const bookId = body.id ?? randomUUID();
    const { rowCount } = await client.query(
      `INSERT INTO book (id, household_id, edition_id, ownership, shelf_id, do_not_lend, wishlist_priority, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id`,
      [bookId, body.householdId, editionId, body.ownership, body.shelf_id ?? null, body.do_not_lend ?? false, body.wishlist_priority ?? null, body.notes ?? null, user.id]
    );
    if (!rowCount) return null;

    // Re-select the created book with edition to return full nested structure
    const { rows: bookRows } = await client.query(
      `SELECT b.id, b.ownership, b.format, b.shelf_id, b.do_not_lend, b.wishlist_priority, b.notes, b.updated_at,
              e.id AS edition_id, e.title, e.authors, e.cover_url, e.isbn, e.language
       FROM book b JOIN edition e ON e.id = b.edition_id
       WHERE b.id = $1 AND b.deleted_at IS NULL`,
      [bookId]
    );
    if (!bookRows[0]) return null;
    return bookRows[0];
  }).catch((err) => {
    // RLS insert policy rejects cross-household writes -> Postgres raises SQLSTATE 42501.
    // Match on err.code, not err.message text (message wording isn't a stable contract).
    if ((err as { code?: string }).code === "42501") return null;
    throw err;
  });
  if (result === "not_found") return c.json({ error: "not found" }, 404);
  if (!result) return c.json({ error: "forbidden" }, 403);
  const book = {
    id: result.id,
    household_id: body.householdId,
    edition_id: result.edition_id,
    ownership: result.ownership,
    format: result.format,
    shelf_id: result.shelf_id,
    do_not_lend: result.do_not_lend,
    wishlist_priority: result.wishlist_priority,
    notes: result.notes,
    updated_at: result.updated_at,
    edition: {
      id: result.edition_id,
      title: result.title,
      authors: result.authors ?? "",
      cover_url: result.cover_url ?? null,
      isbn: result.isbn ?? null,
      language: result.language ?? null,
    }
  };
  return c.json({ book }, 201);
});

// GET /api/books/:id
books.get("/:id", async (c) => {
  const user = c.get("user");
  const { rows } = await withUser(user.id, (client) =>
    client.query(
      `SELECT b.id, b.ownership, b.format, b.shelf_id, b.do_not_lend, b.wishlist_priority, b.notes, b.updated_at,
              e.id AS edition_id, e.title, e.authors, e.cover_url, e.isbn, e.language
       FROM book b JOIN edition e ON e.id = b.edition_id
       WHERE b.id = $1 AND b.deleted_at IS NULL`,
      [c.req.param("id")]
    )
  );
  if (!rows[0]) return c.json({ error: "not found" }, 404);
  const row = rows[0];
  const book = {
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
    }
  };
  return c.json({ book });
});

// PATCH /api/books/:id — move shelf, edit fields.
books.patch("/:id", async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  const allowed = ["shelf_id", "ownership", "do_not_lend", "wishlist_priority", "notes"] as const;
  const sets: string[] = [];
  const params: unknown[] = [c.req.param("id")];
  let i = 2;
  for (const key of allowed) {
    if (key in body) { sets.push(`${key} = $${i}`); params.push(body[key]); i++; }
  }
  if (!sets.length) return c.json({ error: "nothing to update" }, 400);

  // Single transaction for the household check, the UPDATE, and the
  // re-select: a second, separate withUser call for the re-select would
  // open a race window where a concurrent soft-delete between the two
  // calls causes a spurious 404 after a successful write.
  const result = await withUser(user.id, async (client) => {
    // A caller can belong to multiple households; without this check they
    // could move a book into another household's shelf (RLS only scopes
    // the book row's own household_id, not which household owns the
    // shelf being pointed at). Same class of check as the POST handler.
    if ("shelf_id" in body && body.shelf_id) {
      const { rows: bookRows } = await client.query(
        "SELECT household_id FROM book WHERE id = $1 AND deleted_at IS NULL",
        [c.req.param("id")]
      );
      if (!bookRows[0]) return "not_found" as const;
      const { rows: shelfRows } = await client.query(
        "SELECT household_id FROM shelf WHERE id = $1 AND deleted_at IS NULL",
        [body.shelf_id]
      );
      if (!shelfRows[0] || shelfRows[0].household_id !== bookRows[0].household_id) return "not_found" as const;
    }

    const { rows } = await client.query(
      `UPDATE book SET ${sets.join(", ")}, updated_at = now()
       WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
      params
    );
    if (!rows[0]) return "not_found" as const;

    // Re-select the updated book with edition to return nested structure
    const { rows: bookRows } = await client.query(
      `SELECT b.id, b.ownership, b.format, b.shelf_id, b.do_not_lend, b.wishlist_priority, b.notes, b.updated_at,
              e.id AS edition_id, e.title, e.authors, e.cover_url, e.isbn, e.language
       FROM book b JOIN edition e ON e.id = b.edition_id
       WHERE b.id = $1 AND b.deleted_at IS NULL`,
      [c.req.param("id")]
    );
    return bookRows[0] ?? ("not_found" as const);
  });
  if (result === "not_found" || !result) return c.json({ error: "not found" }, 404);
  const row = result;
  const book = {
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
    }
  };
  return c.json({ book });
});

// DELETE /api/books/:id — soft delete. Also closes out any of the book's
// currently-active loans (in the same transaction) so a deleted book
// doesn't leave a loan stuck "active" with a link that now 404s.
books.delete("/:id", async (c) => {
  const user = c.get("user");
  const deleted = await withUser(user.id, async (client) => {
    const { rowCount } = await client.query(
      "UPDATE book SET deleted_at = now(), updated_at = now() WHERE id = $1 AND deleted_at IS NULL",
      [c.req.param("id")]
    );
    if (!rowCount) return false;
    await client.query(
      `UPDATE loan SET returned_date = CURRENT_DATE, updated_at = now()
       WHERE book_id = $1 AND returned_date IS NULL AND deleted_at IS NULL`,
      [c.req.param("id")]
    );
    return true;
  });
  if (!deleted) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});
