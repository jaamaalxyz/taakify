# Electric Shape Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** close the cross-household data leak where the browser talks to Electric's shape endpoint directly with a client-built `household_id` filter, by routing all shape requests through a new authenticated API proxy that derives the household id from the caller's session instead of trusting the client.

**Architecture:** add `GET /api/sync/shape` to `apps/api` — `requireUser`, validate `table` against the same tenant-table allowlist `bootstrap.ts` already uses, verify household membership via `withUser` (RLS already scopes the membership check), then forward the request to Electric's internal-only endpoint with a server-constructed `where`/`params` clause, streaming Electric's response (body + headers) straight back. `apps/web/src/lib/sync/shape.ts` is updated to call this proxy instead of Electric directly, passing `householdId` as a plain param instead of building its own `where` clause, and using a custom `fetchClient` so the session cookie reaches the proxy.

**Tech Stack:** Hono (API), `@electric-sql/client`'s `ShapeStream` (web), Vitest for both workspaces.

**Spec:** `docs/superpowers/specs/2026-09-08-taakify-public-mvp-launch-design.md` (§3 "Electric shape proxy" section)

## Global Constraints

- Never trust a client-supplied `household_id`/`where` value when forwarding to Electric — the server must derive it from the authenticated session's verified membership, per the spec's stated problem.
- `table` must be validated against an explicit allowlist (the same 8 tenant tables + `edition` that `bootstrap.ts`'s `TENANT_TABLE_COLUMNS` and `shape.ts`'s `TENANT_TABLES` already enumerate) — never forward an arbitrary client-supplied table name to Electric.
- Match existing code conventions exactly: ESM `.js` import extensions, double-quoted strings, `Hono<{ Variables: { user: SessionUser } }>` typing pattern (see `bootstrap.ts`), `c.json({ error: "..." }, status)` error shape.
- Existing tests must still pass (`pnpm test` from repo root) after every task.

---

## File Structure

- **Create** `apps/api/src/routes/sync-shape.ts` — the new proxy route.
- **Create** `apps/api/test/sync-shape.test.ts` — its tests (auth, table allowlist, membership enforcement, protocol param forwarding), using a mocked `global.fetch` so no live Electric container is required, matching this repo's existing convention of mocking Electric's *effect* rather than running it live in tests (see `sync.test.ts`'s file-header comment).
- **Modify** `apps/api/src/app.ts` — mount the new route.
- **Modify** `apps/api/.env.example` — document `ELECTRIC_INTERNAL_URL`.
- **Modify** `apps/web/src/lib/sync/shape.ts` — point at the proxy instead of Electric directly; simplify `subscribeTable`'s `where`/`params` construction.
- **Modify** `apps/web/src/lib/sync/shape.test.ts` — add coverage for the new `params`/`fetchClient` shape passed to `ShapeStream`.
- **Modify** `apps/web/.env.example` (if present) or the `VITE_ELECTRIC_URL` comment in `shape.ts` — update to reflect the new default.

---

### Task 1: API proxy route

**Files:**
- Create: `apps/api/src/routes/sync-shape.ts`
- Test: `apps/api/test/sync-shape.test.ts`

**Interfaces:**
- Consumes: `requireUser`/`SessionUser` from `apps/api/src/middleware/session.js`, `withUser` from `apps/api/src/db/tenant.js` (both existing, used exactly as in `bootstrap.ts`).
- Produces: `export const syncShape: Hono<{ Variables: { user: SessionUser } }>` — mounted at `/api/sync/shape` in Task 2.

- [ ] **Step 1: Write the failing tests**

```typescript
// apps/api/test/sync-shape.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { app } from "../src/app.js";
import { signUp } from "./helpers.js";

async function createHousehold(cookie: string, name = "Shape Proxy Test House") {
  const res = await app.request("/api/households", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return (await res.json()).household as { id: string };
}

function mockElectricResponse(body: string, headers: Record<string, string> = {}) {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("GET /api/sync/shape", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("requires auth", async () => {
    const res = await app.request("/api/sync/shape?table=book&householdId=x");
    expect(res.status).toBe(401);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("rejects an unknown table", async () => {
    const { cookie } = await signUp(app);
    const res = await app.request("/api/sync/shape?table=user&householdId=x", { headers: { cookie } });
    expect(res.status).toBe(400);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("requires householdId for a tenant table", async () => {
    const { cookie } = await signUp(app);
    const res = await app.request("/api/sync/shape?table=book", { headers: { cookie } });
    expect(res.status).toBe(400);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("forbids a household the caller is not a member of", async () => {
    const owner = await signUp(app);
    const house = await createHousehold(owner.cookie);
    const outsider = await signUp(app);

    const res = await app.request(`/api/sync/shape?table=book&householdId=${house.id}`, {
      headers: { cookie: outsider.cookie },
    });
    expect(res.status).toBe(403);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("forwards a tenant-table request to Electric with a server-derived where clause, ignoring any client-supplied where", async () => {
    const { cookie } = await signUp(app);
    const house = await createHousehold(cookie);
    vi.mocked(global.fetch).mockResolvedValue(mockElectricResponse("[]", { "electric-offset": "0_0" }));

    const res = await app.request(
      `/api/sync/shape?table=book&householdId=${house.id}&offset=-1&live=false&where=1=1`,
      { headers: { cookie } }
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("electric-offset")).toBe("0_0");

    const [calledUrl] = vi.mocked(global.fetch).mock.calls[0];
    const upstream = new URL(calledUrl as string);
    expect(upstream.searchParams.get("table")).toBe("book");
    expect(upstream.searchParams.get("replica")).toBe("full");
    expect(upstream.searchParams.get("where")).toBe("household_id = $1");
    expect(upstream.searchParams.get("params[1]")).toBe(house.id);
    // Client-supplied `where` above must never reach Electric verbatim.
    expect(upstream.searchParams.get("where")).not.toBe("1=1");
    // Electric protocol params are forwarded through unchanged.
    expect(upstream.searchParams.get("offset")).toBe("-1");
    expect(upstream.searchParams.get("live")).toBe("false");
  });

  it("forwards the global edition table with no where clause and no householdId required", async () => {
    const { cookie } = await signUp(app);
    vi.mocked(global.fetch).mockResolvedValue(mockElectricResponse("[]"));

    const res = await app.request("/api/sync/shape?table=edition&offset=-1", { headers: { cookie } });

    expect(res.status).toBe(200);
    const [calledUrl] = vi.mocked(global.fetch).mock.calls[0];
    const upstream = new URL(calledUrl as string);
    expect(upstream.searchParams.get("table")).toBe("edition");
    expect(upstream.searchParams.has("where")).toBe(false);
    expect(upstream.searchParams.has("params[1]")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @taakify/api test -- sync-shape.test.ts`
Expected: FAIL — `/api/sync/shape` doesn't exist yet (404s, so the 401/400/403 assertions fail).

- [ ] **Step 3: Write the implementation**

```typescript
// apps/api/src/routes/sync-shape.ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @taakify/api test -- sync-shape.test.ts`
Expected: PASS — route not yet mounted in `app.ts` will still 404. If any test
other than mounting-dependent ones fails, mount the route now (Task 2) before
proceeding, since `app.request` exercises the real `app` instance.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/sync-shape.ts apps/api/test/sync-shape.test.ts
git commit -m "feat: add authenticated Electric shape proxy route"
```

---

### Task 2: Mount the route and document the new env var

**Files:**
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/.env.example`

**Interfaces:**
- Consumes: `syncShape` from Task 1 (`apps/api/src/routes/sync-shape.js`).
- Produces: `/api/sync/shape` reachable on the real `app` instance, so Task 1's tests (and Task 4's) pass end to end.

- [ ] **Step 1: Mount the route in `app.ts`**

Add the import near the other route imports:

```typescript
import { syncShape } from "./routes/sync-shape.js";
```

Add the mount near the other `app.route(...)` calls, after `bootstrap`:

```typescript
app.route("/api/sync/shape", syncShape);
```

- [ ] **Step 2: Document `ELECTRIC_INTERNAL_URL` in `.env.example`**

Add to `apps/api/.env.example`, near the other infra-facing vars:

```
# Electric's shape endpoint, reachable only from the API (never exposed to
# the internet directly -- see docs/superpowers/specs/2026-09-08-taakify-public-mvp-launch-design.md,
# "Electric shape proxy"). Defaults to the dev docker-compose port; set to
# http://electric:3000/v1/shape (the compose service name) in production.
ELECTRIC_INTERNAL_URL=http://localhost:3010/v1/shape
```

- [ ] **Step 3: Run the full API test suite**

Run: `pnpm --filter @taakify/api test`
Expected: PASS, including all of Task 1's `sync-shape.test.ts` cases and every pre-existing test file.

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @taakify/api typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/app.ts apps/api/.env.example
git commit -m "feat: mount Electric shape proxy route, document ELECTRIC_INTERNAL_URL"
```

---

### Task 3: Point the web client at the proxy instead of Electric directly

**Files:**
- Modify: `apps/web/src/lib/sync/shape.ts`
- Modify: `apps/web/src/lib/sync/shape.test.ts`

**Interfaces:**
- Consumes: the `/api/sync/shape` route from Tasks 1-2 (via the Vite dev proxy in dev, same-origin in prod — no new config needed, `vite.config.ts:12` already proxies all of `/api`).
- Produces: `subscribeTable`'s exported test hook (see Step 1) that later tasks/tests can assert against without needing a live network call.

- [ ] **Step 1: Write the failing test**

At the top of `apps/web/src/lib/sync/shape.test.ts`, add `vi.mock("@electric-sql/client", ...)` **before** the existing `vi.mock("../db/pglite.js", ...)` block (vitest hoists all `vi.mock` calls above every import regardless of source position, so placement relative to imports doesn't matter, but keeping mocks grouped together matches the file's existing style):

```typescript
vi.mock("@electric-sql/client", async () => {
  const actual = await vi.importActual<typeof import("@electric-sql/client")>("@electric-sql/client");
  return {
    ...actual,
    ShapeStream: vi.fn().mockImplementation(() => ({
      subscribe: vi.fn(),
    })),
  };
});
```

Add `ShapeStream` to the existing `@electric-sql/client` usage and extend the
existing static `from "./shape.js"` import (the one already listing
`applyChangeTo`, `bootstrapInto`, etc.) to also pull in `startSync` and a new
test-only reset hook — do not use a dynamic `import()` here, since the
hoisted `vi.mock` above only applies to the module graph if `shape.js` (and
its `@electric-sql/client` dependency) are loaded through the normal static
`import`, exactly like the rest of this file already does:

```typescript
import { ShapeStream } from "@electric-sql/client";
import {
  applyChangeTo,
  bootstrapInto,
  getSynced,
  onSyncedChange,
  getSyncStale,
  onSyncStaleChange,
  STALE_FRESHNESS_TIMEOUT_MS,
  onMirrorChange,
  startSync,
  __resetSyncedForTests,
  __resetMirrorChangeForTests,
  __resetSyncStaleForTests,
  __resetStartedForTests,
  __markUpToDateForTests,
  __noteTableFreshForTests,
  __noteTableErroredForTests,
  __recomputeStaleForTests,
  __totalShapeCountForTests,
} from "./shape.js";
```

Then add the new test cases (anywhere after the existing `describe` blocks):

```typescript
describe("startSync -> ShapeStream construction", () => {
  afterEach(() => {
    vi.mocked(ShapeStream).mockClear();
    __resetStartedForTests();
  });

  it("points every tenant-table subscription at the API proxy with householdId as a plain param, never a client-built where clause", () => {
    startSync("11111111-1111-1111-1111-111111111111");

    const bookCall = vi.mocked(ShapeStream).mock.calls.find(
      ([opts]) => (opts as { params: { table: string } }).params.table === "book"
    );
    expect(bookCall).toBeDefined();
    const [opts] = bookCall!;
    expect((opts as { url: string }).url).toBe("/api/sync/shape");
    expect((opts as { params: Record<string, unknown> }).params).toMatchObject({
      table: "book",
      householdId: "11111111-1111-1111-1111-111111111111",
      replica: "full",
    });
    // The proxy derives the where clause server-side now -- the client must
    // never construct one itself (that was the security gap being closed).
    expect((opts as { params: Record<string, unknown> }).params.where).toBeUndefined();
  });

  it("subscribes to the global edition table with no householdId param", () => {
    startSync("11111111-1111-1111-1111-111111111111");

    const editionCall = vi.mocked(ShapeStream).mock.calls.find(
      ([opts]) => (opts as { params: { table: string } }).params.table === "edition"
    );
    expect(editionCall).toBeDefined();
    const [opts] = editionCall!;
    expect((opts as { params: Record<string, unknown> }).params.householdId).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @taakify/web test -- shape.test.ts`
Expected: FAIL — `__resetStartedForTests` doesn't exist yet, and the current
`subscribeTable` still builds a `where`/`params` shape pointed at Electric
directly, not `/api/sync/shape`.

- [ ] **Step 3: Update the implementation**

In `apps/web/src/lib/sync/shape.ts`, replace the `ELECTRIC_URL` constant and
its comment (currently lines 16-19):

```typescript
// Routed through the API's authenticated Electric shape proxy (see
// docs/superpowers/specs/2026-09-08-taakify-public-mvp-launch-design.md,
// "Electric shape proxy") -- the browser never talks to Electric directly.
// The proxy derives the household filter from the session server-side, so
// this module no longer needs (or is trusted with) an ELECTRIC_URL at all.
const SHAPE_PROXY_URL = "/api/sync/shape";
```

Replace `subscribeTable` and its call sites (currently around lines 545-586):

```typescript
export function startSync(householdId: string): void {
  if (started) return;
  started = true;

  for (const table of TENANT_TABLES) {
    subscribeTable(table, householdId);
  }
  // `edition` is a global catalog table with no household_id column (see
  // CLAUDE.md: "open select/insert/update to any authenticated app-role
  // connection", no RLS) -- no householdId param, matching the proxy's
  // no-where-clause handling for this table.
  subscribeTable("edition", undefined);

  stallTimer = setTimeout(() => {
    if (!synced) setStalled(true);
  }, SYNC_STALL_TIMEOUT_MS);
}

function subscribeTable(table: TenantTable | "edition", householdId: string | undefined): void {
  const stream = new ShapeStream({
    url: SHAPE_PROXY_URL,
    params: {
      table,
      ...(householdId ? { householdId } : {}),
      // Required: without it, `update` messages only carry changed columns
      // + PK (Electric's default "changes only" replica mode), and a
      // full-row upsert would then null out NOT NULL columns that weren't
      // part of the diff. See spike/electric-pglite-spike.ts.
      replica: "full",
    },
    // The proxy is behind requireUser -- without this, ShapeStream's
    // internal fetch calls wouldn't carry the session cookie and every
    // request would 401.
    fetchClient: (input, init) => fetch(input, { ...init, credentials: "include" }),
  });

  stream.subscribe((messages) => {
    for (const message of messages) {
      if (isControlMessage(message)) {
        if (message.headers.control === "up-to-date") {
          markUpToDate(table);
          noteTableFresh(table);
        }
        continue;
      }
      if (isChangeMessage(message)) {
        const operation = message.headers.operation as Operation;
        void applyChange(table, operation, message.value as Row);
      }
    }
  }, (error) => {
    // eslint-disable-next-line no-console
    console.error(`[sync] shape stream error for table "${table}"`, error);
    noteTableErrored(table);
  });
}
```

Add a test-only reset export next to the file's other `__...ForTests` exports
(find them via the existing `__resetSyncedForTests` etc. near the bottom of
the file, and add alongside):

```typescript
export function __resetStartedForTests(): void {
  started = false;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @taakify/web test -- shape.test.ts`
Expected: PASS, including both new tests and every pre-existing case in the
file (the `applyChangeTo`/`bootstrapInto` tests are unaffected by this
change).

- [ ] **Step 5: Update the `VITE_ELECTRIC_URL` reference**

Search for any remaining reference to `VITE_ELECTRIC_URL` (it no longer has an
effect since `shape.ts` no longer reads `import.meta.env`):

Run: `grep -rn "VITE_ELECTRIC_URL" apps/web --include="*.ts" --include="*.tsx" --include="*.env*"`

If found in an `.env.example` or similar, remove that line — it's dead
config now that the browser never talks to Electric directly.

- [ ] **Step 6: Run the full web test suite and typecheck**

Run: `pnpm --filter @taakify/web test && pnpm --filter @taakify/web typecheck`
Expected: PASS / no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/sync/shape.ts apps/web/src/lib/sync/shape.test.ts
git commit -m "feat: route Electric shapes through the authenticated API proxy"
```

---

### Task 4: Integration test proving cross-household isolation through the real proxy

**Files:**
- Modify: `apps/api/test/sync-shape.test.ts`

**Interfaces:**
- Consumes: `syncShape` (Tasks 1-2), `signUp`/`createHousehold` helpers already defined in the same test file (Task 1).

**Purpose:** Task 1's "forbids a household the caller is not a member of" test already proves the 403 case. This task adds the mirror-image proof — that even when Electric returns data, the `where` clause the proxy sent it was scoped to the *authenticated* household, not whatever the client asked for in a compromised/malicious request — closing the loop that motivated this whole plan (see spec §3).

- [ ] **Step 1: Write the failing test**

Add to `apps/api/test/sync-shape.test.ts`:

```typescript
it("never forwards a client-supplied where/params override, even if the client is a member of the household it claims", async () => {
  const owner = await signUp(app);
  const house = await createHousehold(owner.cookie);
  const attacker = await signUp(app);
  const attackerHouse = await createHousehold(attacker.cookie);
  vi.mocked(global.fetch).mockResolvedValue(mockElectricResponse("[]"));

  // The attacker is a real member of attackerHouse, and tries to smuggle
  // house's id into a raw `params[1]` override alongside their own
  // (legitimate) householdId query param, hoping the proxy blindly forwards
  // client query params instead of always deriving them server-side.
  const res = await app.request(
    `/api/sync/shape?table=book&householdId=${attackerHouse.id}&params[1]=${house.id}`,
    { headers: { cookie: attacker.cookie } }
  );

  expect(res.status).toBe(200);
  const [calledUrl] = vi.mocked(global.fetch).mock.calls[0];
  const upstream = new URL(calledUrl as string);
  // Must reflect the attacker's OWN verified household, never the smuggled
  // value from the raw query string.
  expect(upstream.searchParams.get("params[1]")).toBe(attackerHouse.id);
  expect(upstream.searchParams.get("params[1]")).not.toBe(house.id);
});
```

- [ ] **Step 2: Run test to verify it fails or passes**

Run: `pnpm --filter @taakify/api test -- sync-shape.test.ts`

Expected: this should already PASS given Task 1's implementation (the route
never reads a client `params[1]`/`where` value at all — it only ever sets
`upstream.searchParams.set(...)` from the verified `householdId`, which
overwrites the `URL` object cleanly since `upstream` starts from
`electricInternalUrl()`, not from the incoming request's query string). If it
fails, it means the implementation is reading client query params too
permissively — fix `sync-shape.ts` to only ever read `table`, `householdId`,
and the explicit `ELECTRIC_PROTOCOL_PARAMS` list from the incoming request,
never a raw `where`/`params[...]`.

- [ ] **Step 3: Run the full API suite**

Run: `pnpm --filter @taakify/api test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/test/sync-shape.test.ts
git commit -m "test: prove the shape proxy never forwards client-supplied where/params overrides"
```

---

### Task 5: Full regression pass

**Files:** none (verification only).

- [ ] **Step 1: Run the complete test suite from repo root**

Run: `pnpm test`
Expected: PASS (both `@taakify/api` and `@taakify/web`).

- [ ] **Step 2: Typecheck both workspaces**

Run: `pnpm --filter @taakify/api typecheck && pnpm --filter @taakify/web typecheck`
Expected: no errors.

- [ ] **Step 3: Manual smoke check against the real dev stack**

Run: `docker compose -f docker-compose.dev.yml up -d`, then `pnpm migrate`,
then `pnpm dev:api` and `pnpm dev:web` in separate terminals. Sign up, create
a household, add a book, and confirm it appears without a "Sync unavailable"
badge — this proves the proxy's real (non-mocked) path to a live Electric
container still works end to end, not just against the mocked-`fetch` unit
tests above.

- [ ] **Step 4: Commit (if Step 3 required any fixes)**

```bash
git add -A
git commit -m "fix: address issues found in shape proxy manual smoke test"
```

(Skip this commit if Step 3 required no changes.)
