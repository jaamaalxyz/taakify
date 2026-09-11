# Taakify Security Hardening Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining code-level gaps from the Public MVP Launch spec's §5 Security Hardening Pass — the parameterized `taakify_app` role password, explicit (tested) auth rate limiting, and a verified Secure/SameSite session cookie — before real strangers' data lands on the production box.

**Architecture:** No new services or dependencies. `apps/api/src/db/migrate.ts` gains an option to set the `taakify_app` Postgres role's password from an environment variable instead of the hardcoded SQL literal, applied via a parameterized `ALTER ROLE` after every migration run (idempotent, supports password rotation on redeploy). `apps/api/src/auth.ts` gets an explicit (currently-implicit) rate-limit setting with a comment explaining what it inherits from better-auth's own defaults. Two new test files prove both behaviors, plus the already-correct Secure/SameSite cookie behavior, actually work — using throwaway `betterAuth()`/`migrate()` instances so nothing here touches the shared test-suite database state that every other test file depends on.

**Tech Stack:** Node/TypeScript, `pg` (node-postgres), `better-auth` 1.6.23, Vitest, real Postgres (`taakify_test` on `:5433`, per `test/global-setup.ts`).

**Spec:** `docs/superpowers/specs/2026-09-08-taakify-public-mvp-launch-design.md` (§5 Security Hardening Pass, §11 step 3)

## Global Constraints

- The `taakify_app` role's password must no longer live only as a SQL literal in `migrations/0003_rls.sql` — it must be settable from an environment variable and rotatable by re-running `pnpm migrate` (spec §5, §11 step 3; already anticipated by the commented `APP_DB_PASSWORD` wiring in `.env.prod.example` and `docker-compose.prod.yml`).
- Auth rate limiting on `/api/auth/*` must be real and provably enforced, not merely assumed from a library default (spec §5: "add one \[...] since credential-stuffing/guessing against an open signup endpoint is a realistic risk").
- Session cookies must carry `Secure` and an appropriate `SameSite` value under the real HTTPS origin (spec §5) — this must be verified, not assumed.
- `pnpm audit` (both workspaces) is already documented in `docs/deploy.md` as a standing pre-deploy step (spec §5) — this plan runs it once now and triages findings.
- The `security-review` skill run against RLS/`withUser`/session code (spec §5) is the final gate before this security pass is considered done.
- Do not change anything in `docker-compose.dev.yml`, `apps/api/.env.example`, or `test/env-setup.ts` — the dev/test default password (`taakify_app_dev`) must keep working unchanged so no other developer workflow breaks.
- `fileParallelism` is disabled and every API test file shares one Postgres database (`taakify_test`) — any test that mutates shared state (like a role's password) must restore it in `afterAll`, unconditionally.

---

## Task 1: Parameterize the `taakify_app` role password

**Files:**
- Modify: `apps/api/src/db/migrate.ts`
- Modify: `apps/api/migrations/0003_rls.sql:1-8` (comment only)
- Modify: `docker-compose.prod.yml:60-65` (comment only)
- Modify: `.env.prod.example` (uncomment/promote `APP_DB_PASSWORD`)
- Modify: `docs/deploy.md` (remove the "known caveat" paragraph in step 2, add a rotation note)
- Test: `apps/api/test/migrate-password.test.ts`

**Interfaces:**
- Produces: `migrate(databaseUrl: string, options?: { appDbPassword?: string }): Promise<string[]>` — same return type as before, new optional second parameter. Existing callers (`test/global-setup.ts`, the CLI block in `migrate.ts` itself) that omit `options` get today's behavior (`taakify_app_dev`) unchanged.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/migrate-password.test.ts`:

```ts
import { describe, it, expect, afterAll } from "vitest";
import pg from "pg";
import { migrate } from "../src/db/migrate.js";

// Same admin connection string test/global-setup.ts uses to migrate taakify_test.
const ADMIN_URL = "postgresql://postgres:postgres@localhost:5433/taakify_test";
const CUSTOM_PASSWORD = "rotated-test-password-123";
const DEFAULT_PASSWORD = "taakify_app_dev";

function appPoolWith(password: string): pg.Pool {
  return new pg.Pool({
    connectionString: `postgresql://taakify_app:${password}@localhost:5433/taakify_test`,
  });
}

describe("migrate: taakify_app password parameterization", () => {
  // Every other test file's appPool() connects with DEFAULT_PASSWORD (see
  // test/env-setup.ts) -- restore it so later test files keep working
  // regardless of this test's outcome.
  afterAll(async () => {
    await migrate(ADMIN_URL);
  });

  it("sets the taakify_app role password from the appDbPassword option", async () => {
    await migrate(ADMIN_URL, { appDbPassword: CUSTOM_PASSWORD });

    const withNewPassword = appPoolWith(CUSTOM_PASSWORD);
    await expect(withNewPassword.query("SELECT 1")).resolves.toBeTruthy();
    await withNewPassword.end();

    const withOldPassword = appPoolWith(DEFAULT_PASSWORD);
    await expect(withOldPassword.query("SELECT 1")).rejects.toThrow(
      /password authentication failed/
    );
    await withOldPassword.end();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @taakify/api test -- migrate-password.test.ts`
Expected: FAIL — `migrate()` doesn't accept a second argument yet, so the new password is never set and the "old password now fails" assertion fails (the role's password is still `taakify_app_dev`, so `withOldPassword` connects fine and `withNewPassword` is the one that fails instead).

- [ ] **Step 3: Implement the `appDbPassword` option in `migrate.ts`**

Modify `apps/api/src/db/migrate.ts`:

```ts
export async function migrate(
  databaseUrl: string,
  options?: { appDbPassword?: string }
): Promise<string[]> {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const applied: string[] = [];
  try {
    await pool.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"
    );
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      const { rowCount } = await pool.query("SELECT 1 FROM schema_migrations WHERE name = $1", [file]);
      if (rowCount) continue;
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        applied.push(file);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      } finally {
        client.release();
      }
    }

    // Runs on every invocation (not just when 0003_rls.sql is newly applied)
    // so that re-running `pnpm migrate` after rotating APP_DB_PASSWORD picks
    // up the new value. migrations/0003_rls.sql still bootstraps the role
    // with a hardcoded dev password on first-ever creation (CREATE ROLE ...
    // IF NOT EXISTS) -- this always overrides it with the real one right
    // after, via a parameterized query so the password is never SQL-literal.
    const { rowCount: roleExists } = await pool.query(
      "SELECT 1 FROM pg_roles WHERE rolname = 'taakify_app'"
    );
    if (roleExists) {
      const appDbPassword = options?.appDbPassword ?? "taakify_app_dev";
      await pool.query("ALTER ROLE taakify_app WITH PASSWORD $1", [appDbPassword]);
    }
  } finally {
    await pool.end();
  }
  return applied;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }
  migrate(process.env.DATABASE_URL, { appDbPassword: process.env.APP_DB_PASSWORD })
    .then((applied) => {
      console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Up to date");
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @taakify/api test -- migrate-password.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full API suite to confirm nothing else broke**

Run: `pnpm --filter @taakify/api test`
Expected: PASS — the `afterAll` in the new test file restores `taakify_app_dev` before any other test file runs its own tests against `appPool()`.

- [ ] **Step 6: Update the stale comment in the migration file**

In `apps/api/migrations/0003_rls.sql:1-8`, replace:

```sql
-- App role: what the API uses for all tenant-data access. RLS applies to it.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'taakify_app') THEN
    -- Dev-only password. Production pre-creates this role with a real secret
    -- (the IF NOT EXISTS guard makes this block a no-op there); the API reads
    -- credentials from APP_DATABASE_URL, never from this file.
    CREATE ROLE taakify_app LOGIN PASSWORD 'taakify_app_dev';
  END IF;
END $$;
```

with:

```sql
-- App role: what the API uses for all tenant-data access. RLS applies to it.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'taakify_app') THEN
    -- Bootstrap-only password, immediately overridden: apps/api/src/db/migrate.ts
    -- runs a parameterized ALTER ROLE right after every migration pass, using
    -- APP_DB_PASSWORD (falling back to this same dev value when unset, so
    -- docker-compose.dev.yml and the test suite are unaffected). The real
    -- password never appears as a SQL literal outside this dev fallback.
    CREATE ROLE taakify_app LOGIN PASSWORD 'taakify_app_dev';
  END IF;
END $$;
```

- [ ] **Step 7: Update the stale comment in `docker-compose.prod.yml`**

In `docker-compose.prod.yml:60-65`, replace:

```yaml
      # Internal topology is fixed here, not in .env.prod -- the env file only
      # carries secrets. App-role password: migration 0003_rls.sql creates the
      # taakify_app role with a fixed dev password; parameterizing it is on the
      # security-pass list (spec §11 step 3). Exposure today: compose network only.
```

with:

```yaml
      # Internal topology is fixed here, not in .env.prod -- the env file only
      # carries secrets. App-role password: apps/api/src/db/migrate.ts sets it
      # from APP_DB_PASSWORD via a parameterized ALTER ROLE on every migrate
      # run (see migrations/0003_rls.sql's comment) -- set APP_DB_PASSWORD
      # below to a real secret before the first production migrate.
```

- [ ] **Step 8: Promote `APP_DB_PASSWORD` in `.env.prod.example`**

Replace:

```
# Password migration 0003_rls.sql currently hardcodes for the RLS-scoped
# taakify_app role -- do not change until that migration is parameterized
# (security-pass TODO). Listed here so the wiring is ready when it is.
# APP_DB_PASSWORD=taakify_app_dev
```

with:

```
# RLS-scoped taakify_app role's password (apps/api/src/db/migrate.ts sets it
# via ALTER ROLE on every `pnpm migrate` run). Required for a real production
# deploy -- the dev default below is fine only if the DB is unreachable from
# outside the compose network (it is, but don't rely on that as your only
# layer of defense).
# openssl rand -base64 24
APP_DB_PASSWORD=taakify_app_dev
```

- [ ] **Step 9: Update `docs/deploy.md`**

Remove this paragraph from the "## 2. Secrets" section:

```
Known caveat: the RLS-scoped `taakify_app` role's password is hardcoded in
migration `0003_rls.sql` (a dev-ism). It is only reachable inside the compose
network (Postgres publishes no ports), and parameterizing it is on the
security-pass list (spec §11 step 3).
```

Replace it with:

```
`APP_DB_PASSWORD` sets the RLS-scoped `taakify_app` role's password (applied
by `pnpm migrate` via `ALTER ROLE`, not baked into the migration SQL) — set
it to a real secret, distinct from `POSTGRES_PASSWORD`. To rotate it later:
update `.env.prod`, then re-run step 4 (`... run --rm migrate`) — the next
migrate pass applies the new password immediately.
```

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/db/migrate.ts apps/api/migrations/0003_rls.sql \
  docker-compose.prod.yml .env.prod.example docs/deploy.md \
  apps/api/test/migrate-password.test.ts
git commit -m "feat: parameterize the taakify_app role password via ALTER ROLE"
```

---

## Task 2: Explicit, tested auth hardening (rate limiting + cookie flags)

**Files:**
- Modify: `apps/api/src/auth.ts`
- Test: `apps/api/test/auth-hardening.test.ts`

**Interfaces:**
- Consumes: `adminPool` from `apps/api/src/db/pool.ts` (existing export, already used by `auth.ts` itself).
- No new exports — this task only adds an explicit config field to the existing `auth` singleton and a test file exercising throwaway `betterAuth()` instances (never the shared singleton, so no other test's session state is affected).

Context found while investigating (verified by reading `better-auth@1.6.23`'s source, not assumed):
- better-auth's `rateLimit.enabled` already defaults to `isProduction` (true whenever `NODE_ENV=production`, which `apps/api/Dockerfile` sets). Its built-in special rules already cap any path starting with `/sign-in` or `/sign-up` (also `/change-password`, `/change-email`) at **3 requests per 10 seconds**, regardless of the top-level `max` — see `better-auth/dist/api/rate-limiter/index.mjs`'s `getDefaultSpecialRules()`. So the mechanism already exists and will already be active in production today; it has just never been made explicit in our own code or proven to actually reject requests.
- better-auth's session cookie already gets `secure: true` whenever `baseURL` starts with `https://` (`better-auth/dist/cookies/index.mjs`), and `sameSite: "lax"` unconditionally. Since `.env.prod.example`'s `BETTER_AUTH_URL` is `https://app.example.com`, this is already correct — again, unverified by any test.

This task therefore makes the rate-limit setting explicit (a no-op behavior change, for auditability) and adds tests proving both behaviors, closing the "needs explicit verification" items from spec §5.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/test/auth-hardening.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { betterAuth } from "better-auth";
import { randomUUID } from "node:crypto";
import { adminPool } from "../src/db/pool.js";

const TEST_SECRET = "test-secret-test-secret-test-secret!";

function signUpRequest(baseURL: string, email: string): Request {
  return new Request(`${baseURL}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password-123", name: "Test User" }),
  });
}

describe("auth hardening", () => {
  it("issues a Secure, SameSite=Lax session cookie under an https baseURL", async () => {
    // A throwaway instance, not the app's shared `auth` singleton -- proves
    // better-auth's own cookie derivation, isolated from any other test.
    const instance = betterAuth({
      database: adminPool,
      secret: TEST_SECRET,
      baseURL: "https://app.example.test",
      basePath: "/api/auth",
      emailAndPassword: { enabled: true },
    });

    const res = await instance.handler(
      signUpRequest("https://app.example.test", `${randomUUID()}@test.local`)
    );
    expect(res.status).toBe(200);

    const setCookie = res.headers.getSetCookie().join("; ");
    expect(setCookie).toMatch(/secure/i);
    expect(setCookie).toMatch(/samesite=lax/i);
  });

  it("rejects sign-up attempts past the built-in rate limit", async () => {
    // rateLimit.enabled defaults to `isProduction` (NODE_ENV=production),
    // which is false in the test process -- enable it explicitly here to
    // prove the mechanism this app relies on in production actually works.
    // The 3-per-10s cap on /sign-up* comes from better-auth's own built-in
    // special rule, not from any config passed below.
    const instance = betterAuth({
      database: adminPool,
      secret: TEST_SECRET,
      baseURL: "http://localhost:9999",
      basePath: "/api/auth",
      emailAndPassword: { enabled: true },
      rateLimit: { enabled: true },
    });

    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await instance.handler(
        signUpRequest("http://localhost:9999", `${randomUUID()}@test.local`)
      );
      statuses.push(res.status);
    }

    expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
    expect(statuses[3]).toBe(429);
  });
});
```

- [ ] **Step 2: Run tests to verify current state**

Run: `pnpm --filter @taakify/api test -- auth-hardening.test.ts`
Expected: Both tests already PASS, since they exercise better-auth's existing behavior directly and don't touch `apps/api/src/auth.ts` yet. This confirms the investigation above before touching production code — if either test fails here, stop and re-read the better-auth version actually installed (`apps/api/package.json`'s `better-auth` range) before proceeding, since the behavior may differ from what was verified during planning.

- [ ] **Step 3: Make the rate-limit setting explicit in `auth.ts`**

Modify `apps/api/src/auth.ts` — add the `rateLimit` field:

```ts
export const auth = betterAuth({
  database: adminPool,
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,
  basePath: "/api/auth",
  emailAndPassword: { enabled: true },
  socialProviders: googleEnabled
    ? {
        google: {
          clientId: process.env.GOOGLE_CLIENT_ID!,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
        },
      }
    : undefined,
  trustedOrigins: ["http://localhost:5173"],
  // Spelled out rather than left to better-auth's own `isProduction` default
  // so the production behavior is visible here, not buried in a library
  // default: /sign-in* and /sign-up* are capped at 3 requests per 10s by
  // better-auth's built-in special rules once enabled (see
  // apps/api/test/auth-hardening.test.ts). Off in dev/test (NODE_ENV unset)
  // so the test suite's many rapid signUp() calls aren't throttled.
  rateLimit: { enabled: process.env.NODE_ENV === "production" },
});
```

- [ ] **Step 4: Run the full API suite to confirm no regression**

Run: `pnpm --filter @taakify/api test`
Expected: PASS — `NODE_ENV` is not `"production"` in the test process (see `apps/api/test/env-setup.ts`, which never sets it), so `auth.ts`'s change is a no-op there; every existing test that calls `signUp()` multiple times keeps working.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/auth.ts apps/api/test/auth-hardening.test.ts
git commit -m "feat: make auth rate limiting explicit, prove it and cookie flags with tests"
```

---

## Task 3: Dependency audit and final security-review gate

**Files:** None (no code changes expected unless Step 1 finds something) — this task is the manual close-out of spec §5's remaining checklist items.

- [ ] **Step 1: Run `pnpm audit` in both workspaces**

```bash
pnpm --filter @taakify/api audit
pnpm --filter @taakify/web audit
```

If either reports a **high or critical** advisory with a available fix, apply it (`pnpm update <package>` to the patched version, or `pnpm --filter <workspace> add <package>@<patched-version>`), then re-run the affected workspace's test suite (`pnpm --filter @taakify/api test` / `pnpm --filter @taakify/web test`) before continuing. Low/moderate advisories with no production-relevant path (e.g. a devDependency-only transitive) can be noted and left, since this is a checklist gate, not a zero-vulnerabilities requirement.

- [ ] **Step 2: Run the `security-review` skill**

Invoke the `security-review` skill against the current branch, with particular attention (per spec §5) to:
- `migrations/0003_rls.sql` — the RLS policies and the role/grant setup this plan's Task 1 touched.
- `apps/api/src/middleware/session.ts` and `apps/api/src/db/tenant.ts` (`withUser`) — the code that guarantees household isolation.
- `apps/api/src/auth.ts` — the rate-limit and cookie config this plan's Task 2 touched.

Address any findings it reports before merging. If a finding requires nontrivial design changes (not a straightforward fix), stop and report it rather than improvising a fix under this plan's scope.

- [ ] **Step 3: Commit any fixes from Steps 1-2**

```bash
git add -A
git commit -m "fix: address pnpm audit / security-review findings"
```

(Skip this commit if neither step produced any changes.)

---

## Self-Review

**Spec coverage** (spec §5, §11 step 3):
- VM firewall, SSH hardening, Cloudflare account 2FA — already fully documented in `docs/deploy.md` from PR #33; no code task needed, not repeated here.
- Auth rate limiting — Task 2.
- Security-review pass — Task 3, Step 2.
- Dependency audit — Task 3, Step 1 (also already a standing `docs/deploy.md` checklist item from PR #33).
- Cookie/session flags — Task 2 (verification test; already-correct behavior, per source investigation).
- `taakify_app` password parameterization — Task 1 (this is the concrete gap the codebase's own comments flagged as outstanding).

**Placeholder scan:** No TBD/TODO markers; every step has literal code or exact file diffs.

**Type consistency:** `migrate(databaseUrl: string, options?: { appDbPassword?: string })` is used identically in Task 1's test, its CLI block, and its production call site. `auth.ts`'s new `rateLimit` field name and shape (`{ enabled: boolean }`) matches what Task 2's test exercises directly against `betterAuth()`.

---

**Plan complete and saved to `docs/superpowers/plans/2026-09-11-taakify-security-hardening.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
