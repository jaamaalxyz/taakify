# Taakify Books Domain: Polish & Follow-ups

**Date:** 2026-08-08
**Status:** Proposed (post-merge of Plan 2 — PR #5)
**Scope:** `apps/web` (mostly) + one small `apps/api` addition. Non-blocking
improvements surfaced during the Plan 2 review. None are correctness or
security defects — Plan 2 shipped secure (RLS + app-layer cross-tenant
guards) and fully functional. These are UX consistency, completeness, and
polish items to make the library feel finished before/alongside the Sync plan.

**Goal:** close the small gaps that keep the Books domain from feeling like a
complete V1 product: a members list so other members aren't anonymous,
drag-to-reorder shelves, better feedback when adding a book fails, and a
handful of label/consistency nits. All are independently shippable.

---

## Context

Plan 2 (PR #5) delivered the entire Books domain: book/shelf/loan/tag/contact/
reading-status CRUD over RLS, plus the six-screen bottom-tab web app. The
review verified the full GUI journey end-to-end against the live API and
confirmed 102 API + 57 web tests green, typecheck + build clean.

During that review four non-blocking issues were noted. The ownership-badge
label bug (raw `owned` vs `Owned`) was fixed immediately in the same change
that introduced `apps/web/src/lib/labels.ts` (the shared enum/label module).
This plan covers the remaining three plus a couple of closely-related polish
items that fall out naturally.

---

## Issues

### Issue 1 — Members are anonymous outside your own row (P1)

**Where:** `BookDetail.tsx`'s "Household statuses" section renders other
members as `Member (<user_id>)` because there's no endpoint to resolve a
user id to a display name. Documented in a code comment as a known gap.

**Why it matters:** a household library's whole pitch is *shared* — seeing
"Member (8f3a...)" next to a reading status defeats that. This is the most
user-visible gap in the shipped product.

**Fix:** add `GET /api/households/:id/members` (or fold it into `/api/me`'s
already-returned memberships) returning `{ id, name, email, role }[]` for the
caller's household, RLS-scoped via `membership`. `BookDetail` resolves the
statuses' `user_id` against this list client-side. Cache it in
`HouseholdProvider` so every screen shares one fetch.

**Files:**
- `apps/api/src/routes/households.ts` — add the members endpoint
- `apps/api/test/households.test.ts` — RLS isolation test (B can't list A's members)
- `apps/web/src/lib/household-context.tsx` — fetch + expose `members`
- `apps/web/src/pages/BookDetail.tsx` — replace `Member (<id>)` with the name

### Issue 2 — No drag-and-drop shelf reordering (P2)

**Where:** `Bookcases.tsx` only edits shelf labels. The server already
accepts `position` on `PATCH /api/shelves/:id` (shelves.ts), and shelves are
rendered ordered by position — there's just no UI to reorder them. Marked
out-of-scope in a code comment.

**Why it matters:** "move this shelf to the top" is a natural bookshelf
action and the backend is ready; only the UI is missing.

**Fix:** add up/down (or drag) controls per shelf that `PATCH` the new
positions. Simplest correct version: up/down arrow buttons that swap the
current shelf's position with its neighbor and PATCH both (the
`SELECT ... FOR UPDATE` lock in `POST /api/bookcases/:id/shelves` already
serializes position writes on that bookcase). Full DnD (@dnd-kit) is a
larger surface — start with the arrow buttons and only escalate if users ask.

**Files:**
- `apps/web/src/pages/Bookcases.tsx` — reorder controls + PATCH calls
- `apps/web/src/pages/Bookcases.test.tsx` — test the reorder PATCH
- No API change needed (position PATCH already exists)

### Issue 3 — Lend-out action isn't reachable from BookDetail (P2)

**Where:** the Plan 2 spec (`books-design.md` §6, BookDetail) called for a
"lend" action in the BookDetail `DropdownMenu`, but the shipped DropdownMenu
only has Move shelf / Edit / Delete. Lending lives only behind the Loans tab's
"Add loan" dialog, where you must re-pick the book.

**Why it matters:** from a book's page, "lend this one out" is the obvious
next action; sending the user to another tab to re-find the book is friction.

**Fix:** add a "Lend out" item to BookDetail's actions menu that opens a
Dialog reusing the Loans screen's lend form (extract the form into a shared
`<LendDialog bookId={...} />` component, or duplicate the small form). On
success, toast + optionally show the new active loan inline on the detail page.

**Files:**
- `apps/web/src/pages/BookDetail.tsx` — add menu item + dialog
- `apps/web/src/pages/Loans.tsx` — extract the lend form if sharing
- `apps/web/src/pages/BookDetail.test.tsx` — test the lend POST

### Issue 4 — Add-book failure feedback is a bare error string (P3)

**Where:** `Add.tsx` shows `submitError` (the raw server `error` message) in a
destructive `Alert`. For an RLS 403 it reads "forbidden"; for a validation
miss it reads "editionId or edition.title required" — accurate but unfriendly
to a household member who just wanted to add a book.

**Why it matters:** low — these failures are rare (the client validates title
required). But "forbidden" is a confusing word for a non-technical family
member.

**Fix:** map the known server error strings to friendlier copy in the Add
screen's catch (e.g. "forbidden" → "You can't add books to this household.";
the title-required case is already client-gated). Small, localized change.

**Files:**
- `apps/web/src/pages/Add.tsx` — error-message mapping in the catch block

### Issue 5 — Build chunk-size advisory (P3, informational)

**Where:** `pnpm --filter @taakify/web build` warns the main chunk is
~516 kB (> 500 kB). It's only the standard Vite advisory, not a failure.

**Why it matters:** barely — first-load perf is fine for a household tool.
Worth a one-time pass to code-split the route screens
(`React.lazy` + `Suspense` per screen under `AppShell`) so the initial bundle
is just the shell + auth. Defer unless we measure a real load-time problem.

**Files:**
- `apps/web/src/App.tsx` — lazy-load screen components

---

## Done already (for reference)

- **Ownership badge label bug** — `BookDetail.tsx` rendered raw `{book.ownership}`
  ("owned") instead of "Owned". Fixed by extracting the enum types + label
  maps (ownership, reading status, wishlist priority) into
  `apps/web/src/lib/labels.ts` and using `OWNERSHIP_LABELS[book.ownership]`.
  The same module also de-duplicated the per-screen type/label re-definitions
  across BookCard, StatusBadge, Library, Add, BookDetail, and Profile, and
  fixed two sibling raw-render nits (BookDetail's status Select showed
  "want_to_read"; Profile's wishlist badge showed "high"). Web tests (57/57)
  and typecheck remain green.

---

## Suggested ordering

1. **Issue 1 (members list)** — highest user-visible impact, small, unblocks
   the "shared library" feeling. Do first.
2. **Issue 3 (lend from BookDetail)** — natural follow-on to #1 (both touch
   BookDetail), small, removes real friction.
3. **Issue 2 (shelf reorder)** — self-contained, backend-ready, medium.
4. **Issue 4 (friendly errors)** — tiny, bundle with any of the above.
5. **Issue 5 (chunk split)** — optional, only if we care about first-load.

Each issue is a standalone PR — none depend on the others.

## Out of scope (explicitly deferred)

- Offline / PGlite / ElectricSQL / outbox (→ Plan 3: Sync).
- Barcode/camera scan, camera cover-photo upload, Goodreads CSV import
  (already deferred in Plan 2's spec §9).
- Stats dashboards, email reminders, contact→user linking (V1.5).
