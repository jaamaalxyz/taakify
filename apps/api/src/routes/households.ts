import { Hono } from "hono";
import { adminPool, safeRollback } from "../db/pool.js";
import { withUser } from "../db/tenant.js";
import { requireUser, type SessionUser } from "../middleware/session.js";

export const households = new Hono<{ Variables: { user: SessionUser } }>();

// GET /api/households/:id/members — the household roster. Two pools, by
// necessity: the caller's membership is authorized through withUser (RLS
// scopes `membership` to the caller's households), but the app role has no
// SELECT grant on the better-auth `user` table (CLAUDE.md: grants mirror the
// RLS surface, and `user`/`session`/`account` are privileged). So the roster
// read runs on adminPool *after* the membership check has passed — the same
// two-step privileged-op pattern as household create and invite accept.
//
// Returns {id, name, email, role}. Members seeing each other's emails is an
// intentional product decision for a family-sharing tool (narrower than it
// sounds: these are authenticated account emails of accepted members, not
// invite.email identities, which CLAUDE.md notes are informational-only).
households.get("/:id/members", requireUser, async (c) => {
  const user = c.get("user");
  const householdId = c.req.param("id");

  const isMember = await withUser(user.id, async (client) => {
    const { rows } = await client.query(
      `SELECT 1 FROM membership
       WHERE household_id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [householdId, user.id]
    );
    return rows.length > 0;
  });
  if (!isMember) return c.json({ error: "forbidden" }, 403);

  const { rows } = await adminPool.query(
    `SELECT u.id, u.name, u.email, m.role
     FROM membership m JOIN "user" u ON u.id = m.user_id
     WHERE m.household_id = $1 AND m.deleted_at IS NULL
     ORDER BY u.name`,
    [householdId]
  );
  return c.json({ members: rows });
});

// Service operation on the privileged pool: a brand-new household has no
// members yet, so no RLS path could authorize these inserts.
households.post("/", requireUser, async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ name?: string }>().catch(() => ({}) as { name?: string });
  const name = body.name?.trim();
  if (!name) return c.json({ error: "name is required" }, 400);

  const client = await adminPool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      "INSERT INTO household (name) VALUES ($1) RETURNING id, name, plan", [name]
    );
    await client.query(
      "INSERT INTO membership (household_id, user_id, role) VALUES ($1, $2, 'owner')",
      [rows[0].id, user.id]
    );
    await client.query("COMMIT");
    return c.json({ household: rows[0] }, 201);
  } catch (err) {
    await safeRollback(client);
    throw err;
  } finally {
    client.release();
  }
});
