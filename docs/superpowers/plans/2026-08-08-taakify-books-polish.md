# Taakify Books Domain: Polish & Follow-ups

**Date:** 2026-08-08 (revised 2026-08-08 after Issue 1 shipped — PR #7)
**Status:** Proposed (post-merge of Plan 2 — PR #5; Issue 1 merged — PR #7)
**Scope:** `apps/web` (mostly) + small `apps/api` additions. Non-blocking
improvements surfaced during the Plan 2 review. None are correctness or
security defects — Plan 2 shipped secure (RLS + app-layer cross-tenant
guards) and fully functional. These are UX consistency, completeness, and
polish items to make the library feel finished before/alongside the Sync plan.

**Goal:** close the small gaps that keep the Books domain from feeling like a
complete V1 product: drag-to-reorder shelves, a lend action that closes the
loop on "who has my book," honest and consistent error feedback everywhere
(not just one screen), and a couple of near-zero-cost wins that fall out of
work already shipped. All are independently shippable.

---

## Context

Plan 2 (PR #5) delivered the entire Books domain: book/shelf/loan/tag/contact/
reading-status CRUD over RLS, plus the six-screen bottom-tab web app. The
review verified the full GUI journey end-to-end against the live API and
confirmed 102 API + 57 web tests green, typecheck + build clean.

During that review four non-blocking issues were noted. The ownership-badge
label bug (raw `owned` vs `Owned`) was fixed immediately in the same change
that introduced `apps/web/src/lib/labels.ts` (the shared enum/label module).
The members-list gap (Issue 1 below) shipped in PR #7. This revision folds
that in, widens Issue 4 after discovering it understated the actual problem
(see below), strengthens Issue 3 with a product angle the original framing
missed, and adds one new near-zero-cost issue that Issue 1's work unlocked
for free.

---

## Issues

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

### Issue 3 — BookDetail can't answer "who has this book?" (P1, upgraded from P2)

**Where:** the Plan 2 spec (`books-design.md` §6, BookDetail) called for a
"lend" action in the BookDetail `DropdownMenu`, but the shipped DropdownMenu
only has Move shelf / Edit / Delete. Lending lives only behind the Loans tab's
"Add loan" dialog, where you must re-pick the book. There is also no display
of an *existing* active loan anywhere on BookDetail — if a book is currently
lent out, its own detail page gives no indication of that at all.

**Why it matters, reframed:** the original framing treated this as "the lend
button is in the wrong place," which understates it. The actual product gap
is bigger: **a book's own page can't answer "is this lent out, and to whom?"**
— the single most useful piece of context for a book sitting on your shelf.
Someone opens a book's detail page precisely to decide "can I lend this?" or
"who do I need to remind?", and today they get zero signal and have to cross
-reference the Loans tab manually. Adding a menu item that opens a form is
the smaller half of the fix; showing the current loan state is the half that
actually removes friction from the *most common* reason someone visits this
screen.

**Fix (two parts, do both — the first is the one that matters most):**
1. **Show current loan status on BookDetail.** If the book has an active loan
   (`direction`, `contact.name`, `due_date`, and the existing server-computed
   `overdue` flag — same shape `GET /api/loans` already returns), render it
   near the top of the page (e.g. next to the ownership badge): "Lent to Alex
   · due Mar 3" or a destructive-styled "Overdue — lent to Alex" using the
   same overdue treatment Loans.tsx already has. This needs a small API
   addition: `GET /api/books/:id` currently returns no loan info — either add
   an optional joined "active loan" to that response, or have BookDetail fire
   a second `GET /api/loans?householdId=&bookId=<id>&active=true` (adding a
   `bookId` filter param to the existing loans list endpoint, mirroring its
   existing `contactId` filter). The second option is less invasive (no
   change to `books.ts`'s response shape, which multiple screens depend on).
2. **Add a "Lend out" menu item** that opens a dialog to create a loan for
   this book — only needed/shown when there's no *already-active* loan (once
   part 1 exists, showing both an active-loan banner and a "lend out" action
   would be contradictory). Reuse the Loans screen's lend form (extract into
   a shared `<LendDialog bookId={...} />`, or duplicate the small form —
   your call at implementation time) but skip the book-picker `Select`
   entirely, since the book is already known from context — a smaller,
   friendlier form than the Loans-tab version.

On success, toast + refresh the new active-loan display in place (no
navigation away).

**Files:**
- `apps/api/src/routes/loans.ts` — add `bookId` query filter to `GET /api/loans` (mirrors the existing `contactId` filter, same pattern)
- `apps/web/src/pages/BookDetail.tsx` — active-loan display + "Lend out" menu item + dialog
- `apps/web/src/pages/Loans.tsx` — extract the lend form if sharing
- `apps/web/src/pages/BookDetail.test.tsx` — test the loan-status display (active + overdue + none) and the lend POST

### Issue 4 — Raw server error strings leak to the UI on every Books-domain screen, not just Add (P2, upgraded from P3 and widened)

**Where:** the original framing scoped this to `Add.tsx` alone. It's not
scoped there — it's the default error-handling pattern across every
Books-domain screen. Every screen's mutation handlers do the same thing:
`catch (err) { setXError((err as Error).message) }`, then render that string
in a destructive `Alert`. A repo-wide check of every Books-domain screen's
error state turns up **~15 separate render sites** doing this identically:

| Screen | Raw-error render sites |
| --- | --- |
| `Add.tsx` | 1 (the one the original issue named) |
| `BookDetail.tsx` | 6 (load, tags, status, shelf, edit, delete) |
| `Loans.tsx` | 4 (load, mark-returned, contact save, lend) |
| `Bookcases.tsx` | 3 (load, add bookcase, add/edit shelf) |
| `Profile.tsx` | 1 (invite) |
| `Library.tsx` | 1 (load) |

The app-shell's own `/api/me` load failure (`household-context.tsx`) is also
converted as part of this issue, since it's the first error a user could ever
hit (e.g. an expired session) and the fix is a trivial one-line swap using
the same `friendlyError()` helper. The auth/invite/onboarding flow
(`InviteAccept.tsx`, `Onboarding.tsx`) is deliberately left out of scope —
not because it doesn't matter, but because those screens live outside the
Books domain and their existing raw error text (`"expired"`, `"already
accepted"`) is already clear enough that converting it isn't the same
problem this issue targets.

And the server-side strings are genuinely unfriendly and, worse,
**ambiguous**: `grep`-ing every route's `c.json({ error: ... })` call shows
`"forbidden"` and `"not found"` are each reused across many different routes
for unrelated underlying situations (an RLS rejection vs. a resource that
doesn't exist vs. a cross-household validation check all return `"not
found"` from different routes). A "you don't have permission" vs. "that book
was already deleted" distinction is real and worth making to the user, but
the message text alone can't reliably tell them apart.

**Why it matters:** every failure path in the app currently shows a
household member unfiltered backend language ("forbidden", "nothing to
update"). This is the single most-repeated rough edge in the shipped
product — more instances than any other issue in this plan — and it's the
first thing a non-technical user sees the moment *anything* goes wrong,
anywhere.

**Root cause worth fixing before mapping strings, not after:** `apps/web/src/lib/api.ts`'s
`api()` helper throws `new Error(body.error ?? ...)` and **discards the HTTP
status code entirely** — the caller only ever sees message text, never
`403`/`404`/`400`. That's *why* every screen's friendly-copy options are
currently limited to fragile message-text matching (`"forbidden"` happens to
be stable today, but nothing enforces that, and `"not found"` already can't
be disambiguated by text alone). This mirrors a lesson this codebase already
learned the hard way on the server side — Plan 2's review caught and fixed
RLS-error handling that matched `err.message` text instead of the stable
`err.code`, precisely because message text isn't a contract. The same fix
belongs on the client: make status codes a first-class part of thrown errors
before building a friendly-copy layer on top of message strings that could
shift under it later.

**Fix (two layers):**
1. **`apps/web/src/lib/api.ts`**: throw a small `ApiError extends Error` that
   carries `status: number` alongside the message, so callers (and the
   friendly-copy layer below) can branch on the stable HTTP status instead of
   parsing text.
2. **`apps/web/src/lib/error-messages.ts`** (new, same pattern as
   `lib/labels.ts` — one shared module instead of one map per screen): a
   `friendlyError(err: unknown): string` helper. Branch primarily on
   `ApiError.status` (401 → "Please sign in again."; 403 → "You don't have
   permission to do that."; 404 → "That doesn't exist anymore — try
   refreshing."), with a small set of known-message overrides layered on top
   for the validation strings that are already clear enough to show as-is
   (`"nothing to update"`, the `direction`/`rating`/status-enum messages).
   Swap every screen's `catch (err) { setXError((err as Error).message) }`
   to `catch (err) { setXError(friendlyError(err)) }` — mechanical, one line
   per site, no behavior change beyond the copy shown.

**Files:**
- `apps/web/src/lib/api.ts` — `ApiError` with `status`
- `apps/web/src/lib/error-messages.ts` — new, `friendlyError()` + its own test file (same rigor as `labels.test.ts`)
- `apps/web/src/pages/Add.tsx`, `BookDetail.tsx`, `Loans.tsx`, `Bookcases.tsx`, `Profile.tsx`, `Library.tsx` — swap every `(err as Error).message` render site to `friendlyError(err)`
- `apps/web/src/lib/household-context.tsx` — the app-shell's `/api/me` load-failure Alert, plus its own new test file

### Issue 5 — Build chunk-size advisory (P3, informational)

**Where:** `pnpm --filter @taakify/web build` warns the main chunk is
~516 kB (> 500 kB). It's only the standard Vite advisory, not a failure.

**Why it matters:** barely — first-load perf is fine for a household tool.
Worth a one-time pass to code-split the route screens
(`React.lazy` + `Suspense` per screen under `AppShell`) so the initial bundle
is just the shell + auth. Defer unless we measure a real load-time problem.

**Files:**
- `apps/web/src/App.tsx` — lazy-load screen components

### Issue 6 — Profile has no household roster, even though the data is now free (P3, new)

**Where:** Issue 1 (PR #7) added `useHousehold().members` — a cached,
app-wide roster fetch — but the only screen consuming it today is
`BookDetail`'s status-list name resolution. `Profile.tsx`, the screen whose
entire job is "household name + role + settings," has no "who's in this
household" list at all, even though the exact data it would need is already
sitting in context with zero additional network cost.

**Why it matters:** this is the kind of win that's easy to miss precisely
*because* it's nearly free — Issue 1 was scoped narrowly to fix BookDetail's
anonymous-member bug, correctly, but that means the natural product payoff
(a real "who's in my household" view) wasn't captured as part of shipping
it. Profile is where a user would actually look for this.

**Fix:** render `useHousehold().members` as a simple list on Profile (name +
role badge, using the existing `OWNERSHIP_LABELS`-style pattern for a role
label if one doesn't already read cleanly — "owner"/"admin"/"member" may be
fine as-is). No new fetch, no new endpoint — purely a rendering addition
against data this screen can already read from context.

**Files:**
- `apps/web/src/pages/Profile.tsx` — render the roster
- `apps/web/src/pages/Profile.test.tsx` — test it renders each member's name

---

## Done already (for reference)

- **Ownership/status/priority label bugs** — raw enum values (`owned`,
  `want_to_read`, `high`) rendered verbatim instead of title-cased. Fixed by
  extracting enum types + label maps into `apps/web/src/lib/labels.ts` (later
  extended to also cover `Loans.tsx`'s loan-direction labels and given its
  own `labels.test.ts`), de-duplicating six screens' local redefinitions.
- **Members are anonymous outside your own row (Issue 1, PR #7)** — `BookDetail`
  rendered other members as `Member (<user_id>)`. Fixed with a dedicated
  `GET /api/households/:id/members` (RLS-gated membership check on `withUser`,
  then the roster read on `adminPool` since the app role has no grant on the
  better-auth `user` table — same two-pool pattern as household create/invite
  accept), cached once in `HouseholdProvider` as `useHousehold().members` so
  every screen shares one fetch. `BookDetail` now resolves real names; own
  row always shows "You". Reviewed with real cross-household RLS isolation
  tests and a "no extra fields leak" assertion on the roster shape.
  105 API / 66 web tests green. **Issue 6 below is the direct follow-on this
  unlocked** — the roster is already cached and unused everywhere but
  BookDetail.
- **Raw server error strings leak to the UI (Issue 4)** — `apps/web/src/lib/api.ts`'s
  `api()` now throws a status-carrying `ApiError`, and `apps/web/src/lib/error-messages.ts`'s
  `friendlyError()` maps it to user-facing copy (401/403/404 branches, plus an
  allowlist for already-clear validation/conflict messages like `"nothing to
  update"` and `"book already tagged"`). All six Books-domain screens
  (`Add`, `BookDetail`, `Loans`, `Bookcases`, `Profile`, `Library`) and the
  app-shell's `household-context.tsx` `/api/me` load failure now use it;
  `InviteAccept.tsx`/`Onboarding.tsx` are deliberately left as-is (see Issue
  4 above).

---

## Suggested ordering

Revised after Issue 1 shipped and after widening Issue 4's actual scope
(see above — it turned out to be an app-wide pattern, not an `Add.tsx`-only
fix, which changes its priority relative to the others):

1. **Issue 4 (error handling, app-wide)** — bumped to first. It's the
   broadest-impact, most-repeated rough edge in the shipped product (~15
   sites across 6 screens, not 1), and fixing the `api()` status-code gap
   now means every later issue's own error handling (the lend dialog in
   Issue 3, the reorder PATCHes in Issue 2) can use `friendlyError()` from
   day one instead of being written the old way and needing a second pass.
   Doing this first makes every subsequent PR in this plan slightly smaller.
2. **Issue 3 (loan status + lend from BookDetail)** — highest remaining
   product-experience impact: closes the "who has my book?" loop that Issue
   1 opened for reading statuses but left open for loans. Small API addition
   (one query param), most of the work is the display + reused form.
3. **Issue 6 (Profile roster)** — do alongside or immediately after Issue 3,
   since both are "make the shared-household data Issue 1 fetched actually
   visible somewhere" — bundle into the same PR as Issue 3 if convenient, or
   ship separately; either way it's nearly free (no new fetch).
4. **Issue 2 (shelf reorder)** — self-contained, backend-ready, medium size,
   no dependency on anything else in this plan.
5. **Issue 5 (chunk split)** — optional, only if we measure a real load-time
   problem. Still last — it's the only issue with zero user-facing effect
   today.

Each issue is still an independently shippable PR — the ordering above is a
recommendation for impact-per-effort, not a hard dependency chain, except
where noted (Issue 4 first makes 2/3 marginally cheaper; Issue 6 pairs
naturally with Issue 3).

## Out of scope (explicitly deferred)

- Offline / PGlite / ElectricSQL / outbox (→ Plan 3: Sync).
- Barcode/camera scan, camera cover-photo upload, Goodreads CSV import
  (already deferred in Plan 2's spec §9).
- Stats dashboards, email reminders, contact→user linking (V1.5).
