import { Hono } from "hono";
import { withUser } from "../db/tenant.js";
import { requireUser, type SessionUser } from "../middleware/session.js";

export const tags = new Hono<{ Variables: { user: SessionUser } }>();
export const bookTags = new Hono<{ Variables: { user: SessionUser } }>();

tags.use("*", requireUser);
bookTags.use("*", requireUser);

// GET /api/tags?householdId=...
tags.get("/", async (c) => {
  const user = c.get("user");
  const householdId = c.req.query("householdId");
  if (!householdId) return c.json({ error: "householdId is required" }, 400);

  const rows = await withUser(user.id, (client) =>
    client.query(
      `SELECT id, name, updated_at FROM tag
       WHERE household_id = $1 AND deleted_at IS NULL ORDER BY name`,
      [householdId]
    ).then((r) => r.rows)
  );
  return c.json({ tags: rows });
});

// POST /api/tags — body {householdId, name}. Idempotent get-or-create: a
// unique-violation on tag_live_uniq (household_id, name) is treated as
// "already exists" and returns the existing row (200) instead of an error.
tags.post("/", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ householdId?: string; name?: string }>().catch(() => ({}) as { householdId?: string; name?: string });
  if (!body.householdId || !body.name) return c.json({ error: "householdId and name required" }, 400);

  // A unique-violation aborts the transaction it happens in (Postgres
  // 25P02'd any further query in the same tx), so the get-existing fallback
  // runs in a fresh withUser call rather than inline in the same one.
  const insertResult = await withUser(user.id, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO tag (household_id, name, created_by)
       VALUES ($1, $2, $3) RETURNING id, name, updated_at`,
      [body.householdId, body.name, user.id]
    );
    return rows[0];
  }).catch((err) => {
    if ((err as { code?: string }).code === "23505") return "conflict" as const;
    if ((err as { code?: string }).code === "42501") return "forbidden" as const;
    throw err;
  });

  if (insertResult === "forbidden") return c.json({ error: "forbidden" }, 403);
  if (insertResult === "conflict") {
    const existing = await withUser(user.id, (client) =>
      client.query(
        `SELECT id, name, updated_at FROM tag
         WHERE household_id = $1 AND name = $2 AND deleted_at IS NULL`,
        [body.householdId, body.name]
      ).then((r) => r.rows[0])
    );
    if (!existing) return c.json({ error: "forbidden" }, 403);
    return c.json({ tag: existing }, 200);
  }
  return c.json({ tag: insertResult }, 201);
});

// POST /api/books/:bookId/tags — body {tagId}
bookTags.post("/:bookId/tags", async (c) => {
  const user = c.get("user");
  const bookId = c.req.param("bookId");
  const body = await c.req.json<{ tagId?: string }>().catch(() => ({}) as { tagId?: string });
  if (!body.tagId) return c.json({ error: "tagId is required" }, 400);

  const result = await withUser(user.id, async (client) => {
    const { rows: bookRows } = await client.query(
      "SELECT household_id FROM book WHERE id = $1 AND deleted_at IS NULL",
      [bookId]
    );
    if (!bookRows[0]) return "not_found" as const;
    const householdId = bookRows[0].household_id;

    const { rows } = await client.query(
      `INSERT INTO book_tag (household_id, book_id, tag_id)
       VALUES ($1, $2, $3) RETURNING id, book_id, tag_id, updated_at`,
      [householdId, bookId, body.tagId]
    );
    return rows[0];
  }).catch((err) => {
    if ((err as { code?: string }).code === "42501") return "forbidden" as const;
    if ((err as { code?: string }).code === "23505") return "conflict" as const;
    throw err;
  });

  if (result === "not_found") return c.json({ error: "not found" }, 404);
  if (result === "forbidden") return c.json({ error: "forbidden" }, 403);
  if (result === "conflict") return c.json({ error: "book already tagged" }, 409);
  return c.json({ bookTag: result }, 201);
});

// DELETE /api/books/:bookId/tags/:tagId — soft-delete the book_tag row.
bookTags.delete("/:bookId/tags/:tagId", async (c) => {
  const user = c.get("user");
  const { rowCount } = await withUser(user.id, (client) =>
    client.query(
      `UPDATE book_tag SET deleted_at = now(), updated_at = now()
       WHERE book_id = $1 AND tag_id = $2 AND deleted_at IS NULL`,
      [c.req.param("bookId"), c.req.param("tagId")]
    )
  );
  if (!rowCount) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});
