import { Hono } from "hono";
import { requireUser, type SessionUser } from "../middleware/session.js";
import { withUser } from "../db/tenant.js";

// Same 8 household-scoped tables apps/web/src/lib/sync/shape.ts subscribes
// to, plus the global `edition` catalog -- mirrors bootstrap.ts's
// TENANT_TABLE_COLUMNS allowlist. Never forward a client-supplied table name
// that isn't in this set.
const TENANT_TABLES = new Set([
  "bookcase",
  "shelf",
  "book",
  "reading_status",
  "tag",
  "book_tag",
  "contact",
  "loan",
]);
const ALLOWED_TABLES = new Set([...TENANT_TABLES, "edition"]);

// Electric's own protocol query params (offset/handle/live/cursor), forwarded
// through unchanged -- see @electric-sql/client's ShapeStream, which appends
// these on every request as the shape catches up / long-polls for more.
const ELECTRIC_PROTOCOL_PARAMS = ["offset", "handle", "live", "cursor"];

function electricInternalUrl(): string {
  return process.env.ELECTRIC_INTERNAL_URL ?? "http://localhost:3010/v1/shape";
}

export const syncShape = new Hono<{ Variables: { user: SessionUser } }>();

syncShape.use("*", requireUser);

// GET /api/sync/shape?table=<table>&householdId=<id>&<electric protocol params>
//
// Never trusts a client-supplied `where`/`params[1]` (a client could set
// `household_id` to any other household's id) -- for tenant tables, the
// `where` clause forwarded to Electric is always built server-side from a
// membership-verified householdId. `edition` is the one global, unfiltered
// table (see CLAUDE.md), so it's forwarded with no where clause at all,
// matching shape.ts's existing subscribeTable("edition", undefined, undefined).
syncShape.get("/", async (c) => {
  const user = c.get("user");
  const table = c.req.query("table");
  if (!table || !ALLOWED_TABLES.has(table)) {
    return c.json({ error: "unknown table" }, 400);
  }

  const upstream = new URL(electricInternalUrl());
  for (const key of ELECTRIC_PROTOCOL_PARAMS) {
    const value = c.req.query(key);
    if (value !== undefined) upstream.searchParams.set(key, value);
  }
  upstream.searchParams.set("table", table);
  upstream.searchParams.set("replica", "full");

  if (TENANT_TABLES.has(table)) {
    const householdId = c.req.query("householdId");
    if (!householdId) return c.json({ error: "householdId is required" }, 400);

    // RLS's membership_select policy (migrations/0003_rls.sql) already scopes
    // this to households app_user_households() returns for the caller, so a
    // non-member gets zero rows here regardless of what householdId they ask
    // for -- same trust model as bootstrap.ts, but here the result gates
    // whether we proceed at all rather than just scoping a query.
    const isMember = await withUser(user.id, async (client) => {
      const { rows } = await client.query(
        `SELECT 1 FROM membership WHERE household_id = $1 AND deleted_at IS NULL LIMIT 1`,
        [householdId]
      );
      return rows.length > 0;
    });
    if (!isMember) return c.json({ error: "forbidden" }, 403);

    upstream.searchParams.set("where", "household_id = $1");
    upstream.searchParams.set("params[1]", householdId);
  }

  const upstreamRes = await fetch(upstream.toString());

  // Forward Electric's response verbatim (status, body, and its
  // electric-* protocol headers the client SDK needs to keep streaming) --
  // excluding hop-by-hop headers that no longer apply once fetch has
  // already decoded the upstream response.
  const headers = new Headers();
  upstreamRes.headers.forEach((value, key) => {
    if (["content-encoding", "content-length", "transfer-encoding", "connection"].includes(key)) return;
    headers.set(key, value);
  });

  return new Response(upstreamRes.body, { status: upstreamRes.status, headers });
});
