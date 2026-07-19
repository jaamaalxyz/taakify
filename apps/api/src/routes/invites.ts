import { Hono } from "hono";
import { randomBytes } from "node:crypto";
import { adminPool, safeRollback } from "../db/pool.js";
import { withUser } from "../db/tenant.js";
import { requireUser, type SessionUser } from "../middleware/session.js";

const INVITE_TTL_DAYS = 7;

// Mounted at /api/households/:householdId/invites
export const householdInvites = new Hono<{ Variables: { user: SessionUser } }>();

householdInvites.post("/", requireUser, async (c) => {
  const user = c.get("user");
  const householdId = c.req.param("householdId");
  const body = await c.req.json<{ email?: string; role?: string }>().catch(() => ({}) as never);
  const email = body.email?.trim().toLowerCase();
  const role = body.role === "admin" ? "admin" : body.role === "member" ? "member" : null;
  if (!email || !role) return c.json({ error: "email and role (admin|member) required" }, 400);

  const token = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86400_000);

  // One transaction: the role check and the insert can't be split by a
  // concurrent role change. RLS scopes both to the caller's households.
  const created = await withUser(user.id, async (client) => {
    const { rows } = await client.query(
      `SELECT role FROM membership
       WHERE household_id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [householdId, user.id]
    );
    if (rows[0]?.role !== "owner" && rows[0]?.role !== "admin") return false;
    await client.query(
      `INSERT INTO invite (household_id, email, role, token, expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [householdId, email, role, token, expiresAt, user.id]
    );
    return true;
  });
  if (!created) return c.json({ error: "forbidden" }, 403);
  return c.json({ token, url: `/invite/${token}`, expiresAt }, 201);
});

// Mounted at /api/invites
export const invites = new Hono<{ Variables: { user: SessionUser } }>();

// Public: lets the invite landing page show what's being joined.
// Privileged pool: the viewer has no membership yet.
invites.get("/:token", async (c) => {
  const { rows } = await adminPool.query(
    `SELECT i.email, i.role, i.expires_at, i.accepted_at, h.name AS household_name
     FROM invite i JOIN household h ON h.id = i.household_id
     WHERE i.token = $1 AND i.deleted_at IS NULL`,
    [c.req.param("token")]
  );
  const invite = rows[0];
  if (!invite) return c.json({ error: "not found" }, 404);
  if (invite.accepted_at) return c.json({ error: "already accepted" }, 410);
  if (new Date(invite.expires_at) < new Date()) return c.json({ error: "expired" }, 410);
  return c.json({ householdName: invite.household_name, email: invite.email, role: invite.role });
});

// Privileged service op: the accepting user is not yet a member.
invites.post("/:token/accept", requireUser, async (c) => {
  const user = c.get("user");
  const client = await adminPool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT id, household_id, role, expires_at, accepted_at FROM invite
       WHERE token = $1 AND deleted_at IS NULL FOR UPDATE`,
      [c.req.param("token")]
    );
    const invite = rows[0];
    if (!invite) { await safeRollback(client); return c.json({ error: "not found" }, 404); }
    if (invite.accepted_at) { await safeRollback(client); return c.json({ error: "already accepted" }, 410); }
    if (new Date(invite.expires_at) < new Date()) { await safeRollback(client); return c.json({ error: "expired" }, 410); }

    // Acceptance is token-authorized: invite.email is informational only (links
    // are hand-shared; the invitee may sign up under a different address).
    // Revisit email-binding when public SaaS signup lands.
    await client.query(
      `INSERT INTO membership (household_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (household_id, user_id) WHERE deleted_at IS NULL DO NOTHING`,
      [invite.household_id, user.id, invite.role]
    );
    await client.query(
      "UPDATE invite SET accepted_at = now(), updated_at = now() WHERE id = $1",
      [invite.id]
    );
    await client.query("COMMIT");
    return c.json({ householdId: invite.household_id });
  } catch (err) {
    await safeRollback(client);
    throw err;
  } finally {
    client.release();
  }
});
