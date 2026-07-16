# Taakify Plan 1: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Monorepo + dev infrastructure + full database schema with RLS + auth + household/membership/invite flows, ending with: you can sign up, create your household, and invite a family member who joins it.

**Architecture:** pnpm monorepo with a Hono (Node) API and a Vite React SPA. Postgres (wal_level=logical, ready for ElectricSQL) and Electric run in Docker Compose for dev. better-auth handles email/password sessions. Two DB pools: a privileged pool (migrations, auth tables, service operations like household creation and invite acceptance) and an RLS-enforced app pool (`taakify_app` role) for all tenant data. Tenancy is enforced by RLS policies keyed on a per-transaction `app.user_id` setting via a `SECURITY DEFINER` membership-lookup function.

**Tech Stack:** Node 22, pnpm, TypeScript, Hono, better-auth, pg (no ORM — hand-written SQL matches the PGlite client-side idiom coming in Plan 2), Vitest, Vite, React 19, react-router.

**Spec:** `docs/superpowers/specs/2026-07-16-taakify-bookshelf-design.md`

**Prerequisites (verify before starting):** Docker + Docker Compose, Node 22 (`node -v`), pnpm 9+ (`corepack enable && corepack prepare pnpm@latest --activate`).

**Conventions:**
- All commands run from repo root `/Users/jaamaalxyz/training/taakify` unless stated.
- Dev ports: Postgres **5433** (host-mapped to avoid clashing with any local Postgres), Electric **3010**, API **3001**, web **5173**.
- Migrations are **up-only** plain SQL files run by a tiny custom migrator. No down migrations (YAGNI at this stage; dev resets by dropping the schema).

---

## File Structure

```
taakify/
├── pnpm-workspace.yaml
├── package.json                  # root scripts only
├── .nvmrc
├── .gitignore
├── docker-compose.dev.yml        # Postgres + Electric for dev
├── README.md
├── apps/
│   ├── api/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── vitest.config.ts
│   │   ├── .env.example
│   │   ├── migrations/
│   │   │   ├── 0001_auth.sql          # better-auth tables
│   │   │   ├── 0002_core.sql          # domain schema (full spec model)
│   │   │   └── 0003_rls.sql           # app role + RLS policies
│   │   ├── src/
│   │   │   ├── index.ts               # server entry
│   │   │   ├── app.ts                 # Hono app assembly
│   │   │   ├── auth.ts                # better-auth instance
│   │   │   ├── db/
│   │   │   │   ├── pool.ts            # privileged + app pools
│   │   │   │   ├── migrate.ts         # migration runner
│   │   │   │   └── tenant.ts          # withUser() RLS transaction helper
│   │   │   ├── middleware/
│   │   │   │   └── session.ts         # requireUser middleware
│   │   │   └── routes/
│   │   │       ├── households.ts
│   │   │       └── invites.ts
│   │   └── test/
│   │       ├── global-setup.ts        # create/reset test DB, run migrations
│   │       ├── helpers.ts             # signUp() etc.
│   │       ├── health.test.ts
│   │       ├── rls.test.ts
│   │       ├── households.test.ts
│   │       └── invites.test.ts
│   └── web/
│       ├── package.json
│       ├── tsconfig.json
│       ├── vite.config.ts             # proxies /api → :3001
│       ├── index.html
│       └── src/
│           ├── main.tsx
│           ├── App.tsx                # routes + auth gate
│           ├── styles.css
│           ├── lib/
│           │   ├── auth.ts            # better-auth react client
│           │   └── api.ts             # fetch helper
│           └── pages/
│               ├── SignUp.tsx
│               ├── SignIn.tsx
│               ├── Onboarding.tsx     # create household
│               ├── InviteAccept.tsx
│               └── Home.tsx
└── docs/superpowers/...               # (already exists)
```

`packages/shared` is deliberately absent — it arrives in Plan 2 when client and server first share sync types.

---

### Task 1: Monorepo scaffold

**Files:**
- Create: `pnpm-workspace.yaml`, `package.json`, `.nvmrc`, `.gitignore`

- [ ] **Step 1: Create workspace files**

`pnpm-workspace.yaml`:
```yaml
packages:
  - "apps/*"
  - "packages/*"
```

`package.json`:
```json
{
  "name": "taakify",
  "private": true,
  "scripts": {
    "dev:api": "pnpm --filter @taakify/api dev",
    "dev:web": "pnpm --filter @taakify/web dev",
    "migrate": "pnpm --filter @taakify/api migrate",
    "test": "pnpm --filter @taakify/api test"
  },
  "engines": { "node": ">=22" }
}
```

`.nvmrc`:
```
22
```

`.gitignore`:
```
node_modules/
dist/
.env
*.local
.DS_Store
```

- [ ] **Step 2: Verify pnpm resolves the workspace**

Run: `pnpm install`
Expected: completes without error (no packages yet — that's fine), creates `pnpm-lock.yaml`.

- [ ] **Step 3: Commit**

```bash
git add pnpm-workspace.yaml package.json .nvmrc .gitignore pnpm-lock.yaml
git commit -m "chore: scaffold pnpm monorepo"
```

---

### Task 2: Dev Docker Compose (Postgres + Electric)

**Files:**
- Create: `docker-compose.dev.yml`

- [ ] **Step 1: Write the compose file**

`docker-compose.dev.yml`:
```yaml
services:
  postgres:
    image: postgres:17-alpine
    command: ["postgres", "-c", "wal_level=logical"]
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: taakify
    ports:
      - "5433:5432"
    volumes:
      - taakify_pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 3s
      timeout: 3s
      retries: 10

  electric:
    image: electricsql/electric:latest
    environment:
      DATABASE_URL: postgresql://postgres:postgres@postgres:5432/taakify?sslmode=disable
      ELECTRIC_INSECURE: "true"   # dev only — Plan 5 configures auth for production
    ports:
      - "3010:3000"
    depends_on:
      postgres:
        condition: service_healthy

volumes:
  taakify_pgdata:
```

- [ ] **Step 2: Boot and verify**

Run: `docker compose -f docker-compose.dev.yml up -d && sleep 5 && docker compose -f docker-compose.dev.yml ps`
Expected: both `postgres` and `electric` show `running`; postgres healthy.

Run: `docker compose -f docker-compose.dev.yml logs electric | tail -5`
Expected: no crash loop (Electric connected to Postgres). Electric is otherwise unused until Plan 2 — booting it now proves our Postgres config (wal_level=logical) is Electric-compatible.

- [ ] **Step 3: Commit**

```bash
git add docker-compose.dev.yml
git commit -m "chore: dev docker compose with postgres (logical wal) and electric"
```

---

### Task 3: API package, migration runner, and full schema

**Files:**
- Create: `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/api/.env.example`
- Create: `apps/api/src/db/pool.ts`, `apps/api/src/db/migrate.ts`
- Create: `apps/api/migrations/0001_auth.sql`, `apps/api/migrations/0002_core.sql`

- [ ] **Step 1: Create the API package**

`apps/api/package.json`:
```json
{
  "name": "@taakify/api",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "migrate": "tsx src/db/migrate.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@hono/node-server": "^1.14.0",
    "better-auth": "^1.3.0",
    "dotenv": "^16.4.0",
    "hono": "^4.7.0",
    "pg": "^8.13.0"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "@types/pg": "^8.11.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```
(Caret ranges: the executor installs current minors. If `better-auth` has moved a major version, check its migration notes before proceeding.)

`apps/api/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src", "test"]
}
```

`apps/api/.env.example`:
```
# privileged connection: migrations, better-auth tables, service operations
DATABASE_URL=postgresql://postgres:postgres@localhost:5433/taakify
# RLS-enforced connection for tenant data
APP_DATABASE_URL=postgresql://taakify_app:taakify_app_dev@localhost:5433/taakify
BETTER_AUTH_SECRET=dev-secret-change-me-32-chars-min!
BETTER_AUTH_URL=http://localhost:3001
PORT=3001
```

Run: `cp apps/api/.env.example apps/api/.env && pnpm install`
Expected: dependencies install cleanly.

- [ ] **Step 2: Write the pools and migration runner**

`apps/api/src/db/pool.ts`:
```ts
import pg from "pg";
import "dotenv/config";

// Privileged: migrations, better-auth, service ops (household create, invite accept).
export const adminPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// RLS-enforced: all tenant data access. Lazily created so the migrator can run
// before the taakify_app role exists.
let _appPool: pg.Pool | undefined;
export function appPool(): pg.Pool {
  _appPool ??= new pg.Pool({ connectionString: process.env.APP_DATABASE_URL });
  return _appPool;
}
```

`apps/api/src/db/migrate.ts`:
```ts
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import "dotenv/config";

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");

export async function migrate(databaseUrl: string): Promise<string[]> {
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
  } finally {
    await pool.end();
  }
  return applied;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  migrate(process.env.DATABASE_URL!).then((applied) => {
    console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Up to date");
  });
}
```

- [ ] **Step 3: Write the auth-tables migration**

`apps/api/migrations/0001_auth.sql` — better-auth core schema (camelCase quoted, per better-auth defaults):
```sql
CREATE TABLE "user" (
  "id" text PRIMARY KEY,
  "name" text NOT NULL,
  "email" text NOT NULL UNIQUE,
  "emailVerified" boolean NOT NULL DEFAULT false,
  "image" text,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "session" (
  "id" text PRIMARY KEY,
  "expiresAt" timestamptz NOT NULL,
  "token" text NOT NULL UNIQUE,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  "ipAddress" text,
  "userAgent" text,
  "userId" text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE
);

CREATE TABLE "account" (
  "id" text PRIMARY KEY,
  "accountId" text NOT NULL,
  "providerId" text NOT NULL,
  "userId" text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  "scope" text,
  "password" text,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "verification" (
  "id" text PRIMARY KEY,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);
```
**Executor note:** cross-check this against `pnpm dlx @better-auth/cli@latest generate` output for the installed better-auth version (run inside `apps/api/`). If columns differ, prefer the CLI's output — update this file before first run.

- [ ] **Step 4: Write the domain-schema migration**

`apps/api/migrations/0002_core.sql` — the full spec data model. Every tenant table carries `household_id`, `created_by`, `created_at`, `updated_at` (last-write-wins), and `deleted_at` (soft delete):
```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE household (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  plan text NOT NULL DEFAULT 'free',
  plan_status text NOT NULL DEFAULT 'active',
  billing_customer_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE membership (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES household (id),
  user_id text NOT NULL REFERENCES "user" ("id"),
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (household_id, user_id)
);
CREATE INDEX membership_user_idx ON membership (user_id);

CREATE TABLE invite (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES household (id),
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'member')),
  token text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  created_by text NOT NULL REFERENCES "user" ("id"),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

-- Global shared catalog: no household_id by design (see spec §4).
CREATE TABLE edition (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  isbn text,
  title text NOT NULL,
  authors text NOT NULL DEFAULT '',
  language text,
  publisher text,
  published_year int,
  cover_url text,
  series_name text,
  series_number numeric,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX edition_isbn_idx ON edition (isbn);

CREATE TABLE bookcase (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES household (id),
  name text NOT NULL,
  created_by text NOT NULL REFERENCES "user" ("id"),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE shelf (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES household (id),
  bookcase_id uuid NOT NULL REFERENCES bookcase (id),
  position int NOT NULL,
  label text,
  created_by text NOT NULL REFERENCES "user" ("id"),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE book (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES household (id),
  edition_id uuid NOT NULL REFERENCES edition (id),
  ownership text NOT NULL CHECK (ownership IN ('owned', 'borrowed_in', 'wishlist')),
  format text,
  shelf_id uuid REFERENCES shelf (id),
  do_not_lend boolean NOT NULL DEFAULT false,
  wishlist_priority text CHECK (wishlist_priority IN ('high', 'medium', 'low')),
  notes text,
  created_by text NOT NULL REFERENCES "user" ("id"),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE reading_status (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES household (id),
  book_id uuid NOT NULL REFERENCES book (id),
  user_id text NOT NULL REFERENCES "user" ("id"),
  status text NOT NULL CHECK (status IN ('unread', 'want_to_read', 'reading', 'finished', 'abandoned')),
  started_at date,
  finished_at date,
  rating int CHECK (rating BETWEEN 1 AND 5),
  review_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (book_id, user_id)
);

CREATE TABLE tag (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES household (id),
  name text NOT NULL,
  created_by text NOT NULL REFERENCES "user" ("id"),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (household_id, name)
);

CREATE TABLE book_tag (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES household (id),
  book_id uuid NOT NULL REFERENCES book (id),
  tag_id uuid NOT NULL REFERENCES tag (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (book_id, tag_id)
);

CREATE TABLE contact (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES household (id),
  name text NOT NULL,
  phone text,
  email text,
  linked_user_id text REFERENCES "user" ("id"),
  created_by text NOT NULL REFERENCES "user" ("id"),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE loan (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES household (id),
  book_id uuid NOT NULL REFERENCES book (id),
  contact_id uuid NOT NULL REFERENCES contact (id),
  direction text NOT NULL CHECK (direction IN ('lent_out', 'borrowed_in')),
  out_date date NOT NULL DEFAULT CURRENT_DATE,
  due_date date,
  returned_date date,
  notes text,
  created_by text NOT NULL REFERENCES "user" ("id"),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX bookcase_household_idx ON bookcase (household_id);
CREATE INDEX shelf_household_idx ON shelf (household_id);
CREATE INDEX book_household_idx ON book (household_id);
CREATE INDEX reading_status_household_idx ON reading_status (household_id);
CREATE INDEX tag_household_idx ON tag (household_id);
CREATE INDEX book_tag_household_idx ON book_tag (household_id);
CREATE INDEX contact_household_idx ON contact (household_id);
CREATE INDEX loan_household_idx ON loan (household_id);
CREATE INDEX invite_household_idx ON invite (household_id);
```

- [ ] **Step 5: Run migrations against the dev database and verify**

Run: `pnpm migrate`
Expected: `Applied: 0001_auth.sql, 0002_core.sql`

Run: `docker compose -f docker-compose.dev.yml exec postgres psql -U postgres -d taakify -c "\dt"`
Expected: all tables listed (`user`, `session`, `account`, `verification`, `household`, `membership`, `invite`, `edition`, `bookcase`, `shelf`, `book`, `reading_status`, `tag`, `book_tag`, `contact`, `loan`, `schema_migrations`).

- [ ] **Step 6: Commit**

```bash
git add apps/api pnpm-lock.yaml
git commit -m "feat: api package with migration runner, auth tables, full domain schema"
```

---

### Task 4: RLS policies + isolation tests

**Files:**
- Create: `apps/api/migrations/0003_rls.sql`
- Create: `apps/api/src/db/tenant.ts`
- Create: `apps/api/vitest.config.ts`, `apps/api/test/global-setup.ts`, `apps/api/test/rls.test.ts`

- [ ] **Step 1: Write the RLS migration**

`apps/api/migrations/0003_rls.sql`:
```sql
-- App role: what the API uses for all tenant-data access. RLS applies to it.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'taakify_app') THEN
    CREATE ROLE taakify_app LOGIN PASSWORD 'taakify_app_dev';
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO taakify_app;
-- No DELETE grant anywhere: deletes are soft (UPDATE deleted_at).
GRANT SELECT, INSERT, UPDATE ON
  household, membership, invite, edition, bookcase, shelf, book,
  reading_status, tag, book_tag, contact, loan
TO taakify_app;

-- Membership lookup that bypasses RLS (SECURITY DEFINER, owned by the
-- migration superuser) to avoid policy recursion on membership itself.
CREATE FUNCTION app_user_households() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT household_id FROM membership
  WHERE user_id = current_setting('app.user_id', true)
    AND deleted_at IS NULL
$$;

ALTER TABLE household ENABLE ROW LEVEL SECURITY;
CREATE POLICY household_select ON household FOR SELECT
  USING (id IN (SELECT app_user_households()));
CREATE POLICY household_update ON household FOR UPDATE
  USING (id IN (SELECT app_user_households()));
-- No INSERT policy: households are created via the privileged pool (service op).

ALTER TABLE membership ENABLE ROW LEVEL SECURITY;
CREATE POLICY membership_select ON membership FOR SELECT
  USING (household_id IN (SELECT app_user_households()));
-- No INSERT/UPDATE policies: memberships change only via privileged service ops.

ALTER TABLE invite ENABLE ROW LEVEL SECURITY;
CREATE POLICY invite_select ON invite FOR SELECT
  USING (household_id IN (SELECT app_user_households()));
CREATE POLICY invite_insert ON invite FOR INSERT
  WITH CHECK (household_id IN (SELECT app_user_households()));
-- Acceptance (UPDATE) happens via the privileged pool: the accepting user
-- is not yet a member, so no RLS path can permit it.

-- Global catalog: readable/writable by any authenticated user.
ALTER TABLE edition ENABLE ROW LEVEL SECURITY;
CREATE POLICY edition_select ON edition FOR SELECT USING (true);
CREATE POLICY edition_insert ON edition FOR INSERT WITH CHECK (true);
CREATE POLICY edition_update ON edition FOR UPDATE USING (true);

-- Tenant data tables: uniform member-only CRUD (soft delete = UPDATE).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['bookcase','shelf','book','reading_status','tag','book_tag','contact','loan'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I_select ON %I FOR SELECT USING (household_id IN (SELECT app_user_households()))', t, t);
    EXECUTE format(
      'CREATE POLICY %I_insert ON %I FOR INSERT WITH CHECK (household_id IN (SELECT app_user_households()))', t, t);
    EXECUTE format(
      'CREATE POLICY %I_update ON %I FOR UPDATE USING (household_id IN (SELECT app_user_households()))', t, t);
  END LOOP;
END $$;
```

- [ ] **Step 2: Write the tenant transaction helper**

`apps/api/src/db/tenant.ts`:
```ts
import type pg from "pg";
import { appPool } from "./pool.js";

// Runs fn inside a transaction on the RLS-enforced pool with app.user_id set.
// Every RLS policy keys on this setting via app_user_households().
export async function withUser<T>(
  userId: string,
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await appPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
```

- [ ] **Step 3: Write test infrastructure**

`apps/api/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: "./test/global-setup.ts",
    fileParallelism: false, // tests share one database
    testTimeout: 15000,
  },
});
```

`apps/api/test/global-setup.ts`:
```ts
import pg from "pg";
import { migrate } from "../src/db/migrate.js";

const ADMIN = "postgresql://postgres:postgres@localhost:5433";
export const TEST_DB_URL = `${ADMIN}/taakify_test`;
export const TEST_APP_DB_URL = "postgresql://taakify_app:taakify_app_dev@localhost:5433/taakify_test";

export default async function setup() {
  const root = new pg.Pool({ connectionString: `${ADMIN}/postgres` });
  const { rowCount } = await root.query("SELECT 1 FROM pg_database WHERE datname = 'taakify_test'");
  if (!rowCount) await root.query("CREATE DATABASE taakify_test");
  await root.end();

  const db = new pg.Pool({ connectionString: TEST_DB_URL });
  await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await db.end();

  await migrate(TEST_DB_URL);

  // Point the app (imported by tests) at the test database.
  process.env.DATABASE_URL = TEST_DB_URL;
  process.env.APP_DATABASE_URL = TEST_APP_DB_URL;
  process.env.BETTER_AUTH_SECRET = "test-secret-test-secret-test-secret!";
  process.env.BETTER_AUTH_URL = "http://localhost:3001";
}
```
**Note:** `process.env` set in globalSetup does not propagate to test workers in vitest. Add `apps/api/test/env-setup.ts` and reference it as `setupFiles`:

```ts
// apps/api/test/env-setup.ts — runs in each test worker before tests
process.env.DATABASE_URL = "postgresql://postgres:postgres@localhost:5433/taakify_test";
process.env.APP_DATABASE_URL = "postgresql://taakify_app:taakify_app_dev@localhost:5433/taakify_test";
process.env.BETTER_AUTH_SECRET = "test-secret-test-secret-test-secret!";
process.env.BETTER_AUTH_URL = "http://localhost:3001";
```
And in `vitest.config.ts` add `setupFiles: ["./test/env-setup.ts"]` inside `test: {}`. (Keep the same values in globalSetup — it needs them for migration.)

- [ ] **Step 4: Write the failing RLS isolation test**

`apps/api/test/rls.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { withUser } from "../src/db/tenant.js";

const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function seedUser(id: string) {
  await admin.query(
    `INSERT INTO "user" ("id", "name", "email") VALUES ($1, $1, $2)`,
    [id, `${id}@test.local`]
  );
}

async function seedHousehold(name: string, ownerId: string): Promise<string> {
  const { rows } = await admin.query(
    "INSERT INTO household (name) VALUES ($1) RETURNING id", [name]
  );
  await admin.query(
    "INSERT INTO membership (household_id, user_id, role) VALUES ($1, $2, 'owner')",
    [rows[0].id, ownerId]
  );
  return rows[0].id;
}

describe("RLS household isolation", () => {
  const userA = `user-a-${randomUUID()}`;
  const userB = `user-b-${randomUUID()}`;
  let houseA: string;
  let houseB: string;

  beforeAll(async () => {
    await seedUser(userA);
    await seedUser(userB);
    houseA = await seedHousehold("House A", userA);
    houseB = await seedHousehold("House B", userB);
    const { rows } = await admin.query(
      "INSERT INTO edition (title) VALUES ('Sapiens') RETURNING id"
    );
    for (const [house, user] of [[houseA, userA], [houseB, userB]] as const) {
      await admin.query(
        "INSERT INTO book (household_id, edition_id, ownership, created_by) VALUES ($1, $2, 'owned', $3)",
        [house, rows[0].id, user]
      );
    }
  });

  afterAll(async () => await admin.end());

  it("a member sees only their own household's books", async () => {
    const books = await withUser(userA, async (c) =>
      (await c.query("SELECT household_id FROM book")).rows
    );
    expect(books.length).toBeGreaterThan(0);
    expect(books.every((b) => b.household_id === houseA)).toBe(true);
  });

  it("a member cannot insert into another household", async () => {
    const { rows } = await admin.query("SELECT id FROM edition LIMIT 1");
    await expect(
      withUser(userA, (c) =>
        c.query(
          "INSERT INTO book (household_id, edition_id, ownership, created_by) VALUES ($1, $2, 'owned', $3)",
          [houseB, rows[0].id, userA]
        )
      )
    ).rejects.toThrow(/row-level security/);
  });

  it("a user with no session setting sees nothing", async () => {
    const books = await withUser("nonexistent-user", async (c) =>
      (await c.query("SELECT id FROM book")).rows
    );
    expect(books).toHaveLength(0);
  });
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `pnpm --filter @taakify/api test test/rls.test.ts`
Expected: FAIL — migration 0003 not yet applied to the dev DB is fine (global-setup migrates the *test* DB, which will include 0003 once the file exists — so if Step 1's file is written, this may already PASS; if it fails, read the error: it must not be about missing tables).

- [ ] **Step 6: Apply migration to dev DB and re-run tests**

Run: `pnpm migrate && pnpm --filter @taakify/api test test/rls.test.ts`
Expected: `Applied: 0003_rls.sql`, then all 3 tests PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api
git commit -m "feat: RLS policies with app role, tenant transaction helper, isolation tests"
```

---

### Task 5: Hono app + health endpoint

**Files:**
- Create: `apps/api/src/app.ts`, `apps/api/src/index.ts`
- Create: `apps/api/test/health.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/api/test/health.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { app } from "../src/app.js";

describe("health", () => {
  it("responds ok", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @taakify/api test test/health.test.ts`
Expected: FAIL — `Cannot find module '../src/app.js'`

- [ ] **Step 3: Write the app**

`apps/api/src/app.ts`:
```ts
import { Hono } from "hono";

export const app = new Hono();

app.get("/api/health", (c) => c.json({ ok: true }));
```

`apps/api/src/index.ts`:
```ts
import { serve } from "@hono/node-server";
import "dotenv/config";
import { app } from "./app.js";

const port = Number(process.env.PORT ?? 3001);
serve({ fetch: app.fetch, port });
console.log(`API listening on :${port}`);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @taakify/api test test/health.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/app.ts apps/api/src/index.ts apps/api/test/health.test.ts
git commit -m "feat: hono app with health endpoint"
```

---

### Task 6: better-auth wiring (signup/login/session)

**Files:**
- Create: `apps/api/src/auth.ts`, `apps/api/src/middleware/session.ts`
- Modify: `apps/api/src/app.ts`
- Create: `apps/api/test/helpers.ts`
- Test: extend `apps/api/test/health.test.ts` scope with a new `apps/api/test/auth.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/api/test/helpers.ts`:
```ts
import type { Hono } from "hono";
import { randomUUID } from "node:crypto";

// Signs up a fresh user via the real auth endpoint; returns its session cookie.
export async function signUp(
  app: Hono,
  email = `${randomUUID()}@test.local`
): Promise<{ cookie: string; email: string }> {
  const res = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password-123", name: "Test User" }),
  });
  if (res.status !== 200) throw new Error(`signup failed: ${res.status} ${await res.text()}`);
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("no session cookie returned");
  return { cookie: setCookie.split(";")[0], email };
}
```

`apps/api/test/auth.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { app } from "../src/app.js";
import { signUp } from "./helpers.js";

describe("auth", () => {
  it("signs up and establishes a session", async () => {
    const { cookie, email } = await signUp(app);
    const res = await app.request("/api/me", { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.email).toBe(email);
    expect(body.memberships).toEqual([]);
  });

  it("rejects unauthenticated /api/me", async () => {
    const res = await app.request("/api/me");
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @taakify/api test test/auth.test.ts`
Expected: FAIL — signup endpoint 404 (auth not mounted).

- [ ] **Step 3: Implement auth**

`apps/api/src/auth.ts`:
```ts
import { betterAuth } from "better-auth";
import { adminPool } from "./db/pool.js";

export const auth = betterAuth({
  database: adminPool,
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,
  basePath: "/api/auth",
  emailAndPassword: { enabled: true },
  trustedOrigins: ["http://localhost:5173"],
});
```

`apps/api/src/middleware/session.ts`:
```ts
import { createMiddleware } from "hono/factory";
import { auth } from "../auth.js";

export type SessionUser = { id: string; email: string; name: string };

export const requireUser = createMiddleware<{ Variables: { user: SessionUser } }>(
  async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: "unauthorized" }, 401);
    c.set("user", session.user as SessionUser);
    await next();
  }
);
```

Modify `apps/api/src/app.ts` to become:
```ts
import { Hono } from "hono";
import { auth } from "./auth.js";
import { requireUser } from "./middleware/session.js";
import { withUser } from "./db/tenant.js";

export const app = new Hono();

app.get("/api/health", (c) => c.json({ ok: true }));

app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));

app.get("/api/me", requireUser, async (c) => {
  const user = c.get("user");
  const memberships = await withUser(user.id, async (client) => {
    const { rows } = await client.query(
      `SELECT m.household_id, m.role, h.name AS household_name
       FROM membership m JOIN household h ON h.id = m.household_id
       WHERE m.deleted_at IS NULL AND h.deleted_at IS NULL`
    );
    return rows;
  });
  return c.json({ user: { id: user.id, email: user.email, name: user.name }, memberships });
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @taakify/api test`
Expected: all tests PASS (auth, health, rls).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src apps/api/test
git commit -m "feat: better-auth signup/login with session middleware and /api/me"
```

---

### Task 7: Household creation

**Files:**
- Create: `apps/api/src/routes/households.ts`
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/test/households.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/api/test/households.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { app } from "../src/app.js";
import { signUp } from "./helpers.js";

describe("households", () => {
  it("creates a household with the creator as owner", async () => {
    const { cookie } = await signUp(app);
    const res = await app.request("/api/households", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Test Family Library" }),
    });
    expect(res.status).toBe(201);
    const { household } = await res.json();
    expect(household.name).toBe("Test Family Library");

    const me = await (await app.request("/api/me", { headers: { cookie } })).json();
    expect(me.memberships).toHaveLength(1);
    expect(me.memberships[0].role).toBe("owner");
    expect(me.memberships[0].household_id).toBe(household.id);
  });

  it("rejects empty names", async () => {
    const { cookie } = await signUp(app);
    const res = await app.request("/api/households", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "   " }),
    });
    expect(res.status).toBe(400);
  });

  it("requires auth", async () => {
    const res = await app.request("/api/households", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "X" }),
    });
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @taakify/api test test/households.test.ts`
Expected: FAIL — 404 on POST /api/households.

- [ ] **Step 3: Implement the route**

`apps/api/src/routes/households.ts`:
```ts
import { Hono } from "hono";
import { adminPool } from "../db/pool.js";
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
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});
```

Modify `apps/api/src/app.ts` — add after the `/api/me` route:
```ts
import { households } from "./routes/households.js";
// ...
app.route("/api/households", households);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @taakify/api test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src apps/api/test/households.test.ts
git commit -m "feat: household creation with owner membership"
```

---

### Task 8: Invites (create, inspect, accept)

**Files:**
- Create: `apps/api/src/routes/invites.ts`
- Modify: `apps/api/src/app.ts`, `apps/api/src/routes/households.ts`
- Test: `apps/api/test/invites.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/api/test/invites.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { app } from "../src/app.js";
import { signUp } from "./helpers.js";

async function createHousehold(cookie: string, name = "Invite Test House") {
  const res = await app.request("/api/households", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return (await res.json()).household as { id: string; name: string };
}

describe("invites", () => {
  it("owner invites, invitee inspects and accepts", async () => {
    const owner = await signUp(app);
    const house = await createHousehold(owner.cookie);

    const inviteRes = await app.request(`/api/households/${house.id}/invites`, {
      method: "POST",
      headers: { cookie: owner.cookie, "content-type": "application/json" },
      body: JSON.stringify({ email: "spouse@test.local", role: "admin" }),
    });
    expect(inviteRes.status).toBe(201);
    const { token } = await inviteRes.json();
    expect(token).toBeTruthy();

    // Anyone with the link can inspect it (pre-signup screen).
    const info = await (await app.request(`/api/invites/${token}`)).json();
    expect(info.householdName).toBe("Invite Test House");
    expect(info.role).toBe("admin");

    const invitee = await signUp(app);
    const accept = await app.request(`/api/invites/${token}/accept`, {
      method: "POST",
      headers: { cookie: invitee.cookie },
    });
    expect(accept.status).toBe(200);

    const me = await (await app.request("/api/me", { headers: { cookie: invitee.cookie } })).json();
    expect(me.memberships).toHaveLength(1);
    expect(me.memberships[0].role).toBe("admin");
    expect(me.memberships[0].household_id).toBe(house.id);
  });

  it("a non-admin member cannot create invites", async () => {
    const owner = await signUp(app);
    const house = await createHousehold(owner.cookie);
    const outsider = await signUp(app);
    const res = await app.request(`/api/households/${house.id}/invites`, {
      method: "POST",
      headers: { cookie: outsider.cookie, "content-type": "application/json" },
      body: JSON.stringify({ email: "x@test.local", role: "member" }),
    });
    expect(res.status).toBe(403);
  });

  it("an invite cannot be accepted twice", async () => {
    const owner = await signUp(app);
    const house = await createHousehold(owner.cookie);
    const { token } = await (
      await app.request(`/api/households/${house.id}/invites`, {
        method: "POST",
        headers: { cookie: owner.cookie, "content-type": "application/json" },
        body: JSON.stringify({ email: "y@test.local", role: "member" }),
      })
    ).json();

    const first = await signUp(app);
    expect(
      (await app.request(`/api/invites/${token}/accept`, { method: "POST", headers: { cookie: first.cookie } })).status
    ).toBe(200);
    const second = await signUp(app);
    expect(
      (await app.request(`/api/invites/${token}/accept`, { method: "POST", headers: { cookie: second.cookie } })).status
    ).toBe(410);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @taakify/api test test/invites.test.ts`
Expected: FAIL — 404 on the invite endpoints.

- [ ] **Step 3: Implement invites**

`apps/api/src/routes/invites.ts`:
```ts
import { Hono } from "hono";
import { randomBytes } from "node:crypto";
import { adminPool } from "../db/pool.js";
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

  // RLS scopes the membership check to the caller's households.
  const canInvite = await withUser(user.id, async (client) => {
    const { rows } = await client.query(
      `SELECT role FROM membership
       WHERE household_id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [householdId, user.id]
    );
    return rows[0]?.role === "owner" || rows[0]?.role === "admin";
  });
  if (!canInvite) return c.json({ error: "forbidden" }, 403);

  const token = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86400_000);
  await withUser(user.id, (client) =>
    client.query(
      `INSERT INTO invite (household_id, email, role, token, expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [householdId, email, role, token, expiresAt, user.id]
    )
  );
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
    if (!invite) { await client.query("ROLLBACK"); return c.json({ error: "not found" }, 404); }
    if (invite.accepted_at) { await client.query("ROLLBACK"); return c.json({ error: "already accepted" }, 410); }
    if (new Date(invite.expires_at) < new Date()) { await client.query("ROLLBACK"); return c.json({ error: "expired" }, 410); }

    await client.query(
      `INSERT INTO membership (household_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (household_id, user_id) DO NOTHING`,
      [invite.household_id, user.id, invite.role]
    );
    await client.query(
      "UPDATE invite SET accepted_at = now(), updated_at = now() WHERE id = $1",
      [invite.id]
    );
    await client.query("COMMIT");
    return c.json({ householdId: invite.household_id });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});
```

Modify `apps/api/src/app.ts` — add:
```ts
import { householdInvites, invites } from "./routes/invites.js";
// ...
app.route("/api/households/:householdId/invites", householdInvites);
app.route("/api/invites", invites);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @taakify/api test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src apps/api/test/invites.test.ts
git commit -m "feat: invite create/inspect/accept flow"
```

---

### Task 9: Web app scaffold

**Files:**
- Create: `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/vite.config.ts`, `apps/web/index.html`
- Create: `apps/web/src/main.tsx`, `apps/web/src/App.tsx`, `apps/web/src/styles.css`
- Create: `apps/web/src/lib/auth.ts`, `apps/web/src/lib/api.ts`

- [ ] **Step 1: Create the package**

`apps/web/package.json`:
```json
{
  "name": "@taakify/web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "better-auth": "^1.3.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "react-router-dom": "^7.1.0"
  },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.0",
    "typescript": "^5.7.0",
    "vite": "^6.0.0"
  }
}
```
(Keep `better-auth` the same version as the API — its client and server must match.)

`apps/web/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"]
  },
  "include": ["src"]
}
```

`apps/web/vite.config.ts`:
```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { "/api": "http://localhost:3001" },
  },
});
```

`apps/web/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Taakify</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 2: Write libs, styles, and app shell**

`apps/web/src/lib/auth.ts`:
```ts
import { createAuthClient } from "better-auth/react";

// Same origin in dev (vite proxy) and prod (nginx) — no baseURL needed
// beyond the path prefix.
export const authClient = createAuthClient({ basePath: "/api/auth" });
```

`apps/web/src/lib/api.ts`:
```ts
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "content-type": "application/json", ...init?.headers },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export type Me = {
  user: { id: string; email: string; name: string };
  memberships: { household_id: string; role: string; household_name: string }[];
};
```

`apps/web/src/styles.css`:
```css
:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
body { margin: 0; display: grid; place-items: center; min-height: 100dvh; }
main { width: min(420px, 92vw); padding: 1.5rem; }
h1 { font-size: 1.4rem; }
form { display: grid; gap: 0.75rem; }
input, button { font: inherit; padding: 0.65rem 0.8rem; border-radius: 8px; border: 1px solid #8886; }
button { cursor: pointer; font-weight: 600; }
.error { color: #c0392b; }
.muted { opacity: 0.7; font-size: 0.9rem; }
```
(Deliberately minimal — real visual design is a later plan's job; Plan 1 UI just needs to work.)

`apps/web/src/main.tsx`:
```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App.js";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>
);
```

`apps/web/src/App.tsx`:
```tsx
import { Routes, Route, Navigate } from "react-router-dom";
import { authClient } from "./lib/auth.js";
import { SignUp } from "./pages/SignUp.js";
import { SignIn } from "./pages/SignIn.js";
import { Onboarding } from "./pages/Onboarding.js";
import { InviteAccept } from "./pages/InviteAccept.js";
import { Home } from "./pages/Home.js";

export function App() {
  const { data: session, isPending } = authClient.useSession();
  if (isPending) return <main className="muted">Loading…</main>;
  const authed = Boolean(session);

  return (
    <Routes>
      <Route path="/signup" element={authed ? <Navigate to="/" /> : <SignUp />} />
      <Route path="/signin" element={authed ? <Navigate to="/" /> : <SignIn />} />
      <Route path="/invite/:token" element={<InviteAccept authed={authed} />} />
      <Route path="/onboarding" element={authed ? <Onboarding /> : <Navigate to="/signin" />} />
      <Route path="/" element={authed ? <Home /> : <Navigate to="/signin" />} />
    </Routes>
  );
}
```

- [ ] **Step 3: Verify install and typecheck (pages don't exist yet, so expect failure)**

Run: `pnpm install && pnpm --filter @taakify/web typecheck`
Expected: FAIL — missing `./pages/*` modules. That's Task 10.

- [ ] **Step 4: Commit the scaffold**

```bash
git add apps/web pnpm-lock.yaml
git commit -m "feat: web app scaffold with vite, router, auth client"
```

---

### Task 10: Web pages (auth, onboarding, invite, home)

**Files:**
- Create: `apps/web/src/pages/SignUp.tsx`, `SignIn.tsx`, `Onboarding.tsx`, `InviteAccept.tsx`, `Home.tsx`

- [ ] **Step 1: Write the pages**

`apps/web/src/pages/SignUp.tsx`:
```tsx
import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { authClient } from "../lib/auth.js";

export function SignUp() {
  const [error, setError] = useState("");
  const navigate = useNavigate();

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const { error } = await authClient.signUp.email({
      name: String(data.get("name")),
      email: String(data.get("email")),
      password: String(data.get("password")),
    });
    if (error) return setError(error.message ?? "Sign-up failed");
    navigate("/onboarding");
  }

  return (
    <main>
      <h1>Create your Taakify account</h1>
      <form onSubmit={onSubmit}>
        <input name="name" placeholder="Your name" required />
        <input name="email" type="email" placeholder="Email" required />
        <input name="password" type="password" placeholder="Password (8+ chars)" minLength={8} required />
        <button type="submit">Sign up</button>
        {error && <p className="error">{error}</p>}
      </form>
      <p className="muted">Already have an account? <Link to="/signin">Sign in</Link></p>
    </main>
  );
}
```

`apps/web/src/pages/SignIn.tsx`:
```tsx
import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { authClient } from "../lib/auth.js";

export function SignIn() {
  const [error, setError] = useState("");
  const navigate = useNavigate();

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const { error } = await authClient.signIn.email({
      email: String(data.get("email")),
      password: String(data.get("password")),
    });
    if (error) return setError(error.message ?? "Sign-in failed");
    navigate("/");
  }

  return (
    <main>
      <h1>Sign in to Taakify</h1>
      <form onSubmit={onSubmit}>
        <input name="email" type="email" placeholder="Email" required />
        <input name="password" type="password" placeholder="Password" required />
        <button type="submit">Sign in</button>
        {error && <p className="error">{error}</p>}
      </form>
      <p className="muted">New here? <Link to="/signup">Create an account</Link></p>
    </main>
  );
}
```

`apps/web/src/pages/Onboarding.tsx`:
```tsx
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api.js";

export function Onboarding() {
  const [error, setError] = useState("");
  const navigate = useNavigate();

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const name = String(new FormData(e.currentTarget).get("name"));
    try {
      await api("/api/households", { method: "POST", body: JSON.stringify({ name }) });
      navigate("/");
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <main>
      <h1>Name your library</h1>
      <p className="muted">This is your household's shared bookshelf. You can invite family after.</p>
      <form onSubmit={onSubmit}>
        <input name="name" placeholder="e.g. Our Family Library" required />
        <button type="submit">Create library</button>
        {error && <p className="error">{error}</p>}
      </form>
    </main>
  );
}
```

`apps/web/src/pages/InviteAccept.tsx`:
```tsx
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../lib/api.js";

type Info = { householdName: string; email: string; role: string };

export function InviteAccept({ authed }: { authed: boolean }) {
  const { token } = useParams();
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState("");
  const navigate = useNavigate();

  useEffect(() => {
    api<Info>(`/api/invites/${token}`).then(setInfo).catch((e) => setError(e.message));
  }, [token]);

  async function accept() {
    try {
      await api(`/api/invites/${token}/accept`, { method: "POST" });
      navigate("/");
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (error) return <main><p className="error">Invite problem: {error}</p></main>;
  if (!info) return <main className="muted">Loading invite…</main>;

  return (
    <main>
      <h1>Join “{info.householdName}”</h1>
      <p className="muted">You've been invited as {info.role} ({info.email}).</p>
      {authed ? (
        <button onClick={accept}>Accept invite</button>
      ) : (
        <p>
          First <Link to={`/signup?next=/invite/${token}`}>create an account</Link> or{" "}
          <Link to={`/signin?next=/invite/${token}`}>sign in</Link>, then reopen this link.
        </p>
      )}
    </main>
  );
}
```

`apps/web/src/pages/Home.tsx`:
```tsx
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Me } from "../lib/api.js";
import { authClient } from "../lib/auth.js";

export function Home() {
  const [me, setMe] = useState<Me | null>(null);
  const [inviteUrl, setInviteUrl] = useState("");

  useEffect(() => {
    api<Me>("/api/me").then(setMe);
  }, []);

  async function invite(householdId: string) {
    const email = prompt("Invitee's email?");
    if (!email) return;
    const { url } = await api<{ url: string }>(`/api/households/${householdId}/invites`, {
      method: "POST",
      body: JSON.stringify({ email, role: "member" }),
    });
    setInviteUrl(`${location.origin}${url}`);
  }

  if (!me) return <main className="muted">Loading…</main>;
  if (me.memberships.length === 0)
    return (
      <main>
        <h1>Welcome, {me.user.name}</h1>
        <p>You're not in a library yet.</p>
        <Link to="/onboarding">Create your library</Link>
      </main>
    );

  return (
    <main>
      <h1>{me.memberships[0].household_name}</h1>
      <p className="muted">Signed in as {me.user.email} ({me.memberships[0].role})</p>
      <button onClick={() => invite(me.memberships[0].household_id)}>Invite a family member</button>
      {inviteUrl && (
        <p>
          Share this link: <code>{inviteUrl}</code>
        </p>
      )}
      <p className="muted">Books arrive in Plan 3. Sync arrives in Plan 2.</p>
      <button onClick={() => authClient.signOut().then(() => location.reload())}>Sign out</button>
    </main>
  );
}
```

- [ ] **Step 2: Verify typecheck and build**

Run: `pnpm --filter @taakify/web typecheck && pnpm --filter @taakify/web build`
Expected: both succeed.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/pages
git commit -m "feat: web auth, onboarding, invite, and home pages"
```

---

### Task 11: End-to-end manual verification + README

**Files:**
- Create: `README.md`

- [ ] **Step 1: Run the full stack**

```bash
docker compose -f docker-compose.dev.yml up -d
pnpm migrate
pnpm dev:api &
pnpm dev:web
```

- [ ] **Step 2: Walk the journey in a browser (http://localhost:5173)**

1. Sign up as yourself → land on onboarding → create "Family Library" → Home shows the library name and your role `owner`.
2. Click "Invite a family member", enter an email → copy the invite link.
3. Open the invite link in a private/incognito window → invite landing shows household name → create the second account → reopen invite link → Accept → Home shows the same library, role `member`.
4. Confirm isolation: sign up a third account in another private window, create its own household → its Home never shows your library.

Expected: every step works; note anything broken and fix before proceeding.

- [ ] **Step 3: Run the whole test suite one final time**

Run: `pnpm test`
Expected: all tests PASS.

- [ ] **Step 4: Write the README**

`README.md`:
```markdown
# Taakify

A local-first home bookshelf organizer: catalog your books, track each family
member's reading, lend books out (and get them back), and remember what you
borrowed. Multi-tenant from day one.

**Spec:** docs/superpowers/specs/2026-07-16-taakify-bookshelf-design.md
**Plans:** docs/superpowers/plans/

## Stack

React + Vite PWA · PGlite (in-browser Postgres) · ElectricSQL (sync) ·
Hono API · better-auth · Postgres · Docker Compose on a single VM ·
Cloudflare R2 for cover images.

## Development

Prereqs: Docker, Node 22, pnpm.

    docker compose -f docker-compose.dev.yml up -d   # postgres :5433, electric :3010
    pnpm install
    cp apps/api/.env.example apps/api/.env
    pnpm migrate
    pnpm dev:api    # :3001
    pnpm dev:web    # :5173

Tests: `pnpm test` (uses the taakify_test database on the same Postgres).
```

- [ ] **Step 5: Commit and push**

```bash
git add README.md
git commit -m "docs: README with dev setup"
git push
```

---

## Plan 1 exit criteria

- `pnpm test` green: health, auth, RLS isolation (3 tests), households (3), invites (3).
- Manual journey verified: sign up → create household → invite → second user joins → third user's household is isolated.
- Full domain schema (all 12 spec tables + auth tables) migrated with RLS enforced for the app role.
- Electric container boots against the dev Postgres (proves wal_level config) — actual sync is Plan 2.
