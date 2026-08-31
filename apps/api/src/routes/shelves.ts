import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { withUser } from "../db/tenant.js";
import { requireUser, type SessionUser } from "../middleware/session.js";

export const bookcases = new Hono<{ Variables: { user: SessionUser } }>();
export const shelves = new Hono<{ Variables: { user: SessionUser } }>();

bookcases.use("*", requireUser);
shelves.use("*", requireUser);

// GET /api/bookcases?householdId=... — each bookcase nests its live shelves.
bookcases.get("/", async (c) => {
  const user = c.get("user");
  const householdId = c.req.query("householdId");
  if (!householdId) return c.json({ error: "householdId is required" }, 400);

  const rows = await withUser(user.id, async (client) => {
    const { rows } = await client.query(
      `SELECT b.id, b.name, b.updated_at,
              s.id AS shelf_id, s.position, s.label, s.updated_at AS shelf_updated_at
       FROM bookcase b
       LEFT JOIN shelf s ON s.bookcase_id = b.id AND s.deleted_at IS NULL
       WHERE b.household_id = $1 AND b.deleted_at IS NULL
       ORDER BY b.name, s.position`,
      [householdId]
    );
    return rows;
  });

  const byId = new Map<string, any>();
  for (const row of rows) {
    if (!byId.has(row.id)) {
      byId.set(row.id, { id: row.id, name: row.name, updated_at: row.updated_at, shelves: [] });
    }
    if (row.shelf_id) {
      byId.get(row.id).shelves.push({
        id: row.shelf_id,
        position: row.position,
        label: row.label,
        updated_at: row.shelf_updated_at,
      });
    }
  }
  return c.json({ bookcases: Array.from(byId.values()) });
});

// POST /api/bookcases — body {householdId, name}
bookcases.post("/", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ id?: string; householdId?: string; name?: string }>().catch(() => ({}) as { id?: string; householdId?: string; name?: string });
  if (!body.householdId || !body.name) return c.json({ error: "householdId and name required" }, 400);

  const result = await withUser(user.id, async (client) => {
    // Client-supplied id + upsert: see books.ts's POST / for the full
    // rationale (repo/shelves.ts's optimistic local INSERT generates the
    // id up front so the mirror row and the server row converge on sync).
    const { rows } = await client.query(
      `INSERT INTO bookcase (id, household_id, name, created_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
       RETURNING id, name, updated_at`,
      [body.id ?? randomUUID(), body.householdId, body.name, user.id]
    );
    return rows[0];
  }).catch((err) => {
    if ((err as { code?: string }).code === "42501") return null;
    throw err;
  });
  if (!result) return c.json({ error: "forbidden" }, 403);
  return c.json({ bookcase: { ...result, shelves: [] } }, 201);
});

// POST /api/bookcases/:id/shelves — position auto-computed as max+1 within the bookcase.
bookcases.post("/:id/shelves", async (c) => {
  const user = c.get("user");
  const bookcaseId = c.req.param("id");
  const body = await c.req.json<{ id?: string; label?: string }>().catch(() => ({}) as { id?: string; label?: string });

  const result = await withUser(user.id, async (client) => {
    // Lock the parent bookcase row first so concurrent POSTs to the same
    // bookcase serialize: the second transaction blocks here until the
    // first commits, and then sees the updated MAX(position) below. Without
    // this, two concurrent requests can both read the same MAX(position)
    // under READ COMMITTED and insert duplicate positions.
    const { rows: bcRows } = await client.query(
      "SELECT id, household_id FROM bookcase WHERE id = $1 AND deleted_at IS NULL FOR UPDATE",
      [bookcaseId]
    );
    if (!bcRows[0]) return "not_found" as const;
    const householdId = bcRows[0].household_id;

    // If this is a retry of an outbox row whose shelf already landed (same
    // client-supplied id), skip recomputing MAX(position) entirely — an
    // ON CONFLICT DO UPDATE below would otherwise leave the row's real
    // position untouched anyway, but recomputing a *new* position here
    // first would be wasted work (and, if some other shelf was concurrently
    // deleted, subtly wrong to compute even though it's discarded).
    const shelfId = body.id ?? randomUUID();
    if (body.id) {
      const { rows: existing } = await client.query(
        "SELECT id, position, label, updated_at FROM shelf WHERE id = $1 AND deleted_at IS NULL",
        [shelfId]
      );
      if (existing[0]) return existing[0];
    }

    const { rows: posRows } = await client.query(
      "SELECT COALESCE(MAX(position), 0) + 1 AS next_position FROM shelf WHERE bookcase_id = $1 AND deleted_at IS NULL",
      [bookcaseId]
    );
    const position = posRows[0].next_position;

    // Client-supplied id + upsert: see books.ts's POST / for the full
    // rationale.
    const { rows } = await client.query(
      `INSERT INTO shelf (id, household_id, bookcase_id, position, label, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
       RETURNING id, position, label, updated_at`,
      [shelfId, householdId, bookcaseId, position, body.label ?? null, user.id]
    );
    return rows[0];
  }).catch((err) => {
    if ((err as { code?: string }).code === "42501") return "forbidden" as const;
    throw err;
  });

  if (result === "not_found") return c.json({ error: "not found" }, 404);
  if (result === "forbidden") return c.json({ error: "forbidden" }, 403);
  return c.json({ shelf: result }, 201);
});

// PATCH /api/shelves/:id — edit label/position.
shelves.patch("/:id", async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  const allowed = ["label", "position"] as const;
  const sets: string[] = [];
  const params: unknown[] = [c.req.param("id")];
  let i = 2;
  for (const key of allowed) {
    if (key in body) { sets.push(`${key} = $${i}`); params.push(body[key]); i++; }
  }
  if (!sets.length) return c.json({ error: "nothing to update" }, 400);

  // position is an `int` column — without this guard a non-numeric or
  // non-integer value (e.g. "abc", 1.5) reaches Postgres and surfaces as an
  // opaque 500 (invalid input syntax / 22P02). Validate it here so bad input
  // returns a clean 400, mirroring the inline enum checks in loans.ts and
  // reading-status.ts rather than introducing a validation library.
  if ("position" in body) {
    const p = (body as { position: unknown }).position;
    if (typeof p !== "number" || !Number.isInteger(p) || p < 1) {
      return c.json({ error: "position must be a positive integer" }, 400);
    }
  }

  const { rows } = await withUser(user.id, (client) =>
    client.query(
      `UPDATE shelf SET ${sets.join(", ")}, updated_at = now()
       WHERE id = $1 AND deleted_at IS NULL RETURNING id, position, label, updated_at`,
      params
    )
  );
  if (!rows[0]) return c.json({ error: "not found" }, 404);
  return c.json({ shelf: rows[0] });
});

// DELETE /api/shelves/:id — soft delete.
shelves.delete("/:id", async (c) => {
  const user = c.get("user");
  const { rowCount } = await withUser(user.id, (client) =>
    client.query(
      "UPDATE shelf SET deleted_at = now(), updated_at = now() WHERE id = $1 AND deleted_at IS NULL",
      [c.req.param("id")]
    )
  );
  if (!rowCount) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});
