# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Taakify: a local-first home bookshelf organizer (catalog books, track each
family member's reading, lend books out, remember what you borrowed).
Multi-tenant from day one — tenant = "household".

Spec: `docs/superpowers/specs/2026-07-16-taakify-bookshelf-design.md`
Plans: `docs/superpowers/plans/`

Stack: React + Vite PWA · PGlite (in-browser Postgres) · ElectricSQL (sync) ·
Hono API · better-auth (email/password + Google) · Postgres · Docker Compose.
Sync is fully wired up (Plan 3): every book-domain screen reads/writes
against a PGlite mirror kept live by an Electric shape stream, with offline
writes queued in a client outbox — see "### Local-first sync" below.

pnpm workspace: `apps/api` (`@taakify/api`), `apps/web` (`@taakify/web`).

## Commands

Setup (from repo root):

```
docker compose -f docker-compose.dev.yml up -d   # postgres :5433, electric :3010
pnpm install
cp apps/api/.env.example apps/api/.env
pnpm migrate
```

Run:

```
pnpm dev:api    # :3001
pnpm dev:web    # :5173 (proxies /api -> :3001)
```

Test:

```
pnpm test                                   # from root, runs both @taakify/api and @taakify/web tests
pnpm --filter @taakify/api test -- households.test.ts   # single api file
pnpm --filter @taakify/api test -- -t "some test name"  # single api test by name
pnpm --filter @taakify/web test -- SignIn.test.tsx      # single web file
```

API tests run against a real Postgres (`taakify_test` db on the same :5433
instance, dropped/recreated and migrated fresh via `test/global-setup.ts`).
`fileParallelism` is disabled (vitest.config.ts) because all test files share
one database — don't re-enable it without giving each file its own schema/db.
Web tests use vitest + Testing Library with jsdom (no real backend).

Typecheck: `pnpm --filter @taakify/api typecheck` / `pnpm --filter @taakify/web typecheck`
(also run as part of `pnpm --filter @taakify/web build`).

No lint script configured in either package yet.

## Architecture

### Two Postgres roles, one database

- `adminPool` (`DATABASE_URL`) — privileged superuser-ish connection. Used for
  migrations, better-auth's own tables, and **service operations** that by
  definition can't be authorized by RLS yet (creating a household before any
  membership exists, accepting an invite before the acceptor is a member).
- `appPool()` (`APP_DATABASE_URL`) — connects as the `taakify_app` role, which
  RLS policies apply to. This is the pool for **all normal tenant-data reads
  and writes**. Grants on this role are least-privilege and deliberately
  mirror the RLS policy surface (see `migrations/0003_rls.sql`); there is no
  `DELETE` grant anywhere — deletes are always soft (`UPDATE deleted_at`).

Route handlers pick a pool explicitly per-operation; there's no automatic
routing. When adding a new tenant-data endpoint, use `withUser` (below), not
`adminPool`, unless the operation is genuinely privileged (no membership
exists yet to authorize it via RLS).

### `withUser` — the standard way to touch tenant data

`apps/api/src/db/tenant.ts` wraps a transaction on `appPool()`, sets
`app.user_id` via `set_config` for the duration of the transaction, and
commits/rolls back around the callback. Every RLS policy reads
`current_setting('app.user_id', true)` (indirectly, through
`app_user_households()`). Always go through `withUser`, not raw `appPool()`
queries — the RLS policies are meaningless without `app.user_id` set.

### RLS model (`migrations/0003_rls.sql`)

- `app_user_households()` is a `SECURITY DEFINER` function that looks up the
  caller's household memberships bypassing RLS — this avoids infinite policy
  recursion on the `membership` table itself. Every tenant-scoped policy
  (`household`, `invite`, and the uniform per-table policies for
  `bookcase`, `shelf`, `book`, `reading_status`, `tag`, `book_tag`,
  `contact`, `loan`) checks `household_id IN (SELECT app_user_households())`.
- `edition` is a global shared catalog (no `household_id`) — open
  select/insert/update to any authenticated app-role connection.
- Tables with no INSERT/UPDATE policy (`household` insert, `membership`
  insert/update) are intentionally service-op-only: those mutations happen
  on `adminPool` inside a handler that has already done its own
  authorization check in application code (see `routes/households.ts`,
  `routes/invites.ts` accept flow).
- New tenant tables should follow the same three-policy shape (select/insert/
  update by `household_id`) and get added to the `FOREACH` loop pattern, plus
  a `GRANT` in the same migration style — RLS policies alone don't grant
  privileges; the role grants and RLS are meant to mirror each other.

### Auth

`apps/api/src/auth.ts` configures better-auth (email/password + optional
Google, gated on `GOOGLE_CLIENT_ID`/`SECRET` being set) directly on
`adminPool`, mounted at `/api/auth/*` via `app.all` in `app.ts` (better-auth
does its own method dispatch under that path). `BETTER_AUTH_SECRET` is
required at startup — better-auth's dev-secret fallback is intentionally
disabled (see the throw in `auth.ts`).

`middleware/session.ts`'s `requireUser` calls `auth.api.getSession` and
treats any thrown error (malformed cookie, transient store failure) the same
as "no session" — 401, not a 500.

On the client, `apps/web/src/lib/safe-next.ts` guards any `?next=` redirect
target used after auth — only in-app absolute paths are honored, to close
the open-redirect hole a tampered `//evil.com` `next` param would otherwise
open.

### Invites

Two-step, token-based, and deliberately not email-bound: `invite.email` is
informational only (see the comment in `routes/invites.ts`) — acceptance is
authorized purely by possessing the token, since links are hand-shared and
the invitee may sign up under a different address. Revisit if/when public
self-serve signup lands. Accept runs on `adminPool` with `SELECT ... FOR
UPDATE` on the invite row to avoid a double-accept race.

### Soft deletes everywhere

Every tenant table has `deleted_at timestamptz`; there is no hard delete
path (no `DELETE` grant on `taakify_app`). Uniqueness constraints that need
to allow re-use of a value after "deletion" use partial unique indexes
scoped to `WHERE deleted_at IS NULL` (see `membership_live_uniq`,
`tag_live_uniq`, `reading_status_live_uniq`, `book_tag_live_uniq`) — follow
this pattern for any new per-tenant-unique column.

### Web app

Plain React Router v4-style route table in `App.tsx`, gated on
`authClient.useSession()` (better-auth's React client). No global state
library or data-fetching library yet — `lib/api.ts`'s `api()` helper is a
thin `fetch` wrapper (always `credentials: "include"`, throws on non-2xx
using the JSON `error` field if present). `api()` is now only for
auth/household/invite calls; book-domain screens go through the repo layer
below instead.

### Local-first sync

- `apps/web/src/lib/db/pglite.ts` — a singleton `PGlite` instance persisted
  to IndexedDB (`dataDir: "idb://taakify"`), with its schema applied from
  `mirror-schema.sql` on first use. Its `ready` promise covers both process
  startup and schema application; every repo/sync function awaits it before
  querying. `IDB_DATABASE_NAME` records the real underlying IndexedDB
  database name (`/pglite/taakify`, not `"taakify"`) so sign-out can delete
  it precisely.
- `apps/web/src/lib/sync/shape.ts` — one Electric `ShapeStream` per
  household-scoped mirror table (`bookcase`, `shelf`, `book`,
  `reading_status`, `tag`, `book_tag`, `contact`, `loan`) plus one for the
  global `edition` catalog, each applying incoming changes into PGlite with
  last-write-wins on `updated_at`. Framework-agnostic (no React), driven
  from an effect in `AppShell.tsx`.
- `apps/web/src/lib/sync/outbox.ts` — the offline write queue. `enqueue()`
  records the HTTP request to replay (endpoint/method/body) in an `outbox`
  mirror table and applies an optimistic write to the relevant mirror
  table, atomically, in one PGlite transaction. `flush()` replays due rows
  against the real API with exponential backoff
  (`BACKOFF_SCHEDULE_MS = [1s, 2s, 5s, 15s, 60s]`); a row that exhausts the
  schedule is dead-lettered (`status = 'dead'`) and surfaced via a toast
  with Retry, never silently dropped. Retries also resume on the browser's
  `online` event and a periodic timer (`startOutboxWorker`).
- `apps/web/src/lib/repo/` (`books.ts`, `shelves.ts`, `tags.ts`,
  `contacts.ts`, `loans.ts`, `reading-status.ts`) — the layer screens call
  instead of `api()` for tenant data: reads run SQL directly against the
  PGlite mirror (mirroring the corresponding `apps/api/src/routes/*.ts`
  query, filters, and joins), writes call `enqueue()`. Mutating repo
  functions generate row ids client-side and pass them through in the
  outbox request body; the API's `POST` handlers upsert on
  `ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id` so a retried outbox row
  and the eventual synced row converge on one id instead of duplicating.
- `apps/api/src/routes/bootstrap.ts` — cold-start seeding endpoint. Column
  lists there mirror `mirror-schema.sql` (and, in turn, `shape.ts`'s
  `COLUMNS`) exactly, returning flat per-table rows (not the nested
  book+edition/loan+book+contact envelopes the list/detail routes return)
  so the web side can upsert them straight into the matching mirror table
  on first load, before the shape stream has caught up.
