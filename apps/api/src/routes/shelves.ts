import { Hono } from "hono";
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
  const body = await c.req.json<{ householdId?: string; name?: string }>().catch(() => ({}) as { householdId?: string; name?: string });
  if (!body.householdId || !body.name) return c.json({ error: "householdId and name required" }, 400);

  const result = await withUser(user.id, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO bookcase (household_id, name, created_by)
       VALUES ($1, $2, $3) RETURNING id, name, updated_at`,
      [body.householdId, body.name, user.id]
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
  const body = await c.req.json<{ label?: string }>().catch(() => ({}) as { label?: string });

  const result = await withUser(user.id, async (client) => {
    const { rows: bcRows } = await client.query(
      "SELECT id, household_id FROM bookcase WHERE id = $1 AND deleted_at IS NULL",
      [bookcaseId]
    );
    if (!bcRows[0]) return "not_found" as const;
    const householdId = bcRows[0].household_id;

    const { rows: posRows } = await client.query(
      "SELECT COALESCE(MAX(position), 0) + 1 AS next_position FROM shelf WHERE bookcase_id = $1 AND deleted_at IS NULL",
      [bookcaseId]
    );
    const position = posRows[0].next_position;

    const { rows } = await client.query(
      `INSERT INTO shelf (household_id, bookcase_id, position, label, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, position, label, updated_at`,
      [householdId, bookcaseId, position, body.label ?? null, user.id]
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
