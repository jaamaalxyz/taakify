import { Hono } from "hono";
import { adminPool, safeRollback } from "../db/pool.js";
import { requireUser, type SessionUser } from "../middleware/session.js";

export const households = new Hono<{ Variables: { user: SessionUser } }>();

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
