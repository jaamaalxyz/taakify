# Taakify — Home Bookshelf Organizer: Design Spec

**Date:** 2026-07-16
**Status:** Approved by user (brainstorming complete)

## 1. Overview

Taakify is a mobile-first, local-first web application for organizing a home
library of 500+ books. It tracks per-person reading lifecycle, physical shelf locations, lending books out to friends, and books borrowed in from others. It is built for one household initially but is multi-tenant (SaaS-ready) from the first migration.

**Primary users:** a family of 2–4 members, each with their own login, sharing
one library. **Later:** other households as paying SaaS customers.

## 2. Goals & Non-Goals

Goals:

- Answer "do we own this?" and "where is it?" instantly, even offline at a
  bookstore or standing at the shelf.
- Track each family member's reading lifecycle independently per book.
- Never lose a lent-out book to forgetfulness: due dates, overdue visibility,
  loan history per contact.
- Track borrowed-in books (readable like any book, never counted as owned,
  nagged for return).
- Get 500+ existing books cataloged fast: Goodreads CSV import + rapid
  barcode/manual batch entry.
- Handle local titles/authors as first-class (Unicode throughout; smooth
  manual entry because ISBN lookup often fails for local books).
- Every component fully open source (MIT/Apache 2.0), free for commercial
  use, self-hostable. No proprietary services, no source-available licenses.

Non-Goals (v1):

- Billing/payments (schema fields exist; no integration until V2).
- Native mobile apps (PWA only).
- Borrowers using the app themselves (they are contacts; linking to real
  accounts is V1.5+).
- Price/condition/insurance tracking (explicitly declined).
- Reading progress (pages/percent) — lifecycle states only.

## 3. Architecture

**Local-first with sync.** Every device runs a full copy of the household's
data in an in-browser database. All reads and writes are local and instant
(fully offline-capable); a sync engine replicates changes through a central
Postgres server in the background.

**Components (all MIT or Apache 2.0):**

| Component        | Choice                                                  | Role                                                               |
| ---------------- | ------------------------------------------------------- | ------------------------------------------------------------------ |
| Frontend         | React + Vite SPA, installable PWA                       | Mobile-first UI                                                    |
| On-device DB     | PGlite (Postgres WASM, persisted to IndexedDB)          | Local reads/writes, real SQL                                       |
| Read-path sync   | ElectricSQL (self-hosted Docker)                        | Streams Postgres → devices, partitioned per household via shapes   |
| Write path       | Client outbox queue → Hono (Node) API → server Postgres | Offline writes queue and survive restarts; API validates + applies |
| Auth             | better-auth                                             | Email/password logins, sessions                                    |
| Server DB        | Postgres (Docker)                                       | Source of truth; RLS per household                                 |
| Barcode scanning | ZXing (browser, phone camera)                           | ISBN capture                                                       |
| Book metadata    | Open Library + Google Books APIs (free)                 | ISBN/title lookup, covers                                          |
| Cover storage    | Server disk (cached from Open Library)                  | No proprietary object store                                        |

**Hosting:** single Oracle Cloud always-free ARM VM running Docker Compose
(Postgres, Electric, API, static frontend behind nginx). $0/month.

**Conflict resolution:** last-write-wins via `updated_at`. Conflicts in this
domain are rare and benign. Loan return operations are idempotent.

**Tenancy enforcement:** Postgres row-level security policies and Electric
sync shapes both key on a direct `household_id` column present on every
tenant-scoped table. A device only ever syncs its own household's rows.
The global `edition` table syncs partially — only editions referenced by the
household's books.

## 4. Data Model

UUIDs everywhere (offline-safe inserts), `updated_at` on all tables
(last-write-wins), soft deletes (`deleted_at`), `created_by` on tenant tables.

Identity & tenancy:

- `user` — login identity (better-auth managed). No library data.
- `household` — the tenant. `name`, `plan` (default `free`), `plan_status`,
  nullable `billing_customer_id`.
- `membership` — user ↔ household with `role` (`owner`/`admin`/`member`).
  A user may belong to multiple households.
- `invite` — email, household, role, token, expiry.

Shared catalog (global, no household_id):

- `edition` — the abstract book: `isbn` (nullable), `title`, `authors`,
  `language`, `publisher`, `published_year`, `cover_url`, `series_name`
  (nullable), `series_number` (nullable). Shared across all tenants;
  created from API lookups or manual entry.

**Tenant-scoped (all carry `household_id`)**

- `book` — a physical copy: `edition_id`, `ownership`
  (`owned`/`borrowed_in`/`wishlist`), `format`, `shelf_id` (nullable),
  `do_not_lend` (boolean), `wishlist_priority`
  (`high`/`medium`/`low`, nullable, wishlist only), `notes`.
  Duplicate copies = multiple rows.
- `bookcase` — `name`. `shelf` — `bookcase_id`, `position`, optional label.
- `reading_status` — (`book_id`, `user_id`) → `status`
  (`unread`/`want_to_read`/`reading`/`finished`/`abandoned`),
  `started_at`, `finished_at`, `rating` (1–5, nullable), `review_note`.
  One row per member per book.
- `tag` + `book_tag` — freeform labels, combinable filters.
- `contact` — `name`, `phone`, `email`, nullable `linked_user_id`.
- `loan` — `book_id`, `contact_id`, `direction` (`lent_out`/`borrowed_in`),
  `out_date`, `due_date`, `returned_date` (null = active), `notes`.
  Overdue = active AND `due_date` < today. History = all rows per
  book/contact. A borrowed-in book = `book.ownership='borrowed_in'` +
  active `loan` with `direction='borrowed_in'`.

## 5. Key User Journeys (validated with user)

1. **Setup** — signup → create household → define bookcases/shelves →
   invite family via link.
2. **Bulk import** — Goodreads CSV → editions + books + importer's
   reading_status (shelf mapping: read→finished, to-read→want_to_read;
   ratings carried). Gaps filled by barcode scan or fast manual entry in
   batch mode (shelf stays pre-selected between adds).
3. **At the bookstore (offline)** — instant local search answers "do we own
   this?"; scan-to-wishlist with priority.
4. **Reading** — member updates their own status/rating/note; other
   members' statuses unaffected.
5. **Lending out** — pick/create contact, set due date → active loan badge,
   overdue surfaces red on Home → mark returned (history kept).
6. **Borrowing in** — book added as `borrowed_in`, readable like any book,
   badged, excluded from owned counts, "To return" list nags.
7. **SaaS later** — new users create their own households (isolation already
   enforced); paid plan flips `household.plan`; contacts link to real users.

## 6. Screens

Bottom tab bar, five screens:

1. **Home** — overdue loans (red, top), to-return list, per-member
   Currently Reading strips, recently added.
2. **Library** — instant local search across all books (owned, borrowed-in,
   wishlist — ownership shown as badge/filter), combinable filters
   (status × tag × shelf × language × ownership), browse by bookcase/shelf.
   Book page: cover, edition + copy details, all members' statuses, loan
   history, actions (lend, move shelf, edit, update my status).
3. **Add** (center button) — barcode scan / ISBN / title search / manual, batch mode, CSV import.
4. **Loans** — active lent-out / borrowed-in with due dates; per-contact
   history; contact management.
5. **Profile & Stats** — reading counts, wishlist (priority-sorted),
   household settings, invites.

## 7. Release Plan

**V1 — household release:** auth + household + invites; full data model;
Goodreads CSV import; ISBN/title lookup + manual + barcode scan; batch add;
shelves; per-member lifecycle with dates/ratings/notes; tags + filters;
instant search; lending/borrowing with due dates, overdue views, history;
wishlist with priority; do-not-lend; camera cover photo upload for books
with no online cover (photos taken offline queue in the outbox); PWA
install; full offline read/write with sync.

**V1.5:** stats dashboards; overdue email reminders (server cron);
contact→user linking.

**V2 — SaaS:** public signups, billing (Stripe/Paddle behind existing plan
fields), landing page, cross-household features ("your network owns this"),
book-club households.

## 8. Error Handling

- Metadata API failure/miss → fall through to manual form pre-filled with
  whatever was found. Never block on external APIs.
- Offline writes → outbox queue, persisted, retried; survives app restarts.
- Sync conflicts → last-write-wins (`updated_at`); loan return idempotent.
- CSV import → per-row error report; unmatched columns preserved in notes,
  never silently dropped.

## 9. Testing

- **Unit:** Goodreads import mapper; loan/overdue logic (the two highest-risk
  areas).
- **Integration:** sync rules / RLS household isolation — the SaaS-critical
  invariant (household A must never receive household B's rows).
- **E2E:** Playwright smoke tests across the five screens, including one
  offline scenario (airplane mode add → sync on reconnect).
