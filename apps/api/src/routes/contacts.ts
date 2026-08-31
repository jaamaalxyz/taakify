import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { withUser } from "../db/tenant.js";
import { requireUser, type SessionUser } from "../middleware/session.js";

export const contacts = new Hono<{ Variables: { user: SessionUser } }>();

contacts.use("*", requireUser);

// GET /api/contacts?householdId=...
contacts.get("/", async (c) => {
  const user = c.get("user");
  const householdId = c.req.query("householdId");
  if (!householdId) return c.json({ error: "householdId is required" }, 400);

  const rows = await withUser(user.id, (client) =>
    client.query(
      `SELECT id, name, phone, email, linked_user_id, updated_at FROM contact
       WHERE household_id = $1 AND deleted_at IS NULL ORDER BY name`,
      [householdId]
    ).then((r) => r.rows)
  );
  return c.json({ contacts: rows });
});

// POST /api/contacts — body {householdId, name, phone?, email?}
contacts.post("/", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{
    id?: string;
    householdId?: string;
    name?: string;
    phone?: string;
    email?: string;
  }>().catch(() => null);
  if (!body?.householdId || !body?.name) return c.json({ error: "householdId and name required" }, 400);

  const result = await withUser(user.id, async (client) => {
    // Client-supplied id + upsert: see books.ts's POST / for the full
    // rationale.
    const { rows } = await client.query(
      `INSERT INTO contact (id, household_id, name, phone, email, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
       RETURNING id, name, phone, email, linked_user_id, updated_at`,
      [body.id ?? randomUUID(), body.householdId, body.name, body.phone ?? null, body.email ?? null, user.id]
    );
    return rows[0];
  }).catch((err) => {
    if ((err as { code?: string }).code === "42501") return null;
    throw err;
  });
  if (!result) return c.json({ error: "forbidden" }, 403);
  return c.json({ contact: result }, 201);
});

// PATCH /api/contacts/:id
contacts.patch("/:id", async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  const allowed = ["name", "phone", "email"] as const;
  const sets: string[] = [];
  const params: unknown[] = [c.req.param("id")];
  let i = 2;
  for (const key of allowed) {
    if (key in body) { sets.push(`${key} = $${i}`); params.push(body[key]); i++; }
  }
  if (!sets.length) return c.json({ error: "nothing to update" }, 400);

  const { rows } = await withUser(user.id, (client) =>
    client.query(
      `UPDATE contact SET ${sets.join(", ")}, updated_at = now()
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING id, name, phone, email, linked_user_id, updated_at`,
      params
    )
  );
  if (!rows[0]) return c.json({ error: "not found" }, 404);
  return c.json({ contact: rows[0] });
});

// DELETE /api/contacts/:id — soft delete.
contacts.delete("/:id", async (c) => {
  const user = c.get("user");
  const { rowCount } = await withUser(user.id, (client) =>
    client.query(
      "UPDATE contact SET deleted_at = now(), updated_at = now() WHERE id = $1 AND deleted_at IS NULL",
      [c.req.param("id")]
    )
  );
  if (!rowCount) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});
