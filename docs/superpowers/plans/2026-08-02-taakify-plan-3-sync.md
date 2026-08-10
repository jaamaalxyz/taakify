# Taakify Plan 3: Local-First Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Layer local-first sync on top of the Books plan's working domain: insert a PGlite local DB (IndexedDB-persisted) under the web UI for instant reads, an ElectricSQL shape stream for Postgres→PGlite replication partitioned per household, and a persisted client outbox for offline writes against the existing API write endpoints. End state: the library works fully offline, writes survive restarts, and two devices see each other's edits stream in.

**Layering:** this plan changes *how* the Books plan's screens read/write (PGlite + outbox instead of direct `api()` calls), not *what* the domain does. All server-side authority, validation, and RLS are unchanged — the outbox targets the same Books-plan write endpoints, and Electric shapes are an additional partition on top of RLS, not a replacement.

**Architecture:** See spec §3. Reads → PGlite. Writes → outbox (persisted in PGlite) + optimistic apply → existing `/api/*` write endpoints → Postgres → Electric stream → other devices' PGlite. PGlite is a cache + offline buffer, never the source of truth.

**Spec:** `docs/superpowers/specs/2026-08-02-taakify-sync-design.md`
**Foundational spec:** `docs/superpowers/specs/2026-07-16-taakify-bookshelf-design.md`

**Tech stack additions:** PGlite (`@electric-sql/pglite`), the ElectricSQL client (`@electric-sql/client`), a new `packages/shared` workspace package. Everything else (React 19, Tailwind v4, shadcn/ui, Hono, `pg`, Vitest) is already in place.

**Conventions carried forward (REQUIRED):**

- Relative imports use explicit `.js` extensions; `moduleResolution: "bundler"` / `NodeNext` per package; `type: "module"`.
- `strict: true` TypeScript everywhere. The new `packages/shared` is the single source of row types and pure domain helpers — both API and web import from it, replacing the duplicated string-literal unions.
- Migrations up-only; **no schema migration in this plan** (RLS and grants already cover everything; sync reads existing tables).
- No `prompt()`/`alert()`/`confirm()`; loading = `Skeleton`; errors = destructive `Alert`/toast (restyle conventions). New sync UI states (syncing, offline, outbox-pending) use `Badge`/toast, never blocking modals.
- Web tests mock at module boundaries; the local data layer gets its own unit tests with PGlite in-memory.
- One test file per concern.

**Prerequisites:**

- Books plan merged to `main`; `pnpm test` (both suites) green.
- Electric container running on `:3010` with `ELECTRIC_INSECURE=true` (Plan 1's compose). Postgres on `:5433` with `wal_level=logical` (verified in Plan 1).
- API on `:3011`, web on `:5173`.

**Known risk:** ElectricSQL's client/shape API evolves fast. Task 1 validates the installed version's exact client API against a minimal end-to-end spike **before** building the full layer. If the API differs from the snippets below, defer to the installed version's docs and adjust — the snippets are structural, not copy-paste-trusted.

---

## File Structure (additions only)

```
packages/shared/                        # NEW workspace package
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                        # re-exports
│   ├── types.ts                        # Book, Edition, Loan, … row types + enums
│   ├── contracts.ts                    # write-endpoint request/response shapes
│   └── logic.ts                        # pure helpers: isOverdue, ownershipBadge
└── test/logic.test.ts
apps/web/src/
├── lib/
│   ├── db/
│   │   ├── pglite.ts                   # open + migrate the local mirror schema
│   │   └── mirror-schema.sql           # local tables mirroring server (no auth)
│   ├── sync/
│   │   ├── shape.ts                    # Electric client + household shape subscription
│   │   ├── outbox.ts                   # enqueue / retry / ack / dead-letter
│   │   └── use-sync-status.ts          # hook: online/offline/pending count -> Badge
│   └── repo/                           # one per domain; replaces direct api() calls
│       ├── books.ts
│       ├── shelves.ts
│       ├── reading-status.ts
│       ├── tags.ts
│       ├── contacts.ts
│       └── loans.ts
└── components/
    └── SyncBadge.tsx                   # offline / pending indicator in AppShell header
apps/web/src/lib/sync/*.test.ts         # unit tests with in-memory PGlite
apps/api/test/bootstrap.test.ts         # only if the bootstrap endpoint is added
```

---

### Task 1: ElectricSQL spike (de-risk before building)

**Goal:** prove the read-path end-to-end against the installed Electric version with the smallest possible loop, so the rest of the plan builds on verified API facts.

**Files:** throwaway spike (not committed, or committed under `spike/` and removed in Task 12).

- [ ] **Step 1: Install Electric client + PGlite in `apps/web`**
  ```bash
  pnpm --filter @taakify/web add @electric-sql/pglite @electric-sql/client
  ```

- [ ] **Step 2: Read the installed client's docs** — confirm the exact shape API: `ElectricClient.shape({ url, params })`, the `stream`/`subscribe` method names, and how operations are applied. Record the version: `pnpm --filter @taakify/web list @electric-sql/client`.

- [ ] **Step 3: Minimal spike** — a script (run via `tsx`) or a hidden route that: opens PGlite in-memory, subscribes to a shape over `book WHERE household_id = <real dev household>`, logs incoming rows to the console. Insert a book via the API in another terminal; confirm it streams into PGlite.

- [ ] **Step 4: Document findings** in a short note at the top of Task 2's implementation: exact client method names, any params quirk, whether a bootstrap endpoint is needed (if the initial shape catch-up is slow).

- [ ] **Step 5: Discard the spike** (or move to `spike/` for reference) — do not ship it.

---

### Task 2: `packages/shared` — types + pure logic

The deferred package from Plan 1. Both API and web import from it; duplicated string-literal unions are replaced.

**Files:** new `packages/shared/*`.

- [ ] **Step 1: Scaffold the package**

`packages/shared/package.json`:
```json
{
  "name": "@taakify/shared",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "typecheck": "tsc --noEmit", "test": "vitest run" },
  "devDependencies": { "typescript": "^5.7.0", "vitest": "^3.0.0" }
}
```
`packages/shared/tsconfig.json` — `strict`, `module: NodeNext`, `noEmit`.
Add `"packages/*"` is already in `pnpm-workspace.yaml` (Plan 1). Add `@taakify/shared` as a dependency in both `apps/api` and `apps/web` via `pnpm --filter @taakify/api add @taakify/shared` (workspace protocol).

- [ ] **Step 2: Write the failing test**

`packages/shared/test/logic.test.ts` — assert `isOverdue(loan)` matches the server's `returned_date IS NULL AND due_date < today`; assert ownership-badge mapping; assert enum values match the DB `CHECK` constraints (the single source is now here, not the migration).

**`isOverdue` regression guard (property-style matrix test).** This is the one place where "extract to shared" has a real divergence risk: the server computes `overdue` in SQL (`returned_date IS NULL AND due_date IS NOT NULL AND due_date < CURRENT_DATE`), and this codebase has already been bitten by JS/SQL date drift (the `todayStr()` / `dateStr()` helpers exist precisely because `toISOString()` shifts the day in non-UTC zones). Lock the JS helper to the SQL semantics with an exhaustive matrix covering every edge where the two can drift:

| `returned_date` | `due_date` | `today` | expected overdue | why |
|---|---|---|---|---|
| `NULL` | yesterday | today | `true` | past due, not returned |
| `NULL` | **today** | today | `false` | SQL uses `<`, not `<=` — due today is not overdue |
| `NULL` | tomorrow | today | `false` | not yet due |
| `NULL` | `NULL` | today | `false` | no due date |
| yesterday (returned) | yesterday | today | `false` | already returned |
| today (returned) | last week | today | `false` | returned, even if late |

Plus a timezone-sensitivity case: build `due_date` and `today` from local Date components (the same `todayStr()` approach) rather than `toISOString()`, and assert the result is stable regardless of the runner's timezone. The test asserts the shared `isOverdue(dueDate, returnedDate, today)` output matches `returned_date IS NULL AND due_date IS NOT NULL AND due_date < today` for every row in the matrix.

- [ ] **Step 3: Implement** `src/types.ts` (row types + enums), `src/contracts.ts` (write-endpoint request/response shapes for books/loans/etc., matching the Books plan's routes), `src/logic.ts` (pure helpers), `src/index.ts` (re-exports).

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Refactor API + web to import from `@taakify/shared`** — replace the duplicated unions/literals with shared types. Keep the Books-plan tests green.

- [ ] **Step 6: Commit** — `feat(shared): add @taakify/shared types and domain logic`.

---

### Task 3: PGlite local mirror (open + schema)

**Files:** `apps/web/src/lib/db/pglite.ts`, `apps/web/src/lib/db/mirror-schema.sql`.

- [ ] **Step 1: `mirror-schema.sql`** — local tables mirroring the server's book-domain tables (same columns/types), minus auth tables. Add a local `outbox` table (`id uuid PK, endpoint text, method text, body jsonb, created_at, attempts int, next_retry_at, status text`). No RLS locally (the browser is single-user; tenancy is enforced by the shape).

- [ ] **Step 2: `pglite.ts`** — open PGlite persisted to IndexedDB (`new PGlite({ dataDir: "idb://taakify" })`); run `mirror-schema.sql` on open (idempotent `CREATE TABLE IF NOT EXISTS`). Export a singleton `db` and an `await db.ready` promise.

- [ ] **Step 3: Unit test** — in-memory PGlite (`new PGlite()`), run the schema, assert tables exist. (PGlite supports an in-memory mode for tests.)

- [ ] **Step 4: Commit** — `feat(web): PGlite local mirror with outbox table`.

---

### Task 4: Electric shape subscription

**Files:** `apps/web/src/lib/sync/shape.ts`.

- [ ] **Step 1: Implement** using the API facts recorded in the Task 1 spike. Subscribe to the household shape on auth (household id from `/api/me`); apply incoming operations into PGlite (`INSERT … ON CONFLICT DO UPDATE`, driven by `updated_at`). The global `edition` table syncs the rows referenced by the household's books (per spike: shape `where` or a follow-up shape).

- [ ] **Step 2: Unit test** — feed a fake operation stream into the apply function against in-memory PGlite; assert rows materialize and a newer `updated_at` overwrites an older one (last-write-wins).

- [ ] **Step 3: Cold-start loading state.** On first load (or after sign-in), PGlite is empty until the shape's initial catch-up streams the household's rows in. A blank screen during that window — empty lists, "No books yet" — reads as "my library is gone," which is the worst possible first impression. Expose a `synced: boolean` from the shape module (false until the first shape catch-up completes, true thereafter) and have screens show their existing `Skeleton` loading state (the pattern every screen already uses) while `synced` is false. Rows progressively fill in as the shape applies them. This state is defensive: even if Task 8's bootstrap endpoint makes the window negligible, the loading state must exist so a slow initial sync never looks like data loss.

- [ ] **Step 4: Commit** — `feat(web): Electric shape stream into PGlite`.

---

### Task 5: Outbox (offline write queue)

The write-path heart. Highest-risk piece after loans (spec §9).

**Files:** `apps/web/src/lib/sync/outbox.ts`.

- [ ] **Step 1: Failing test** (`outbox.test.ts`, in-memory PGlite):
  - `enqueue` inserts an outbox row and an optimistic local row in one PGlite transaction.
  - The retry loop flushes a pending row via a mocked `fetch`, acks on 2xx (deletes the row), and increments `attempts` + sets `next_retry_at` with backoff on failure.
  - After N failures, the row is marked `dead` (status) and surfaced via a non-blocking toast with a **Retry** action (see Step 3 for the surfacing contract — the row is never silently dropped).
  - Retry resumes on `online` event and on a periodic timer.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** `outbox.ts` — `enqueue(endpoint, method, body, optimisticSql)`, a `flush()` that reads due rows and calls `fetch` with `credentials: "include"`, backoff schedule (e.g. 1s, 2s, 5s, 15s, 60s, then dead-letter), `window.addEventListener("online", flush)`, and a `setInterval(flush, 5000)`. Target the **existing** Books-plan write endpoints (no new server code).

  **Dead-letter surfacing contract.** When a row exhausts its retries (status → `dead`), the outbox fires `toast.error()` with a Retry action button — the first action toast in the codebase, but sonner v2.0.7 fully supports it (`toast.error(msg, { action: { label: "Retry", onClick } })`). The toast copy should name the operation that failed in human terms (e.g. `"Couldn't save: mark Dune as finished"`, `"Couldn't save: add contact Alex"`), derived from the outbox row's endpoint/body. Retry re-queues the row: resets `attempts` to 0, `status` to `pending`, clears `next_retry_at`, and triggers an immediate `flush()`. The toast is non-blocking (the user can ignore it) but unmissable; a dismissed toast does NOT abandon the row — the dead-lettered row persists in PGlite and remains visible in the SyncBadge's failed-operations list (Task 7) until the user explicitly Dismisses it there. This two-layer design (toast for immediate awareness, badge list for durable visibility) ensures a dead-lettered write is never silently lost.

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit** — `feat(web): persisted client outbox with retry/backoff`.

---

### Task 6: Repo layer (replace direct `api()` calls)

**Files:** `apps/web/src/lib/repo/*.ts`.

- [ ] **Step 1: For each domain** (`books`, `shelves`, `reading-status`, `tags`, `contacts`, `loans`):
  - Reads: `SELECT … FROM <table>` against PGlite.
  - Writes: call `outbox.enqueue(...)` with the existing endpoint + an optimistic local mutation in the same PGlite transaction.

  Example shape (`repo/books.ts`):
  ```ts
  export async function listBooks(): Promise<Book[]> {
    const db = await pglite.ready;
    return (await db.query("SELECT … FROM book JOIN edition … ORDER BY title")).rows;
  }
  export async function createBook(input: CreateBookInput): Promise<void> {
    const id = randomUUID();
    await outbox.enqueue("/api/books", "POST", { id, ...input }, {
      optimistic: `INSERT INTO book (id, …) VALUES ($1, …)`,
      params: [id, …],
    });
  }
  ```

- [ ] **Step 2: Swap the Books-plan screens** from `api()` to `repo/*`. Update screen tests to mock `repo/*` instead of `api()` (same module-boundary convention).

- [ ] **Step 3: Commit** per domain or as one `feat(web): repo layer over PGlite + outbox`.

---

### Task 7: Sync status UI + sign-out cleanup

**Files:** `apps/web/src/components/SyncBadge.tsx`, `apps/web/src/lib/sync/use-sync-status.ts`, modify `AppShell.tsx`, modify sign-out.

- [ ] **Step 1: `use-sync-status` hook** — `online: boolean`, `pending: number` (count of non-dead outbox rows), `dead: number` (count of dead-lettered rows). Subscribes to `online`/`offline` events and polls outbox counts.

- [ ] **Step 2: `SyncBadge`** — four states, placed in the `AppShell` header alongside the household name (no existing slot — introduce one):
  - `Offline` → destructive `Badge` (no network)
  - `Saving…` → secondary `Badge` (`pending > 0`, actively trying)
  - `Sync issue` → destructive `Badge` with a dot indicator (`dead > 0` — permanently failed writes exist). Tapping/clicking it opens a small list (a `Dialog` or popover) of the failed operations, each with **Retry** (re-queues the row, same as Task 5's toast action) and **Dismiss** (marks the row `dismissed`, removing it from the list — the user explicitly abandons the write). This list is the durable visibility layer that complements Task 5's transient toast.
  - *nothing* → all synced (`pending === 0 && dead === 0`). The healthy default — render `null`, matching `StatusBadge`'s null-on-quiet precedent. No badge when everything's fine.

- [ ] **Step 3: Sign-out with pending-writes protection.** Today the sign-out button fires `authClient.signOut().finally(() => location.reload())` directly. Gate it on outbox state:
  1. **Outbox empty** (no pending, no dead-lettered) → sign out immediately, no friction. The common case.
  2. **Outbox has pending rows** → open a warning `Dialog` first, reusing the two-phase shape of the do-not-lend warning (destructive `Alert` + `DialogFooter` with Cancel / Confirm). Copy: *"You have N unsaved changes. Sign out anyway? They'll be lost."* On confirm: best-effort flush the outbox if online (short timeout — don't hang sign-out on a dead network), then clear IndexedDB, then sign out. On cancel: return to the app, nothing changes.
  3. **Only dead-lettered/dismissed rows** (no pending) → no warning. The user already chose to dismiss those; sign out immediately.

  Then `await db.close()`, clear the IDB directory (`indexedDB.deleteDatabase("taakify")` or PGlite's equivalent) so a shared device never leaks the prior household's data, and reload to a clean state. The pending-writes warning is the data-loss guard; the IDB clear is the privacy guard.

- [ ] **Step 4: Tests** —
  - `SyncBadge` renders the right variant for each `use-sync-status` state (offline / saving / sync-issue / null-when-synced).
  - The "Sync issue" list shows dead-lettered operations and Retry re-queues (assert outbox row status flips back to `pending`) while Dismiss marks it `dismissed`.
  - Sign-out with an empty outbox calls `authClient.signOut()` immediately with no dialog.
  - Sign-out with pending rows opens the warning dialog; Cancel returns without signing out; Confirm clears IndexedDB and signs out.

- [ ] **Step 5: Commit** — `feat(web): sync status badge, dead-letter surfacing, and sign-out data protection`.

---

### Task 8: Bootstrap endpoint (cold-start — the "how," not "whether")

**Files:** `apps/api/src/routes/bootstrap.ts`, `apps/api/test/bootstrap.test.ts`.

This task is **required**, not optional. The cold-start experience — what a user sees the first time they open the app, when PGlite is empty and the shape hasn't streamed in yet — is a make-or-break UX moment. An empty library on first load reads as "my data is gone." Task 1's spike determines *how* to implement cold-start, not *whether*.

- [ ] **Step 1: Decide the approach from the Task 1 spike findings.** Two viable paths:
  - **(A) Bootstrap endpoint** — `GET /api/bootstrap?householdId=` through `withUser`, returns the household's full dataset (books + editions + shelves + tags + contacts + loans + reading_statuses) in one JSON payload. The web sync layer calls this once on first load to seed PGlite, then the shape keeps it fresh. RLS enforces scoping; test that a second household's data is absent.
  - **(B) Shape-only with loading state** — if the spike proves Electric's initial shape catch-up is fast enough (sub-500ms with a household-sized dataset in dev), skip the endpoint and rely on Task 4's `synced: false` loading state + progressive fill-in. The loading state (Task 4 Step 3) exists regardless; this path just means the window is short enough that no seeding fetch is needed.

  If the spike is ambiguous, default to **(A)** — a one-round-trip seed fetch is a small cost for guaranteeing the user never sees an empty library on a slow initial sync.

- [ ] **Step 2: Implement** the chosen approach. If (A): build the endpoint, add the test (RLS isolation — second household absent). If (B): document the spike's timing findings in the PR and confirm Task 4's loading state covers the observed window.

- [ ] **Step 3: Commit** — `feat(api): bootstrap endpoint for cold-start` (or document the skip decision in the sync-layer PR).

---

### Task 9: Integration test (the SaaS-critical invariant on the sync path)

**Files:** `apps/web/src/lib/sync/integration.test.ts` (or `apps/api/test/sync.test.ts`).

- [ ] **Step 1: Test** the full local→server→remote loop with real API + in-memory PGlite + a mock Electric stream:
  1. Start with two empty PGlite instances (household A owner, household A member).
  2. Owner writes a book via `repo.books.createBook` → outbox flushes against the real API → row appears in Postgres → mock stream mirrors it to the member's PGlite.
  3. Assert the member's PGlite now has the book.
  4. Sign up household B; assert its PGlite stream never receives household A's book (isolation through the shape `where` + RLS).

- [ ] **Step 2: Commit** — `test: integration test for sync isolation across households`.

---

### Task 10: Update docs + full verification

- [ ] **Step 1: Doc sweep.** Update references now that sync is shipped:
  - `apps/web` README/spec notes: the "server-side `ILIKE` search" caveat from the Books plan is now "local PGlite search" (update the Books-plan spec §2 non-goal language if it claimed search stays server-side forever — it was scoped to *that* plan, which is correct; clarify here that the Sync plan upgrades it).
  - The foundational spec §3 architecture diagram stays authoritative; reference it.

- [ ] **Step 2: Full test + typecheck + build**
  Run: `pnpm --filter @taakify/shared test && pnpm --filter @taakify/api test && pnpm --filter @taakify/web typecheck && pnpm --filter @taakify/web test && pnpm --filter @taakify/web build`
  Expected: all green.

- [ ] **Step 3: Manual GUI journey** (use the web-gui-tester skill, two sessions):
  1. Owner + member both signed in (two IAB tabs / two browsers). Owner adds a book → member's Library updates without a manual refresh (shape stream).
  2. Throttle member's network to "offline" (DevTools) → member adds a book → it appears instantly in their own Library (optimistic PGlite) → `SyncBadge` shows "Offline".
  3. Bring member back online → outbox flushes → `SyncBadge` clears → owner receives the book via the shape stream.
  4. Owner signs out → on next sign-in as a different household, the prior household's books are gone (IndexedDB cleared).
  5. Verify isolation: a third household never sees the first two's books.

- [ ] **Step 4: Commit** doc updates, then open the PR.

---

## Plan 3 exit criteria

- Reads on all book-domain screens hit PGlite; verified by throttling to offline in DevTools and seeing the UI stay responsive.
- **First load after sign-in shows a loading state (Skeleton), not an empty library** — PGlite is empty until the shape/seed lands; the user never sees a blank "No books yet" during that window.
- An offline write queues, survives a reload, and flushes + syncs on reconnect.
- **A dead-lettered write (exhausted retries) is surfaced, never silently dropped** — the user sees an error toast with a Retry action, and the operation persists in the SyncBadge's "Sync issue" list until retried or explicitly dismissed.
- Two devices see each other's edits stream in near-real-time over the Electric shape.
- `pnpm test` green across `packages/shared`, `apps/api`, `apps/web`.
- Web `typecheck` + `build` clean.
- Integration test proves household-A's synced rows never reach household-B (the SaaS-critical invariant extended to the sync path).
- **Sign-out warns before data loss** when pending outbox writes exist, then clears IndexedDB; a shared device never leaks the prior household's data.
- No `prompt()`/`alert()`/`confirm()`; sync status surfaced via `Badge`/toast/Dialog only — restyle conventions upheld.
