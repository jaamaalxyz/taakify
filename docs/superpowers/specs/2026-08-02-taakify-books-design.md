# Taakify Books Domain: Design Spec

**Date:** 2026-08-02
**Status:** Approved for planning (feature-first ordering — precedes the Sync plan)
**Scope:** `apps/api` (new routes) + `apps/web` (new screens). One additive migration (columns only — no schema redesign).

## 1. Overview

Plans 1 (Foundation) and the UI restyle shipped the identity/tenancy spine
(auth → household → invite → accept) plus the full data model with RLS, but
**every book-domain table is schema-ready only** — there are no routes and no
UI for `edition`, `book`, `bookcase`, `shelf`, `reading_status`, `tag`,
`book_tag`, `contact`, or `loan`.

This plan builds the **book domain as an online API-first feature**: the web
app reads and writes books through the same Hono API and `withUser` RLS
transaction helper the household/invite flows already use. There is **no
local-first/offline layer here** — that is the Sync plan, which now layers on
top of this one. Feature-first means users get a working library sooner, and
the Sync plan gets a real domain to replicate instead of an empty one.

The Home page placeholder text (`"Books arrive in Plan 3. Sync arrives in
Plan 2."`) is now stale after renumbering and is updated here to
`"Sync arrives in a later plan."` (the Books plan *is* this one).

## 2. Goals & Non-Goals

Goals (this plan):

- Add books to a household: by manual entry, by ISBN lookup (Open Library +
  Google Books), and by batch/manual add with a sticky shelf.
- Organize: bookcases → shelves → books; move a book between shelves.
- Track per-member reading lifecycle independently (status, dates, rating,
  note) — one `reading_status` row per member per book.
- Tag books and filter the library by status × tag × shelf × ownership.
- Lend books out and borrow books in, with due dates, overdue surfacing, and
  per-contact history. Manage contacts.
- Instant-ish search across the household's books (server-side `ILIKE` for
  now; the truly instant local search arrives with Sync/PGlite).
- Wishlist with priority; do-not-lend flag.

Non-Goals (deferred — see §7):

- **Offline / local-first read-write** — the entire Sync plan (PGlite +
  ElectricSQL + outbox). Reads/writes here hit the API.
- **Barcode scanning** (ZXing/camera) — deferred to a later mobile-focused
  pass; this plan ships ISBN text entry + manual entry + CSV import.
- **Camera cover-photo upload** — deferred to the Sync plan (photos taken
  offline queue in the outbox); this plan uses online cover URLs only.
- **Goodreads CSV import** — large surface, low-coupling; split into its own
  follow-up plan so it doesn't bloat this one. (Schema already supports it.)
- **Stats dashboards** — V1.5 per the foundational spec.
- Any change to auth, household, invite, RLS structure, or the existing
  five-page auth flow.

## 3. Feature-First Strategy & Rationale

The foundational spec's §3 describes a local-first architecture (PGlite +
ElectricSQL). The original plan ordering built Sync (Plan 2) before Books
(Plan 3). We are **reversing that**:

| Feature-first (this roadmap) | Sync-first (original) |
| --- | --- |
| Books work online against the API immediately | Books work only after Sync ships |
| Users get a usable library now | Library appears later |
| Sync plan gets a real domain to replicate | Sync integrates against an empty domain |
| Search is server-side `ILIKE` (good enough at 500 books) | Search is instant/offline from day one |
| Offline is deferred to the Sync plan | Offline is foundational |

The `pg`-no-ORM decision in Plan 1 still holds: hand-written SQL on the
server, and the same queries translate cleanly to PGlite client-side when
the Sync plan lands.

## 4. API Surface

All routes are mounted under `/api`, use `requireUser`, and read/write
tenant data through `withUser(user.id, ...)` (RLS-enforced). The two
existing privileged-pool service ops (household create, invite accept) are
unchanged.

New route files under `apps/api/src/routes/`:

- `editions.ts` — `GET /api/editions/lookup?isbn=...` (proxies Open Library
  + Google Books, merges the first hit into a pre-filled edition payload;
  never blocks on external failure — §8 error handling).
- `books.ts` — `GET /api/books` (list, with filters + search), `POST
  /api/books` (create, creating an `edition` row if no `edition_id`
  supplied), `GET /api/books/:id`, `PATCH /api/books/:id` (move shelf,
  edit ownership/notes/do-not-lend/wishlist-priority), `DELETE
  /api/books/:id` (soft delete).
- `shelves.ts` — bookcases and shelves CRUD: `GET /api/bookcases`,
  `POST /api/bookcases`, `POST /api/bookcases/:id/shelves`, `PATCH
  /api/shelves/:id`, `DELETE` (soft).
- `reading-status.ts` — `PUT /api/books/:bookId/status` (upsert the
  caller's row; the `UNIQUE (book_id, user_id)` index makes this
  `ON CONFLICT ... DO UPDATE`).
- `tags.ts` — `GET /api/tags`, `POST /api/tags`, `POST
  /api/books/:bookId/tags`, `DELETE /api/books/:bookId/tags/:tagId`.
- `contacts.ts` — CRUD for contacts (household-scoped).
- `loans.ts` — `POST /api/loans` (lend out / borrow in), `PATCH
  /api/loans/:id` (mark returned, set due date), `GET /api/loans`
  (active + history, filterable by contact).

Query/list contract for `GET /api/books`: filters are query params
(`q`, `ownership`, `status`, `tag`, `shelf_id`, `language`); the response is
a page of book rows joined to their edition (title, authors, cover_url) and
the caller's reading status. Pagination is offset-based with a generous page
size (the household is 500-ish books; cursor pagination is premature).

## 5. Migration

**One additive migration:** `apps/api/migrations/0004_books_indexes.sql`.
The tables already exist from Plan 1's `0002_core.sql`; this migration only
adds query-supporting indexes that weren't needed before any rows existed:

```sql
-- Search across title/authors within a household's books.
CREATE INDEX book_household_edition_idx ON book (household_id, edition_id);
-- Active loans lookup by household + returned_date IS NULL.
CREATE INDEX loan_active_idx ON loan (household_id, contact_id)
  WHERE returned_date IS NULL;
-- Reading-status "currently reading" strips on Home.
CREATE INDEX reading_status_user_idx ON reading_status (user_id, status)
  WHERE deleted_at IS NULL;
```

No columns added, no tables added, no RLS policy changes (the Plan 1 RLS
migration already covers every book-domain table with the uniform
member-only CRUD pattern). `0003_rls.sql` already grants
`SELECT, INSERT, UPDATE` on all these tables to `taakify_app` and enables
RLL with `household_id IN (SELECT app_user_households())` policies — so the
new routes need **zero** privileged-pool work; they go entirely through
`withUser`.

## 6. Web Screens

The app keeps the existing five auth/onboarding pages and the restyled
design system (Tailwind v4, shadcn/ui, lucide-react, coral/cream tokens,
Nunito). New screens reuse the **same component library already installed**
under `apps/web/src/components/ui/`. Additional shadcn components are added
by the CLI as editable source (Badge, Select, Tabs, Table, Textarea,
DropdownMenu, Sonner/toast) — see §7 of the restyle spec for the precedent.

Routing grows from a flat set of auth routes to a **bottom-tab app shell**
inside the authed area. `App.tsx`'s route tree becomes:

```
/signup, /signin, /invite/:token        (unchanged)
/onboarding                              (unchanged)
/                                        → redirect to /library
/library                                 Home tab: search + list + filters
/library/:bookId                         book detail (cover, copy, statuses, loan history, actions)
/add                                     Add tab: ISBN/title search + manual + batch
/bookcases                               bookcases/shelves management (reached from Library filter or Profile)
/loans                                   Loans tab: active + history + contacts
/profile                                 Profile tab: reading counts, wishlist, household settings, invites
```

A new `AppShell` layout component renders the bottom tab bar (Home/Library,
Add center button, Loans, Profile) and an `<Outlet/>`. Authed routes are
nested under `AppShell`; the existing invite-accept and onboarding routes
stay outside the shell.

**Loading states** use `Skeleton` (restyle convention) — no "Loading…"
text. **Errors** render in destructive `Alert`s (restyle convention);
mutations that fail show a toast (Sonner) for non-blocking feedback. **No
`prompt()`/`alert()`/`confirm()`** anywhere (restyle convention — the
invite flow already replaced these with `Dialog`).

Page responsibilities:

- **Library** (`Library.tsx`): search box (debounced, server `q`), filter
  chips (ownership, status, tag, shelf), list of book cards (cover
  thumbnail, title, authors, ownership badge, my-status badge), infinite or
  "load more" scroll. Empty state: `Card` + `BookOpen` icon + "Add your
  first book" CTA.
- **Book detail** (`BookDetail.tsx`): cover, edition info, all members'
  statuses, my-status editor (Select + rating + note Textarea), tags, loan
  history, actions (lend, move shelf, edit, delete) in a `DropdownMenu`.
- **Add** (`Add.tsx`): ISBN/manual tabs, batch toggle (shelf stays
  pre-selected between adds), edition-lookup results that pre-fill a manual
  form. Falls through to manual on lookup miss (§8).
- **Loans** (`Loans.tsx`): active lent-out / borrowed-in with due dates
  (overdue = destructive Badge), returned history, contact management
  (`Dialog`-based create/edit, matching the invite dialog pattern).
- **Profile** (`Profile.tsx`): reading counts, wishlist (priority-sorted),
  household name + role, invite trigger (reuses the Home invite `Dialog`),
  sign-out.

## 7. Testing

Follows the two-tier convention proven in the restyle plan:

- **API (`apps/api/test/`)** — one test file per route file
  (`books.test.ts`, `loans.test.ts`, etc.), using the existing
  `global-setup` + `signUp` helper + real Postgres + RLS. Every test signs
  up fresh users and creates households through the real endpoints, then
  asserts the new routes. RLS isolation is re-asserted for the new domain
  (household A's books/loans invisible to household B) — the SaaS-critical
  invariant from spec §9.
- **Web (`apps/web/src/pages/*.test.tsx`)** — one test file per screen,
  mocking `api()` and `authClient` at the module boundary with `vi.mock`
  (restyle convention). Each test renders the screen, asserts it loads,
  drives one primary interaction, and checks the resulting API call +
  visible feedback.
- **Deferred:** Playwright E2E across the new screens (foundational spec
  §9) remains a follow-up; the restyle plan explicitly deferred it and we
  continue that here.

High-risk unit tests per spec §9: **loan/overdue logic** (overdue = active
AND due_date < today; borrowed-in ownership handling) gets a focused test,
since it's the highest-risk domain logic.

## 8. Error Handling

- **Metadata lookup failure/miss** → fall through to the manual form
  pre-filled with whatever fields were found. Never block on Open
  Library/Google Books (foundational spec §8).
- **Soft deletes everywhere** — `DELETE` routes set `deleted_at = now(),
  updated_at = now()`; no hard deletes (Plan 1 convention; RLS grants omit
  DELETE).
- **Last-write-wins** via `updated_at` on every mutation (foundational spec
  §3); the conflict story gets richer in the Sync plan.
- **Validation** — 400 with `{ error }` JSON for bad input (matches existing
  household/invite routes); the web `api()` helper already surfaces
  `body.error` in the destructive `Alert`/toast.

## 9. Out of Scope (explicit)

- Offline / PGlite / ElectricSQL / outbox (→ Sync plan).
- Barcode/camera scan (→ later mobile pass).
- Camera cover-photo upload (→ Sync plan, offline queue).
- Goodreads CSV import (→ its own follow-up plan).
- Stats dashboards, email reminders, contact→user linking (V1.5).
- Any change to auth, households, invites, RLS, or the restyled design
  system's tokens.

## 10. Exit Criteria

- `pnpm --filter @taakify/api test` green, including new RLS isolation tests
  for books and loans.
- `pnpm --filter @taakify/web test` green (new screen tests).
- `pnpm --filter @taakify/web typecheck` and `build` clean.
- Manual GUI journey: create bookcases/shelves → add a book by ISBN → add
  one manually → set my reading status → tag it → filter the library → lend
  it out with a due date → mark returned → a second household's data never
  appears.
- Home page placeholder text updated to reflect renumbering.
