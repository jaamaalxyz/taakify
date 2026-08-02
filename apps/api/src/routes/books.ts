import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { withUser } from "../db/tenant.js";
import { requireUser, type SessionUser } from "../middleware/session.js";

export const books = new Hono<{ Variables: { user: SessionUser } }>();

books.use("*", requireUser);

// GET /api/books?householdId=...&q=...&ownership=...&status=...&tag=...&shelf_id=...
books.get("/", async (c) => {
  const user = c.get("user");
  const householdId = c.req.query("householdId");
  if (!householdId) return c.json({ error: "householdId is required" }, 400);

  const q = `%${(c.req.query("q") ?? "").toLowerCase()}%`;
  const ownership = c.req.query("ownership");
  const status = c.req.query("status");
  const tag = c.req.query("tag");
  const shelfId = c.req.query("shelf_id");

  const rows = await withUser(user.id, async (client) => {
    // Dynamic filters built from whitelisted params; values bound as params.
    const where: string[] = ["b.household_id = $1", "b.deleted_at IS NULL"];
    const params: unknown[] = [householdId];
    let i = 2;
    if (q) { where.push(`(lower(e.title) LIKE $${i} OR lower(e.authors) LIKE $${i})`); params.push(q); i++; }
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
    const { rows } = await client.query(
      `SELECT b.id, b.ownership, b.format, b.shelf_id, b.do_not_lend, b.wishlist_priority, b.notes,
              e.id AS edition_id, e.title, e.authors, e.cover_url, e.isbn, e.language
       FROM book b JOIN edition e ON e.id = b.edition_id
       WHERE ${where.join(" AND ")}
       ORDER BY e.title LIMIT 100`,
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
    householdId: string;
    editionId?: string;
    edition?: { isbn?: string; title: string; authors?: string; language?: string; cover_url?: string };
    ownership: "owned" | "borrowed_in" | "wishlist";
    shelf_id?: string;
    do_not_lend?: boolean;
    wishlist_priority?: "high" | "medium" | "low";
    notes?: string;
  }>().catch(() => null);
  if (!body?.householdId || !body?.ownership) return c.json({ error: "householdId and ownership required" }, 400);
  if (!body.editionId && !body.edition?.title) return c.json({ error: "editionId or edition.title required" }, 400);

  const result = await withUser(user.id, async (client) => {
    let editionId = body.editionId;
    if (!editionId && body.edition) {
      const e = await client.query(
        `INSERT INTO edition (id, isbn, title, authors, language, cover_url)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, isbn, title, authors, language, cover_url`,
        [randomUUID(), body.edition.isbn ?? null, body.edition.title, body.edition.authors ?? "", body.edition.language ?? null, body.edition.cover_url ?? null]
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

    const bookId = randomUUID();
    const { rowCount } = await client.query(
      `INSERT INTO book (id, household_id, edition_id, ownership, shelf_id, do_not_lend, wishlist_priority, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
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
  const { rows } = await withUser(user.id, (client) =>
    client.query(
      `UPDATE book SET ${sets.join(", ")}, updated_at = now()
       WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
      params
    )
  );
  if (!rows[0]) return c.json({ error: "not found" }, 404);

  // Re-select the updated book with edition to return nested structure
  const { rows: bookRows } = await withUser(user.id, (client) =>
    client.query(
      `SELECT b.id, b.ownership, b.format, b.shelf_id, b.do_not_lend, b.wishlist_priority, b.notes, b.updated_at,
              e.id AS edition_id, e.title, e.authors, e.cover_url, e.isbn, e.language
       FROM book b JOIN edition e ON e.id = b.edition_id
       WHERE b.id = $1 AND b.deleted_at IS NULL`,
      [c.req.param("id")]
    )
  );
  if (!bookRows[0]) return c.json({ error: "not found" }, 404);
  const row = bookRows[0];
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

// DELETE /api/books/:id — soft delete.
books.delete("/:id", async (c) => {
  const user = c.get("user");
  const { rowCount } = await withUser(user.id, (client) =>
    client.query(
      "UPDATE book SET deleted_at = now(), updated_at = now() WHERE id = $1 AND deleted_at IS NULL",
      [c.req.param("id")]
    )
  );
  if (!rowCount) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});
