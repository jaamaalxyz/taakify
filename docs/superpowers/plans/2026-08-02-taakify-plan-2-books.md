# Taakify Plan 2: Books Domain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the book domain as an online API-first feature: add/organize/track/lend books through the Hono API under existing RLS, behind a new bottom-tab app shell that reuses the restyled design system. End state: a household can catalog books by ISBN or manual entry, organize them on shelves, track per-member reading, tag/filter, and lend/borrow with due dates — all online (offline comes in the Sync plan).

**Feature-first ordering:** this plan deliberately precedes the Sync plan so users get a working library now and the Sync plan gets a real domain to replicate. Server-side `ILIKE` search is "good enough" at household scale (≈500 books); instant offline search arrives with PGlite.

**Architecture:** No new infrastructure. New route files under `apps/api/src/routes/` go entirely through the existing `withUser(userId, ...)` RLS transaction helper — **zero privileged-pool work, zero RLS policy changes** (Plan 1's `0003_rls.sql` already covers every book-domain table with the uniform member-only CRUD pattern and the correct grants). The web app gains an `AppShell` layout with bottom tabs; new screens reuse the installed shadcn/ui components and add a few more by CLI as editable source.

**Spec:** `docs/superpowers/specs/2026-08-02-taakify-books-design.md`
**Foundational spec:** `docs/superpowers/specs/2026-07-16-taakify-bookshelf-design.md`

**Tech stack (unchanged):** Node 24, pnpm, TypeScript `strict`, Hono, `pg` (no ORM — hand-written SQL), better-auth, Vitest; React 19, react-router-dom 7, Tailwind v4 (CSS-first), shadcn/ui, lucide-react, Nunito.

**Conventions carried from Plan 1 + the restyle (REQUIRED):**

- Relative imports use explicit `.js` extensions (`moduleResolution: "bundler"`, `type: "module"`). Every new file follows this, including imports of new `routes/*` and `components/ui/*`.
- Migrations are **up-only plain SQL**, applied by the existing custom runner. No down migrations (dev resets by dropping the schema).
- Tenant-data access goes through `withUser(user.id, fn)` only. The privileged `adminPool` is not touched in this plan. RLS is the backstop.
- No hard deletes: `DELETE` routes do `UPDATE ... SET deleted_at = now(), updated_at = now()`. The `taakify_app` role has no DELETE grant.
- All mutations set `updated_at = now()` (last-write-wins). `created_by` is the caller's user id.
- API errors are `c.json({ error: "..." }, 4xx)`; the web `api()` helper surfaces `body.error` in a destructive `Alert` or toast.
- Web: no `prompt()`/`alert()`/`confirm()`. Use shadcn `Dialog` (see the invite dialog precedent in `Home.tsx`). Loading states use `Skeleton`; errors use destructive `Alert`; non-blocking mutation feedback uses Sonner toasts.
- Web tests mock `api()` and `authClient` at the module boundary with `vi.mock` — component/unit tests, not integration. API tests use the real Postgres + RLS via the existing `global-setup.ts` + `signUp()` helper.
- One test file per route file (API) and per screen (web).

**Prerequisites (verify before starting):**

- On `main`, post-merge of the restyle + the two bugfixes. `apps/api/src/db/tenant.ts` (`withUser`), `apps/api/src/middleware/session.ts` (`requireUser`), and `apps/web/src/components/ui/*` all exist.
- Docker Postgres on `:5433` running; `pnpm migrate` up to date through `0003_rls.sql`.
- `pnpm test` (both suites) green at the start.

**Dev ports (unchanged from Plan 1 + bugfix):** Postgres `5433`, Electric `3010`, API `3011`, web `5173`. The Vite proxy targets `:3011`; `apps/api/.env` must set `PORT=3011` (the bugfix aligned `.env.example`).

---

## File Structure (additions only)

```
apps/api/
├── migrations/
│   └── 0004_books_indexes.sql          # additive indexes only
└── src/routes/
    ├── editions.ts                     # GET /api/editions/lookup
    ├── books.ts                        # CRUD + list/search
    ├── shelves.ts                      # bookcases + shelves CRUD
    ├── reading-status.ts               # upsert caller's status
    ├── tags.ts                         # tags + book_tag
    ├── contacts.ts                     # CRUD
    └── loans.ts                        # lend/borrow/return + history
apps/api/test/
├── editions.test.ts
├── books.test.ts
├── shelves.test.ts
├── reading-status.test.ts
├── tags.test.ts
├── contacts.test.ts
└── loans.test.ts
apps/web/src/
├── App.tsx                             # MODIFY: nest authed routes under AppShell
├── components/
│   ├── ui/                             # ADD via shadcn CLI: badge, select, tabs,
│   │                                   #     table, textarea, dropdown-menu, sonner
│   ├── AppShell.tsx                    # bottom-tab layout + <Outlet/>
│   ├── BookCard.tsx
│   └── StatusBadge.tsx
├── lib/
│   └── api.ts                          # MODIFY: add book-domain types (Book, etc.)
└── pages/
    ├── Home.tsx                        # MODIFY: redirect to /library (drop placeholder)
    ├── Library.tsx                     # search + filters + list
    ├── BookDetail.tsx
    ├── Add.tsx                         # ISBN lookup + manual + batch
    ├── Bookcases.tsx
    ├── Loans.tsx
    └── Profile.tsx
apps/web/src/pages/*.test.tsx           # one per new screen
```

`packages/shared` is still absent — it arrives in the Sync plan.

---

### Task 1: Additive index migration

**Files:**
- Create: `apps/api/migrations/0004_books_indexes.sql`

- [ ] **Step 1: Write the migration**

`apps/api/migrations/0004_books_indexes.sql`:
```sql
-- Additive only: query-supporting indexes for the book domain. Tables and
-- RLS policies already exist (0002_core.sql, 0003_rls.sql); nothing here
-- changes the schema or the app role's grants.

-- List/search within a household joins book -> edition.
CREATE INDEX IF NOT EXISTS book_household_edition_idx
  ON book (household_id, edition_id);

-- Active loans by household/contact (returned_date IS NULL).
CREATE INDEX IF NOT EXISTS loan_active_idx
  ON loan (household_id, contact_id)
  WHERE returned_date IS NULL;

-- "Currently reading" strips on the Home/Library by user.
CREATE INDEX IF NOT EXISTS reading_status_user_idx
  ON reading_status (user_id, status)
  WHERE deleted_at IS NULL;
```

- [ ] **Step 2: Apply to dev DB and verify**

Run: `pnpm migrate`
Expected: `Applied: 0004_books_indexes.sql`

Run: `docker compose -f docker-compose.dev.yml exec postgres psql -U postgres -d taakify -c "\di book_household_edition_idx loan_active_idx reading_status_user_idx"`
Expected: all three listed.

- [ ] **Step 3: Commit**

```bash
git add apps/api/migrations/0004_books_indexes.sql
git commit -m "feat(api): additive book-domain indexes (0004)"
```

---

### Task 2: Books CRUD + list/search (API)

The foundational route every other task depends on. Build it first.

**Files:**
- Create: `apps/api/src/routes/books.ts`
- Modify: `apps/api/src/app.ts` (mount the route)
- Create: `apps/api/test/books.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/api/test/books.test.ts` (signs up, creates a household via the real endpoint, then exercises books — mirroring the `households.test.ts`/`invites.test.ts` style):
```ts
import { describe, it, expect } from "vitest";
import { app } from "../src/app.js";
import { signUp } from "./helpers.js";

async function createHousehold(cookie: string, name = "Books Test House") {
  const res = await app.request("/api/households", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return (await res.json()).household as { id: string };
}

async function addBook(cookie: string, householdId: string, title: string) {
  const res = await app.request("/api/books", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ householdId, edition: { title, authors: "A" }, ownership: "owned" }),
  });
  return { status: res.status, body: await res.json() };
}

describe("books", () => {
  it("creates a book (with an inline edition) and lists it", async () => {
    const { cookie } = await signUp(app);
    const house = await createHousehold(cookie);
    const created = await addBook(cookie, house.id, "Sapiens");
    expect(created.status).toBe(201);
    expect(created.body.book.id).toBeTruthy();

    const list = await (
      await app.request(`/api/books?householdId=${house.id}`, { headers: { cookie } })
    ).json();
    expect(list.books).toHaveLength(1);
    expect(list.books[0].edition.title).toBe("Sapiens");
  });

  it("searches by title and filters by ownership", async () => {
    const { cookie } = await signUp(app);
    const house = await createHousehold(cookie);
    await addBook(cookie, house.id, "Sapiens");
    await addBook(cookie, house.id, "Dune");

    const q = await (await app.request(`/api/books?householdId=${house.id}&q=dun`, { headers: { cookie } })).json();
    expect(q.books).toHaveLength(1);
    expect(q.books[0].edition.title).toBe("Dune");

    const none = await (await app.request(`/api/books?householdId=${house.id}&ownership=wishlist`, { headers: { cookie } })).json();
    expect(none.books).toHaveLength(0);
  });

  it("RLS: a second household never sees the first's books", async () => {
    const a = await signUp(app);
    const houseA = await createHousehold(a.cookie, "A");
    await addBook(a.cookie, houseA.id, "Hidden");

    const b = await signUp(app);
    const houseB = await createHousehold(b.cookie, "B");
    const list = await (await app.request(`/api/books?householdId=${houseB.id}`, { headers: { cookie: b.cookie } })).json();
    expect(list.books).toHaveLength(0);
  });

  it("requires auth", async () => {
    const res = await app.request("/api/books");
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @taakify/api test test/books.test.ts`
Expected: FAIL — 404 on `/api/books`.

- [ ] **Step 3: Implement the route**

`apps/api/src/routes/books.ts` — note `householdId` comes from the query/body and is **enforced by RLS**: a caller passing another household's id finds zero rows / gets a 403 from the insert policy.
```ts
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { withUser } from "../db/tenant.js";
import { requireUser, type SessionUser } from "../middleware/session.js";

export const books = new Hono<{ Variables: { user: SessionUser } }>();

books.use("*", requireUser);

// GET /api/books?householdId=...&q=...&ownership=...&status=...&tag=...&shelf_id=...
books.get("/", async (c) => {
  const user = c.get("user");
  const householdId = c.req.query("householdId");
  if (!householdId) return c.json({ error: "householdId is required" }, 400);

  const q = `%${(c.req.query("q") ?? "").toLowerCase()}%`;
  const ownership = c.req.query("ownership");
  const status = c.req.query("status");
  const tag = c.req.query("tag");
  const shelfId = c.req.query("shelf_id");

  const rows = await withUser(user.id, async (client) => {
    // Dynamic filters built from whitelisted params; values bound as params.
    const where: string[] = ["b.household_id = $1", "b.deleted_at IS NULL"];
    const params: unknown[] = [householdId];
    let i = 2;
    if (q) { where.push(`(lower(e.title) LIKE $${i} OR lower(e.authors) LIKE $${i})`); params.push(q); i++; }
    if (ownership) { where.push(`b.ownership = $${i}`); params.push(ownership); i++; }
    if (shelfId) { where.push(`b.shelf_id = $${i}`); params.push(shelfId); i++; }
    if (status) {
      where.push(`EXISTS (SELECT 1 FROM reading_status rs WHERE rs.book_id = b.id AND rs.user_id = $${i} AND rs.status = $${i + 1} AND rs.deleted_at IS NULL)`);
      params.push(user.id, status); i += 2;
    }
    if (tag) {
      where.push(`EXISTS (SELECT 1 FROM book_tag bt JOIN tag t ON t.id = bt.tag_id WHERE bt.book_id = b.id AND t.name = $${i} AND bt.deleted_at IS NULL)`);
      params.push(tag); i++;
    }
    const { rows } = await client.query(
      `SELECT b.id, b.ownership, b.format, b.shelf_id, b.do_not_lend, b.wishlist_priority, b.notes,
              e.id AS edition_id, e.title, e.authors, e.cover_url, e.isbn, e.language
       FROM book b JOIN edition e ON e.id = b.edition_id
       WHERE ${where.join(" AND ")}
       ORDER BY e.title LIMIT 100`,
      params
    );
    return rows;
  });
  return c.json({ books: rows });
});

// POST /api/books — creates an edition row when editionId is absent.
books.post("/", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{
    householdId: string;
    editionId?: string;
    edition?: { isbn?: string; title: string; authors?: string; language?: string; cover_url?: string };
    ownership: "owned" | "borrowed_in" | "wishlist";
    shelf_id?: string;
    do_not_lend?: boolean;
    wishlist_priority?: "high" | "medium" | "low";
    notes?: string;
  }>().catch(() => null);
  if (!body?.householdId || !body?.ownership) return c.json({ error: "householdId and ownership required" }, 400);
  if (!body.editionId && !body.edition?.title) return c.json({ error: "editionId or edition.title required" }, 400);

  const book = await withUser(user.id, async (client) => {
    let editionId = body.editionId;
    if (!editionId && body.edition) {
      const e = await client.query(
        `INSERT INTO edition (id, isbn, title, authors, language, cover_url)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [randomUUID(), body.edition.isbn ?? null, body.edition.title, body.edition.authors ?? "", body.edition.language ?? null, body.edition.cover_url ?? null]
      );
      editionId = e.rows[0].id;
    }
    const { rows } = await client.query(
      `INSERT INTO book (id, household_id, edition_id, ownership, shelf_id, do_not_lend, wishlist_priority, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, household_id, edition_id, ownership, shelf_id, do_not_lend, wishlist_priority, notes`,
      [randomUUID(), body.householdId, editionId, body.ownership, body.shelf_id ?? null, body.do_not_lend ?? false, body.wishlist_priority ?? null, body.notes ?? null, user.id]
    );
    return rows[0];
  }).catch((err) => {
    // RLS insert policy rejects cross-household writes -> Postgres raises SQLSTATE 42501.
    // Match on err.code, not err.message text (message wording isn't a stable contract).
    if ((err as { code?: string }).code === "42501") return null;
    throw err;
  });
  if (!book) return c.json({ error: "forbidden" }, 403);
  return c.json({ book }, 201);
});

// GET /api/books/:id
books.get("/:id", async (c) => {
  const user = c.get("user");
  const { rows } = await withUser(user.id, (client) =>
    client.query(
      `SELECT b.*, e.title, e.authors, e.cover_url, e.isbn, e.language
       FROM book b JOIN edition e ON e.id = b.edition_id
       WHERE b.id = $1 AND b.deleted_at IS NULL`,
      [c.req.param("id")]
    )
  );
  if (!rows[0]) return c.json({ error: "not found" }, 404);
  return c.json({ book: rows[0] });
});

// PATCH /api/books/:id — move shelf, edit fields.
books.patch("/:id", async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  const allowed = ["shelf_id", "ownership", "do_not_lend", "wishlist_priority", "notes"] as const;
  const sets: string[] = [];
  const params: unknown[] = [c.req.param("id")];
  let i = 2;
  for (const key of allowed) {
    if (key in body) { sets.push(`${key} = $${i}`); params.push(body[key]); i++; }
  }
  if (!sets.length) return c.json({ error: "nothing to update" }, 400);
  const { rows } = await withUser(user.id, (client) =>
    client.query(
      `UPDATE book SET ${sets.join(", ")}, updated_at = now()
       WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
      params
    )
  );
  if (!rows[0]) return c.json({ error: "not found" }, 404);
  return c.json({ book: rows[0] });
});

// DELETE /api/books/:id — soft delete.
books.delete("/:id", async (c) => {
  const user = c.get("user");
  const { rowCount } = await withUser(user.id, (client) =>
    client.query(
      "UPDATE book SET deleted_at = now(), updated_at = now() WHERE id = $1 AND deleted_at IS NULL",
      [c.req.param("id")]
    )
  );
  if (!rowCount) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});
```

Mount in `apps/api/src/app.ts`:
```ts
import { books } from "./routes/books.js";
// ...
app.route("/api/books", books);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @taakify/api test`
Expected: all PASS (existing + new books tests, including the RLS cross-household isolation test).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/books.ts apps/api/src/app.ts apps/api/test/books.test.ts
git commit -m "feat(api): books CRUD with RLS-scoped list/search"
```

---

### Task 3: Editions lookup (Open Library + Google Books)

**Files:**
- Create: `apps/api/src/routes/editions.ts`
- Modify: `apps/api/src/app.ts`
- Create: `apps/api/test/editions.test.ts`

- [ ] **Step 1: Write the failing test** (`editions.test.ts`) — assert a known ISBN returns a pre-filled payload `{isbn, title, authors, ...}`; assert a garbage ISBN returns 404 (lookup miss, not a 500); assert a lookup that times out falls through gracefully (mock `fetch`).

- [ ] **Step 2: Run test → FAIL** (404 on the route).

- [ ] **Step 3: Implement** `editions.ts`:
  - `GET /api/editions/lookup?isbn=...` — `requireUser`.
  - Fetch Open Library `https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`; if miss, fetch Google Books `https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}`.
  - Merge the first hit into `{ isbn, title, authors, language, publisher, published_year, cover_url }`.
  - **Never throw on external failure** — on any error or miss, return `404 { error: "not found" }`. The Add screen falls through to the manual form (spec §8). Use `AbortController` with a 5s timeout per call.

Mount: `app.route("/api/editions", editions)`.

- [ ] **Step 4: Run tests → PASS.**

- [ ] **Step 5: Commit** — `feat(api): edition lookup via Open Library + Google Books`.

---

### Task 4: Shelves, reading-status, tags, contacts (API)

Four small, independent route files. Same pattern as Task 2 — all through `withUser`, RLS-enforced. Do them as sub-steps (one file + test + commit each).

**Files:** `shelves.ts`, `reading-status.ts`, `tags.ts`, `contacts.ts` + their `*.test.ts`.

- [ ] **Step 4a: `shelves.ts`** — `GET /api/bookcases?householdId=`, `POST /api/bookcases`, `POST /api/bookcases/:id/shelves` (shelf.position auto = max+1), `PATCH /api/shelves/:id`, soft `DELETE`. Test RLS isolation.

- [ ] **Step 4b: `reading-status.ts`** — `PUT /api/books/:bookId/status` (upsert via `ON CONFLICT (book_id, user_id) WHERE deleted_at IS NULL DO UPDATE`; the partial unique index from `0002_core.sql` backs this). The request body carries only status fields (status, dates, rating, note) — **`household_id` is never read from the client**; derive it server-side inside the same `withUser` transaction via `SELECT household_id FROM book WHERE id = $1`, and use that value in the `INSERT`/`ON CONFLICT` — trusting a client-supplied `householdId` here would let a caller attempt to write a status row under a household they don't belong to (RLS still backstops it, but the query itself should never offer that path). `GET /api/books/:bookId/status` returns all members' statuses (RLS-visible rows only). Test that user A's status doesn't affect user B's.

- [ ] **Step 4c: `tags.ts`** — `GET /api/tags?householdId=`, `POST /api/tags`, `POST /api/books/:bookId/tags` (insert into `book_tag`), `DELETE /api/books/:bookId/tags/:tagId` (soft). Test the `UNIQUE (household_id, name)` dedup.

- [ ] **Step 4d: `contacts.ts`** — `GET /api/contacts?householdId=`, `POST`, `PATCH`, soft `DELETE`. Test RLS isolation.

Each: failing test → implement → mount in `app.ts` → pass → commit with `feat(api): ...`.

---

### Task 5: Loans + overdue logic (API)

The highest-risk domain logic (spec §9 testing). Lending, returning, due dates, overdue, borrowed-in handling.

**Files:** `apps/api/src/routes/loans.ts`, `apps/api/test/loans.test.ts`.

- [ ] **Step 1: Failing test** covering:
  - lend out (creates contact if needed, `direction: 'lent_out'`, due_date set) → active loan appears in `GET /api/loans?householdId=&active=true`;
  - mark returned (`PATCH /api/loans/:id { returned_date }`) → moves to history;
  - overdue = active AND `due_date < today` surfaces a flag;
  - borrowed-in book (`ownership='borrowed_in'` + active `direction='borrowed_in'` loan) is excluded from owned counts (test a small query helper or assert at the route layer);
  - RLS: household B never sees household A's loans.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** `loans.ts`:
  - `POST /api/loans` — `requireUser`, body `{ bookId, contactId | contactName, direction, dueDate? }`. If `contactName` given without id, create the contact first (same `withUser` tx). RLS enforces both book and contact belong to the caller's household.
  - `PATCH /api/loans/:id` — set `returned_date` / `due_date`.
  - `GET /api/loans?householdId=&active=&contactId=` — join book + contact; compute `overdue` boolean server-side (`returned_date IS NULL AND due_date IS NOT NULL AND due_date < CURRENT_DATE`).

- [ ] **Step 4: Run → PASS** (including overdue + isolation).

- [ ] **Step 5: Commit** — `feat(api): loans with overdue logic and history`.

---

### Task 6: Install additional shadcn/ui components

**Files:** new components under `apps/web/src/components/ui/`.

- [ ] **Step 1: Add components via the CLI** (editable source, per the restyle precedent):
  ```bash
  cd apps/web
  pnpm dlx shadcn@latest add badge select tabs table textarea dropdown-menu sonner
  ```
  Expected: files appear under `src/components/ui/`; `components.json` already exists from the restyle so init is not repeated.

- [ ] **Step 2: Wire Sonner's `<Toaster>`** once in `main.tsx` (inside `<BrowserRouter>`) so toasts work app-wide.

- [ ] **Step 3: Typecheck** — `pnpm --filter @taakify/web typecheck` clean.

- [ ] **Step 4: Commit** — `chore(web): add badge/select/tabs/table/textarea/dropdown-menu/sonner`.

---

### Task 7: AppShell + routing restructure

**Files:**
- Create: `apps/web/src/components/AppShell.tsx`
- Modify: `apps/web/src/App.tsx`, `apps/web/src/pages/Home.tsx`
- Create: `apps/web/src/pages/Library.tsx` (stub), `Profile.tsx` (stub) — just enough to mount routes; full impl later.

- [ ] **Step 1: `AppShell.tsx`** — bottom tab bar (Library, Add center button, Loans, Profile) using `NavLink` + lucide icons (`Library`, `Plus`, `HandCoins`, `User`); renders `<Outlet/>`. Only functional icons (restyle convention). Mobile-first; the bar is fixed to the bottom.

- [ ] **Step 2: Restructure `App.tsx`** — authed routes nest under `AppShell`:
  ```tsx
  <Route element={<AppShell />}>
    <Route path="/" element={<Navigate to="/library" />} />
    <Route path="/library" element={<Library />} />
    <Route path="/library/:bookId" element={<BookDetail />} />
    <Route path="/add" element={<Add />} />
    <Route path="/bookcases" element={<Bookcases />} />
    <Route path="/loans" element={<Loans />} />
    <Route path="/profile" element={<Profile />} />
  </Route>
  ```
  The existing `/signup`, `/signin`, `/invite/:token`, `/onboarding` stay outside `AppShell`. `App.test.tsx` is updated: `/` now redirects to `/library` (not `/signin`), and the pending/redirect cases are re-asserted.

- [ ] **Step 3: Update `Home.tsx`** — its role as the authed landing page is replaced by the redirect above. Either delete `Home.tsx`/`Home.test.tsx` (if nothing else imports it) or repurpose it. **Update the stale placeholder text**: the old `"Books arrive in Plan 3. Sync arrives in Plan 2."` is removed entirely now that books exist and plans are renumbered. Move the invite `Dialog` into `Profile.tsx` (Task 11) and sign-out into `AppShell`'s header.

- [ ] **Step 4: Update `App.test.tsx`** for the new redirect target and run it green.

- [ ] **Step 5: Commit** — `feat(web): AppShell with bottom tabs, restructure authed routes`.

---

### Task 8: Library screen (search + filters + list)

**Files:** `apps/web/src/pages/Library.tsx`, `Library.test.tsx`; helper `apps/web/src/components/BookCard.tsx`, `StatusBadge.tsx`.

- [ ] **Step 1: `Library.test.tsx`** (mock `api`, restyle convention) — renders a list from a mocked `GET /api/books` response; typing in the search box debounces and calls `api` with `?q=`; selecting an ownership filter calls `api` with `?ownership=`; empty state shows the `BookOpen` `Card`; clicking a card navigates to `/library/:id`.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** — debounced search (`useEffect` + `setTimeout` 250ms), filter chips (Badge buttons), `BookCard` (cover thumbnail via `edition.cover_url`, title, authors, ownership `Badge`, my-status `StatusBadge`), "load more" button offset paging. Loading = `Skeleton` list; error = destructive `Alert`.

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit** — `feat(web): Library screen with search, filters, and list`.

---

### Task 9: Add screen (ISBN lookup + manual + batch)

**Files:** `apps/web/src/pages/Add.tsx`, `Add.test.tsx`.

- [ ] **Step 1: Test** — ISBN entry calls `/api/editions/lookup`, pre-fills the manual form on hit; on 404 (miss), shows the empty manual form with a muted "no match, enter manually" notice; batch toggle keeps the selected shelf between adds; submit calls `POST /api/books` and shows a success toast (Sonner), then clears the form but keeps shelf + batch state.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** — `Tabs` (ISBN / Manual), shelf `Select` (from `/api/bookcases`), batch toggle, edition-lookup result pre-fill, manual `Input`s (title, authors, isbn, language), ownership `Select`. No `prompt()`/`alert()`.

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit** — `feat(web): Add screen with ISBN lookup, manual entry, batch mode`.

---

### Task 10: Book detail + reading status + tags

**Files:** `apps/web/src/pages/BookDetail.tsx`, `BookDetail.test.tsx`.

- [ ] **Step 1: Test** — loads book + all members' statuses; editing my status (Select + rating + note) calls `PUT /api/books/:id/status`; adding/removing a tag calls the tag endpoints; the actions `DropdownMenu` includes move-shelf (calls `PATCH`), edit, delete (soft → navigates back to `/library`).

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** — cover, edition info, members' statuses list, my-status editor, tag chips with add/remove, actions `DropdownMenu`. Loan history shown here too (reuse Task 11's loan fetch) or linked from the Loans tab — keep this task to book/status/tags and leave the "lend" action to open a `Dialog` defined in Task 11.

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit** — `feat(web): BookDetail with status editor, tags, and actions`.

---

### Task 11: Loans screen + contacts + Bookcases

**Files:** `apps/web/src/pages/Loans.tsx`, `Loans.test.tsx`, `Bookcases.tsx`, `Bookcases.test.tsx`, `Profile.tsx`, `Profile.test.tsx`.

- [ ] **Step 11a: `Loans.tsx`** — active lent/borrowed with due dates (overdue = destructive `Badge`), returned history, contact management via `Dialog` (create/edit contact, matching the invite-dialog pattern), "lend out" `Dialog` (pick book + contact + due date) reachable from `BookDetail`. Test: active list renders, overdue badge shows, marking returned calls `PATCH` and moves to history.

- [ ] **Step 11b: `Bookcases.tsx`** — list bookcases, add bookcase, add shelf to a bookcase, reorder/edit. Test: create bookcase + shelf calls the right endpoints.

- [ ] **Step 11c: `Profile.tsx`** — reading counts (query from `/api/books` client-side or a small aggregate — keep it simple), wishlist (priority-sorted filter), household name + role, **invite `Dialog` moved here from the old Home**, sign-out (moved to `AppShell` header but also fine here). Test: renders counts + wishlist; invite dialog opens/creates.

Each: failing test → implement → pass → commit.

---

### Task 12: Update stale references + full verification

- [ ] **Step 1: Sweep for stale "Plan 2/Plan 3" references.** Search the repo for `Plan 2`, `Plan 3`, `Books arrive`, `Sync arrives` and fix:
  - `apps/web/src/pages/Home.tsx` placeholder (handled in Task 7, but re-verify it's gone).
  - `docs/superpowers/plans/2026-07-16-taakify-plan-1-foundation.md` — this has more than a stray forward reference; it makes **substantive statements about old-numbering Plan 2 (sync)** that are now factually wrong under the new numbering, not just stale pointers. A one-line note is not enough — reword each of these in place:
    - Line 9 (tech stack): "`pg` (no ORM...) matches the PGlite client-side idiom coming in Plan 2" → Plan 2 is now Books (no PGlite); this should say "coming in Plan 3" or reference the Sync plan by name.
    - Line 85: "`packages/shared` is deliberately absent — it arrives in Plan 2" → now arrives in Plan 3; fix the number.
    - Line 194: "Electric is otherwise unused until Plan 2 — booting it now proves..." → Electric work is now Plan 3.
    - Line 1903 (exit criteria): "actual sync is Plan 2" → now Plan 3.
    Add a short note near the top of the doc (e.g. under its title) that plans were renumbered for feature-first ordering and point at this plan's spec §3, in addition to fixing each inline reference above — the note alone doesn't fix statements that are actively incorrect, not merely stale.
  - `docs/superpowers/specs/2026-08-01-taakify-ui-restyle-design.md` §1 references "a previously-planned Plan 2 (ElectricSQL sync) or Plan 3 (books domain)" — update to reflect renumbering.

- [ ] **Step 2: Full test + typecheck + build**
  Run: `pnpm --filter @taakify/api test && pnpm --filter @taakify/web typecheck && pnpm --filter @taakify/web test && pnpm --filter @taakify/web build`
  Expected: all green.

- [ ] **Step 3: Manual GUI journey** (use the web-gui-tester skill against `localhost:5173`):
  1. Sign up → create household → land on Library (empty state).
  2. Add a book by ISBN (use a real ISBN, e.g. `9780062316097` — Sapiens) → verify cover/title pre-fill.
  3. Add one manually → set my status to "reading" + rating 4 → add a tag.
  4. Create a bookcase + shelf → move the book onto it via BookDetail actions.
  5. Filter the Library by tag and by status → both narrow the list.
  6. Create a contact → lend the book out with a due date → Loans tab shows it active.
  7. Mark returned → it moves to history.
  8. Sign up a second household in a fresh session → its Library is empty and never shows the first household's books.

- [ ] **Step 4: Commit** any doc/reference fixes, then open the PR.

---

## Plan 2 exit criteria

- All API tests green (`books`, `editions`, `shelves`, `reading-status`, `tags`, `contacts`, `loans`) including RLS isolation tests for books and loans.
- All web tests green (one per screen), mocking at the module boundary.
- `typecheck` + `build` clean for web; `typecheck` clean for API.
- Manual GUI journey (Step 3 above) passes, with screenshot evidence stored under `gui-test-screenshots/`.
- No stale "Plan 2 = Sync / Plan 3 = Books" references remain.
- Zero use of `prompt()`/`alert()`/`confirm()`; loading uses `Skeleton`; errors use `Alert`/toast — restyle conventions upheld.
