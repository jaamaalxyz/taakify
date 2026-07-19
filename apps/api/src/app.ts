import { Hono } from "hono";
import { auth } from "./auth.js";
import { requireUser } from "./middleware/session.js";
import { withUser } from "./db/tenant.js";
import { households } from "./routes/households.js";
import { householdInvites, invites } from "./routes/invites.js";

export const app = new Hono();

app.get("/api/health", (c) => c.json({ ok: true }));

// better-auth does its own method dispatch; forward every verb so OAuth
// callbacks and sign-out aren't 404'd before reaching it.
app.all("/api/auth/*", (c) => auth.handler(c.req.raw));

app.get("/api/me", requireUser, async (c) => {
  const user = c.get("user");
  const memberships = await withUser(user.id, async (client) => {
    const { rows } = await client.query(
      `SELECT m.household_id, m.role, h.name AS household_name
       FROM membership m JOIN household h ON h.id = m.household_id
       WHERE m.user_id = current_setting('app.user_id', true)
         AND m.deleted_at IS NULL AND h.deleted_at IS NULL`
    );
    return rows;
  });
  return c.json({ user: { id: user.id, email: user.email, name: user.name }, memberships });
});

app.route("/api/households", households);
app.route("/api/households/:householdId/invites", householdInvites);
app.route("/api/invites", invites);
