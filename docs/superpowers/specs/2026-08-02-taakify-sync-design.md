# Taakify Local-First Sync: Design Spec

**Date:** 2026-08-02
**Status:** Approved for planning (layers on top of the Books plan)
**Scope:** new `packages/shared` package, new `apps/web` local-data layer, API write-path changes, Electric server config. **No schema changes.**

## 1. Overview

The foundational spec (§3) describes a local-first architecture: every
device runs a full copy of the household's data in an in-browser Postgres
(PGlite), reads/writes are local and instant, and an ElectricSQL sync engine
replicates Postgres → devices in the background. Offline writes queue in a
client outbox and are retried against the Hono API.

Plan 1 (Foundation) shipped the Postgres + RLS + API spine and booted the
Electric container to prove `wal_level=logical`. The Books plan shipped the
entire book domain as an **online API-first feature**. **This plan layers
local-first sync on top of that working domain** — the books, shelves, loans,
and screens all keep working; we insert a PGlite local DB under them and an
Electric read-path + outbox write-path around them.

Feature-first ordering pays off here: instead of integrating sync against an
empty schema, this plan syncs a real, exercised domain, which makes shape
design and conflict observation meaningful from the first task.

## 2. Goals & Non-Goals

Goals (this plan):

- **Instant local reads.** All book/shelf/loan/tag/contact/reading-status
  reads hit PGlite (IndexedDB-persisted), not the network. The UI feels
  instant and works fully offline. This includes search: the Books plan
  (its spec's §2 non-goal table) scoped search to server-side `ILIKE` for
  that plan's online-only phase — correct at the time — and this plan
  upgrades it, as promised there. `apps/web/src/lib/repo/books.ts`'s
  `listBooks` (shipped in Task 6) now runs a case-insensitive `LIKE` (with
  `\`-escaped metacharacters, matching the server's `ILIKE` semantics)
  against the local PGlite mirror instead of issuing a network request, so
  search is instant and works offline like every other read in this plan.
- **Offline writes via a client outbox.** Mutations write to PGlite
  immediately (UI updates instantly) and enqueue in a persisted outbox that
  retries against the existing Hono API write endpoints. Survives app
  restarts and dropped connections.
- **ElectricSQL read-path sync.** Postgres → PGlite streaming, partitioned
  per household via Electric shapes. A device only ever receives its own
  household's rows (plus the global `edition` rows its books reference).
- **Conflict resolution: last-write-wins** via `updated_at` (foundational
  spec §3). Loan returns stay idempotent.
- **A shared types package** (`packages/shared`) so client and server agree
  on row shapes — the package Plan 1 deliberately deferred.

Non-Goals (deferred):

- **ElectricSQL auth for production** — dev uses `ELECTRIC_INSECURE=true`
  (already set in Plan 1's docker-compose); production auth config is the
  deploy plan. This plan proves sync end-to-end in dev.
- **Multi-shape federation / partial `edition` replication tuning** beyond
  the household partition — the global `edition` table syncs the rows the
  household's books reference; we implement the simple version and note
  tuning as a follow-up.
- **Camera cover-photo upload's offline queue** — the storage interface is
  added here, but cover photos remain a follow-up (the Books plan uses
  online cover URLs only).
- **Re-evaluating last-write-wins.** Domain conflicts remain rare/benign
  per the foundational spec; richer merge is out of scope.

## 3. Architecture (delta on top of the current stack)

```
                   ┌─────────────────────────────┐
   Browser  ─────▶ │  apps/web (React + Vite)     │
                   │  ┌────────────────────────┐  │
                   │  │ UI screens (Books plan)│  │  ← unchanged; now read/write
                   │  └───────────┬────────────┘  │     via the local data layer
                   │              ▼               │
                   │  ┌────────────────────────┐  │
                   │  │ local data layer        │  │  ← NEW: a thin repo abstraction
                   │  │ (reads→PGlite,          │  │     over PGlite (reads) +
                   │  │  writes→outbox+PGlite)  │  │     outbox+API (writes)
                   │  └───┬───────────────┬─────┘  │
                   │      ▼               ▼       │
                   │  PGlite          outbox       │  ← NEW: PGlite (IndexedDB),
                   │  (local DB)     (persisted    │     persisted; outbox table
                   │                   queue)      │     inside PGlite
                   │      │               │       │
                   └──────┼───────────────┼───────┘
                          ▼               ▼
            Electric shape stream    existing /api write endpoints
            (Postgres→PGlite)        (books, loans, … from the Books plan)
                          │               │
                          ▼               ▼
                   ┌─────────────────────────────────┐
                   │  Postgres (source of truth, RLS) │
                   └─────────────────────────────────┘
```

**Reads** flow PGlite → UI (no network). **Writes** flow UI → outbox + PGlite
(optimistic) → API → Postgres → Electric stream → other devices' PGlite.

**Why keep the API write path:** the Books plan's endpoints already validate
input and enforce RLS. The outbox talks to those same endpoints, so server-
side authority and tenancy enforcement are unchanged. PGlite is a **cache +
offline buffer**, never the source of truth.

## 4. Component Responsibilities

### `packages/shared` (NEW)

- Row type definitions for every synced table (`Book`, `Edition`,
  `ReadingStatus`, `Loan`, `Contact`, `Tag`, `BookTag`, `Bookcase`, `Shelf`).
- Enum unions (`Ownership`, `ReadingState`, `LoanDirection`, etc.) —
  currently duplicated as string literals across API and web; centralized
  here.
- API request/response contracts for the write endpoints (so the outbox
  builds typed payloads).
- Pure helpers that must match on both sides: the overdue computation
  (`returned_date IS NULL AND due_date < today`), ownership-badge logic.
  The Books plan computes these server-side; this plan extracts the pure
  forms into `shared` so PGlite reads can compute them locally without a
  round-trip.

### `apps/web` local data layer (NEW)

- `src/lib/db/pglite.ts` — opens the PGlite instance (persisted to
  IndexedDB), runs a bootstrap that creates the local mirror schema
  (mirrors the server tables minus auth).
- `src/lib/sync/shape.ts` — Electric client: subscribes to the household
  shape on auth, applies incoming operations into PGlite.
- `src/lib/sync/outbox.ts` — the write queue: enqueue, retry-with-backoff,
  ack on 2xx, dead-letter on repeated failure. Stores pending ops in a
  PGlite `outbox` table.
- `src/lib/repo/*` — one module per domain (`repo/books.ts`,
  `repo/loans.ts`, …). Reads query PGlite; writes insert into the outbox
  and apply optimistically to PGlite in the same transaction. The Books
  plan's screens swap their `api()` calls for `repo/*` calls.

### `apps/api` changes

- **No new write endpoints.** The outbox targets the existing Books-plan
  endpoints.
- **One new read endpoint** (optional, for initial bootstrap before the
  shape stream catches up): `GET /api/bootstrap?householdId=` returns the
  full household dataset in one payload. Electric's shape can then keep it
  fresh. (If Electric's initial sync is fast enough in dev, this is
  skippable — decide during Task 1.)
- Electric shape metadata: the API exposes the current user's household id
  via the existing `/api/me` (already does); the web sync layer uses it to
  build the shape's `where` clause (`household_id = $current`).

### Electric server (already running)

- Already booted in Plan 1's `docker-compose.dev.yml` with
  `ELECTRIC_INSECURE=true`. This plan configures the **shape** for the
  household partition and wires the client. Production auth stays deferred.

## 5. Tenancy & Security (unchanged invariants)

- RLS still enforces server-side tenancy; Electric shapes are an
  **additional** partition on top, not a replacement. A tampered shape
  request for another household still cannot retrieve rows RLS forbids.
- The outbox carries the user's session cookie; write endpoints still run
  `requireUser` + `withUser`. No new unauthenticated surface.
- PGlite never holds credentials; it holds only the household's tenant data
  (already scoped to that user by the shape) and global editions. Clearing
  IndexedDB on sign-out is part of this plan.

## 6. Conflict Resolution & Edge Cases

- **Last-write-wins** by `updated_at`. Electric delivers operations in
  order per row; PGlite applies them. When the outbox's optimistic write
  and a remote update collide, the higher `updated_at` wins; the next
  shape op reconciles. Loan returns are idempotent (setting
  `returned_date` to the same value is a no-op).
- **Offline insert UUIDs** are generated client-side (`randomUUID`), so an
  offline-created book gets the same id locally and on the server when the
  outbox flushes — no id remapping.
- **Soft deletes** (`deleted_at`) and **`updated_at`** are present on every
  synced table from Plan 1; sync simply replicates them. A delete is an
  `UPDATE` that sets `deleted_at`, replicated like any other update.
- **Global `edition`** rows: replicated only for editions the household's
  books reference (Electric `where` on the `book` join). The Books plan's
  `POST /api/books` already creates edition rows server-side; the shape
  stream carries them down.

## 7. Testing

- **`packages/shared`** — unit tests for the pure helpers (overdue,
  ownership-badge), and type-level contracts (compile-time).
- **API** — `bootstrap.test.ts` if the bootstrap endpoint is added; the
  existing Books-plan tests remain green (the write path is unchanged).
- **Web** — the local data layer gets unit tests with PGlite in-memory (no
  IndexedDB): assert a write enqueues an outbox row + applies optimistically;
  assert a simulated shape op updates PGlite; assert the overdue helper
  matches the server query. Screen tests from the Books plan are updated to
  mock `repo/*` instead of `api()`.
- **Integration** — a focused test that runs the real API + a real
  in-memory PGlite + a mock Electric stream, asserts: write locally →
  outbox flushes → server row appears → shape op mirrors to a second
  PGlite. This is the SaaS-critical isolation check extended to the sync
  path (foundational spec §9).
- **Deferred:** Playwright offline-scenario E2E (airplane-mode add → sync on
  reconnect) stays a follow-up.

## 8. Out of Scope

- Production Electric auth, production deploy, Stripe/billing (V2 / deploy
  plan).
- Cover-photo camera upload + its offline queue.
- Redesigning last-write-wins.
- Changes to the Books plan's domain logic, schema, or RLS.

## 9. Exit Criteria

- Reads on all book-domain screens hit PGlite (verified: works with the
  network throttled to "offline" in DevTools).
- Offline write (add a book while offline) appears instantly, queues in the
  outbox, and flushes + syncs to a second session on reconnect.
- `pnpm test` green across `packages/shared`, `apps/api`, `apps/web`.
- `pnpm --filter @taakify/web typecheck && build` clean.
- Manual GUI journey: two browser sessions (owner + member), both online,
  see each other's edits stream in near-real-time; member goes offline,
  adds a book, comes back online, owner receives it.
- IndexedDB is cleared on sign-out (no cross-household data leakage on a
  shared device).
