# Taakify: Home Screen Design

**Date:** 2026-09-04
**Status:** Approved for planning
**Spec refs:** `docs/superpowers/specs/2026-07-16-taakify-bookshelf-design.md` §6
Screen #1 ("Home — overdue loans (red, top), to-return list, per-member
Currently Reading strips, recently added"), Journey 5 ("overdue surfaces red
on Home").
**Gap analysis:** `docs/superpowers/plans/2026-09-03-taakify-design-spec-gaps.md`
gap #3 (P2).

## Goal

Add the fifth bottom-tab screen the design spec calls for: a household
landing page that surfaces what needs attention (overdue loans, books to
give back) and what's currently happening (who's reading what, what was
just added) without anyone having to go looking for it on Library or Loans.
No new backend, no new mirror tables — this is read-only aggregation over
data that already syncs to the client (`loan`, `book`, `edition`,
`reading_status`) plus the household roster already fetched by
`HouseholdProvider`.

## Data layer

New module `apps/web/src/lib/repo/home.ts`, four read-only functions, all
querying the local PGlite mirror directly (same pattern as `books.ts` /
`loans.ts`) — no `enqueue()`, nothing here writes.

```ts
listOverdueLoans(householdId: string): Promise<Loan[]>
listToReturnLoans(householdId: string): Promise<Loan[]>
listCurrentlyReading(householdId: string): Promise<ReadingStatusWithBook[]>
listRecentlyAdded(householdId: string, limit?: number): Promise<Book[]>
```

- **`listOverdueLoans`** — `loan` joined to `book`/`edition`/`contact` (same
  shape as `loans.ts`'s `LOAN_SELECT`), `WHERE household_id = $1 AND
  deleted_at IS NULL AND returned_date IS NULL AND due_date IS NOT NULL AND
  due_date < CURRENT_DATE`, `ORDER BY due_date ASC` (most overdue first),
  `LIMIT 5`. Both `direction`s included: `lent_out` means someone else is
  overdue returning a book to this household; `borrowed_in` means this
  household is overdue returning a book it borrowed. Both are red/urgent;
  the UI distinguishes them by phrasing, not styling (see Screen layout).
- **`listToReturnLoans`** — same join, `WHERE household_id = $1 AND
  deleted_at IS NULL AND returned_date IS NULL AND direction = 'borrowed_in'
  AND (due_date IS NULL OR due_date >= CURRENT_DATE)`, `ORDER BY due_date
  ASC NULLS LAST`, `LIMIT 5`. Deliberately excludes anything
  `listOverdueLoans` already returns (the `due_date < CURRENT_DATE` cutoff
  is mutually exclusive with `>= CURRENT_DATE`), so no loan appears in both
  sections.
- **`listCurrentlyReading`** — `reading_status` joined to `book`/`edition`,
  `WHERE household_id = $1 AND status = 'reading' AND deleted_at IS NULL`,
  `ORDER BY updated_at DESC`. Returns a flat list of `{ user_id, book: Book,
  started_at }` rows; the screen groups them by `user_id` client-side (using
  `useHousehold().members` for display names) and caps each member's strip
  at 5 client-side after grouping — capping in SQL would risk starving a
  member with many reads in favor of one with few, since there's no
  `PARTITION BY` available through the query builder pattern this repo layer
  uses elsewhere.
- **`listRecentlyAdded`** — `book` joined to `edition`, `WHERE household_id
  = $1 AND deleted_at IS NULL`, `ORDER BY created_at DESC`, `LIMIT
  ($2 ::= 5)`.

All four functions `await ready` first and take a plain `householdId`
string, matching every existing repo function's signature.

## Screen layout (`apps/web/src/pages/Home.tsx`)

Top to bottom, each section a `<Card>`-style block matching the visual
language already used on Loans/Library. Order is a deliberate product
choice, overriding the original design spec's "overdue, top" ordering:
what's actively happening in the household (reading, newly added) leads,
loan bookkeeping (return reminders, overdue) follows.

1. **Currently reading** — one horizontal strip per household member who
   has at least one `reading` status; strip header is the member's name,
   items are cover+title, capped at 5 per member with "See all →" linking
   to `/library?status=reading&statusUserId={id}` when that member's strip
   is at cap. A member with zero currently-reading books gets no strip at
   all (not an empty one).
2. **Recently added** — grid/list of the 5 most recent books (cover+title,
   same `BookCard`-style tile Library already uses), "See all in Library →"
   link to `/library` always shown here (recently-added has no natural stopping
   point the way overdue/to-return do, so the link isn't conditional on a
   count).
3. **To return** — one row per loan: cover thumbnail, title, due date shown
   (or "no due date" if null), neutral styling. "See all in Loans →" link
   to `/loans` appears only when the section is at its cap (5) — a weak
   "there might be more" signal, not an exact count, since this list is
   intentionally capped rather than paginated.
4. **Overdue** (destructive/red styling — reuses the same `Alert
   variant="destructive"` treatment `Loans.tsx` already uses for its
   overdue rows) — same row shape as To return, with a phrase built from
   `direction` (`lent_out` → "Overdue from {contact}"; `borrowed_in` →
   "Overdue — return to {contact}") and days overdue instead of a due date.
   Same conditional "See all in Loans →" link. Still styled as the most
   urgent section regardless of its position last on the page — red stays
   red.

**Empty states:** a section with zero rows renders nothing (no heading, no
placeholder) — a household with no overdue loans just doesn't show an
Overdue section. The one exception: if *all four* sections have each
individually finished loading with zero rows (brand-new household, nothing
catalogued yet), Home renders a single centered prompt — "Nothing here yet.
Add your first book to get started." — with a button linking to `/add`,
since an otherwise-blank screen under the header reads as broken rather
than "all caught up." This prompt only appears once every section has
reached that state — see Loading & error handling below for what "finished
loading" means when sections load independently.

## Loading & error handling

Each section is independent end to end: its own fetch, its own loading
skeleton, its own error/retry — a slow or failing query in one section
never blocks, hides, or delays the other three.

- **Independent fetching:** `Home.tsx` does not `Promise.all` the four
  `home.ts` calls into one combined loading state. Each section component
  fires its own effect calling its own loader on mount, via a small shared
  hook, `useHomeSection<T>(loader: () => Promise<T[]>)` in
  `apps/web/src/pages/use-home-section.ts`, that tracks that one section's
  `{ status: "loading" | "error" | "loaded", data, reload }` — reused by all
  four sections rather than four hand-rolled copies of the same
  fetch/error/retry state machine.
- **Loading:** each section renders a skeleton shaped like its real content
  while its own fetch is in flight, using the existing `<Skeleton>`
  component (same primitive `SyncGate` already uses for the cold-start
  loading screen): Currently Reading shows a skeleton strip of cover-sized
  rectangles per expected member row; Recently Added shows a skeleton grid
  matching the real grid's shape; To Return and Overdue each show a couple
  of skeleton list rows.
- **Error:** a fetch failure renders a small inline `Alert
  variant="destructive"` scoped to just that section (e.g. "Couldn't load
  currently reading") with a "Retry" button that calls that section's own
  `reload()`. Nothing else on the page is affected — the other three
  sections keep whatever state they're independently in.
- **Retry:** re-invokes only the failed section's loader (`reload()` from
  `useHomeSection`), re-entering that section's own loading skeleton while
  the retry is in flight. It never re-fetches the other three.
- **All-empty prompt timing:** the "Nothing here yet" prompt (above) is
  derived from the four sections' individual `status`/`data`, not computed
  once up front — it renders only when all four have reached `status ===
  "loaded"` with `data.length === 0`. While any section is still `loading`
  or sitting in `error`, the prompt stays hidden; each section renders its
  own skeleton, error, content, or (if already loaded-empty) nothing, on
  its own schedule.

## Routing changes

- `App.tsx`: `<Route path="/" element={<Navigate to="/library" />} />`
  becomes `<Route path="/" element={<Home />} />`. `/library` is unchanged
  and still directly reachable.
- `AppShell.tsx`'s `TabBar`: a new `TabLink` for Home (using `lucide-react`'s
  `Home` icon) is inserted first, before Library; the `grid-cols-4` on the
  `<nav>` becomes `grid-cols-5`.

## Testing

`Home.test.tsx` (mocking `lib/repo/home.ts`'s four functions and
`useHousehold`, same pattern as `Library.test.tsx`/`Loans.test.tsx`):

- an overdue `lent_out` loan renders under Overdue with "Overdue from
  {contact}" phrasing and destructive styling
- an overdue `borrowed_in` loan renders under Overdue with "Overdue —
  return to {contact}" phrasing
- a non-overdue `borrowed_in` loan renders under To return, not Overdue
- currently-reading items group correctly under each member's own strip by
  name
- recently-added renders newest-first
- when a repo function returns exactly 5 rows (the cap), the section's "See
  all" link renders; when it returns fewer, the link doesn't
- an all-empty response from all four functions renders the "add your first
  book" prompt instead of four empty sections
- **independent loading:** with three loaders resolved and one left
  deliberately pending, the three resolved sections render their real
  content (or nothing, if empty) while the pending one still shows its
  skeleton — proves one slow section doesn't block the others
- **per-section skeleton:** each section renders its own skeleton markup
  while its loader is pending, before resolving it
- **per-section error + retry:** one loader rejecting renders that
  section's own `Alert variant="destructive"` and Retry button, while the
  other three sections render normally (not blocked, not also erroring);
  clicking Retry calls only the failed loader again (assert the other three
  mocked loaders were not called a second time)
- **all-empty prompt gating:** with three loaders resolved empty and the
  fourth still pending, the "Nothing here yet" prompt does *not* render;
  once the fourth also resolves empty, it does. With three resolved empty
  and the fourth rejected, the prompt never renders — that section's error
  state shows instead

`useHomeSection.test.ts` (the shared hook, in isolation via
`@testing-library/react`'s `renderHook`): starts in `loading`, transitions
to `loaded` with the resolved data, transitions to `error` on rejection,
and `reload()` re-invokes the loader and re-enters `loading`.

`App.test.tsx` / `AppShell.test.tsx`: update for the new `/` → `Home` route
and the 5th tab.

`home.test.ts` (repo layer, same PGlite-in-memory pattern as
`loans.test.ts`/`import.test.ts`): seed loan/book/reading_status rows
directly and assert each of the four functions' filtering/ordering/limit
behavior, including the overdue/to-return mutual-exclusivity boundary at
`due_date = CURRENT_DATE` (today's due date is *not* overdue, so it must
appear in To return, not Overdue).
