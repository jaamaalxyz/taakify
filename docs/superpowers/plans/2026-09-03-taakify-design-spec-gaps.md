# Taakify: Design Spec Gap Analysis

**Date:** 2026-09-03
**Status:** Proposed — prioritized list, no implementation started
**Source:** compared current `main` (post PR #24) against
`docs/superpowers/specs/2026-07-16-taakify-bookshelf-design.md`

## Context

All V1 work tracked in GitHub issues is closed (391 tests green, typecheck
clean, no open PRs). Before starting a Plan 4, this doc audits the original
design spec for features it describes that have no corresponding code, so
the next round of work can be chosen deliberately instead of drifting.

Verified absent by grep/search across `apps/api/src` and `apps/web/src`:
no ZXing/barcode dependency or camera-capture code, no CSV/Goodreads
importer, no cover-upload endpoint or S3/R2 client (`cover_url` is only
ever *read*, sourced from Open Library/Google Books), no `Home` route (4
tabs — Library/Add/Loans/Profile — exist, not the spec's 5), no Playwright
dependency or `e2e/` directory.

## Ranked gaps

### 1. Goodreads CSV import (P0)

**Spec refs:** Goal #5 ("Get 500+ existing books cataloged fast"), Journey
2, §9 Testing ("Goodreads import mapper" named as one of only two
highest-risk areas warranting dedicated unit tests).

**Why it's #1:** the spec's primary use case is cataloging an existing
500+ book library. Without this, that library must be entered one book at
a time through Add — batch mode helps, but 500+ manual/ISBN entries is not
"fast." This is the biggest gap between the app and its stated reason for
existing. It's also explicitly flagged as high-risk-if-wrong (silent data
loss/mismapping on a one-time bulk operation is much worse than a bug in a
frequently-used flow), which argues for doing it deliberately rather than
last.

**Rough shape:** CSV upload → per-row mapper (Goodreads shelf → `ownership`/
`reading_status`: read→finished, to-read→want_to_read, currently-reading→
reading; ratings carried) → editions created/matched, books + importer's
reading_status inserted → per-row error report, unmatched columns preserved
in notes (per spec §8, never silently dropped).

### 2. Barcode scanning (P1)

**Spec refs:** Goal #5, Journey 2 (gap-filling during bulk import), Journey
3 ("at the bookstore (offline)... scan-to-wishlist"), Screen #3 (Add).

**Why it's #2:** it's the fast path for both cataloging an existing shelf
and the recurring "should I buy this?" bookstore check — the app's
mobile-first framing depends on this being camera-scan, not typed ISBN.
It also directly feeds gap #1 (CSV import will still leave books without
Goodreads ISBNs, which barcode scan fills fastest). Ranked below CSV import
because it speeds up an already-functional manual/ISBN-text Add flow,
whereas CSV import is currently a hard wall for bulk cataloging.

**Rough shape:** ZXing browser barcode reader wired into `Add.tsx`'s ISBN
tab, camera permission handling, decoded ISBN feeds the existing lookup
flow unchanged.

### 3. Home screen (P2)

**Spec refs:** §6 Screens (5 tabs: Home, Library, Add, Loans, Profile).

**Why it's #3:** structural gap against the spec (4 tabs exist, not 5),
but every piece of underlying data it would surface already exists and is
reachable elsewhere (overdue on Loans, per-member reading status on
BookDetail, recently-added via Library sort). This is a real UX gap —
overdue loans and active reads aren't front-and-center on open — but it
degrades convenience, not capability, unlike gaps #1/#2 which block a
stated journey outright.

**Rough shape:** new `/` route/tab aggregating: overdue loans (red, top),
to-return list, per-member "Currently Reading" strips, recently added —
querying existing mirror tables, no new backend needed.

### 4. Cover image upload / storage (P3)

**Spec refs:** Goal #1 exception (Cloudflare R2 via S3 API, swappable
`put`/`delete` interface), Goal #6 (local titles/authors first-class —
"ISBN lookup often fails for local books"), Release Plan V1 ("camera cover
photo upload for books with no online cover").

**Why it's #4:** meaningfully affects the stated first-class-local-books
goal (a local title with no Open Library/Google Books hit currently has no
way to get a cover at all), but a missing cover doesn't block cataloging,
reading tracking, or lending — it's cosmetic. Also the largest new
infrastructure surface of the remaining gaps (object storage client,
upload endpoint, offline-queued photo capture per spec §8), so it's
reasonable to sequence after the higher-leverage, lower-infra gaps above.

**Rough shape:** `put`/`delete` storage interface behind Cloudflare R2 (per
spec, swappable to MinIO), an upload endpoint, a camera-capture control on
BookDetail/Add for books with no `cover_url`, outbox-queued so offline
photo capture survives restarts.

### 5. Playwright E2E suite (P3)

**Spec refs:** §9 Testing ("E2E: Playwright smoke tests across the five
screens, including one offline scenario").

**Why it's #5 (lowest):** valuable for regression confidence but purely
internal — no user-facing capability depends on it, and the existing
Vitest unit/integration coverage (391 tests, including a real sync
integration test for household isolation) already covers the two areas the
spec calls highest-risk. Worth doing, but not before any user-facing gap
above, and naturally follows gap #3 once a fifth (Home) screen exists to
include in the "five screens" smoke pass.

**Rough shape:** Playwright config + one spec per screen (Library, Home,
Add, Loans, Profile) plus one offline-mode scenario (airplane mode add →
reconnect → verify sync), run against `pnpm dev:api` + `pnpm dev:web`.

## Suggested sequencing

P0 → P1 are both required for the app to deliver on its stated primary use
case (cataloging an existing library fast) and should be treated as one
short series, likely CSV import first since it's a hard blocker rather
than a speedup. P2 (Home) is a good next increment since it's pure
UI over existing data — cheap, no new backend. P3 items (cover upload,
E2E) are lower urgency and can be reordered relative to each other; E2E is
listed last only because it's more useful once Home exists to test.

## Not gaps (verified correctly out of scope for V1)

- Billing/Stripe integration — explicit non-goal until V2; worth a
  follow-up check that `household.plan`/`plan_status`/`billing_customer_id`
  columns exist per the data model even though billing itself is deferred.
- Contact→real-user linking — V1.5.
- Stats dashboards beyond simple reading counts — V1.5 (`Profile.tsx`
  already has counts by ownership).
- Native mobile apps — explicit non-goal, PWA only.
