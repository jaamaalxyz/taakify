-- Local PGlite mirror schema.
--
-- Mirrors the household-scoped book-domain tables from the server
-- (apps/api/migrations/0002_core.sql), minus `household`, `membership`,
-- `invite`, and better-auth's own tables -- household context lives in
-- `household-context.tsx` already and isn't synced locally. Also adds a
-- local-only `outbox` table for offline writes (see Task 5).
--
-- Deliberate deviations from the server schema:
--   - No `REFERENCES` foreign-key clauses to other local tables. This is a
--     read cache fed by an Electric shape stream; enforcing FK order during
--     shape catch-up (rows can arrive before the rows they reference) is
--     unnecessary friction, not a correctness requirement.
--   - No `CHECK` constraints (e.g. on `ownership`, `status`, `direction`).
--     Validation is the server's job (RLS + CHECK there); the mirror trusts
--     what it's given. `@taakify/shared`'s enum types can be used at the
--     TypeScript layer for reads instead.
--   - No RLS. The browser is a single-user context; tenancy is enforced by
--     which Electric shape the household subscribes to, not by Postgres-style
--     row policies.
--   - Every `CREATE TABLE` is `IF NOT EXISTS` so `pglite.ts` can re-run this
--     schema on every app open without erroring on an already-open mirror.

-- edition: global shared catalog, no household_id (mirrors the server table
-- of the same name, which likewise has no tenant scoping).
CREATE TABLE IF NOT EXISTS edition (
  id uuid PRIMARY KEY,
  isbn text,
  title text NOT NULL,
  authors text NOT NULL DEFAULT '',
  language text,
  publisher text,
  published_year int,
  cover_url text,
  series_name text,
  series_number numeric(6,2),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz
);

CREATE TABLE IF NOT EXISTS bookcase (
  id uuid PRIMARY KEY,
  household_id uuid NOT NULL,
  name text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz
);

CREATE TABLE IF NOT EXISTS shelf (
  id uuid PRIMARY KEY,
  household_id uuid NOT NULL,
  bookcase_id uuid NOT NULL,
  position int NOT NULL,
  label text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz
);

CREATE TABLE IF NOT EXISTS book (
  id uuid PRIMARY KEY,
  household_id uuid NOT NULL,
  edition_id uuid NOT NULL,
  ownership text NOT NULL,
  format text,
  shelf_id uuid,
  do_not_lend boolean NOT NULL DEFAULT false,
  wishlist_priority text,
  notes text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz
);

CREATE TABLE IF NOT EXISTS reading_status (
  id uuid PRIMARY KEY,
  household_id uuid NOT NULL,
  book_id uuid NOT NULL,
  user_id text NOT NULL,
  status text NOT NULL,
  started_at date,
  finished_at date,
  rating int,
  review_note text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz
);

CREATE TABLE IF NOT EXISTS tag (
  id uuid PRIMARY KEY,
  household_id uuid NOT NULL,
  name text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz
);

CREATE TABLE IF NOT EXISTS book_tag (
  id uuid PRIMARY KEY,
  household_id uuid NOT NULL,
  book_id uuid NOT NULL,
  tag_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz
);

CREATE TABLE IF NOT EXISTS contact (
  id uuid PRIMARY KEY,
  household_id uuid NOT NULL,
  name text NOT NULL,
  phone text,
  email text,
  linked_user_id text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz
);

CREATE TABLE IF NOT EXISTS loan (
  id uuid PRIMARY KEY,
  household_id uuid NOT NULL,
  book_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  direction text NOT NULL,
  out_date date NOT NULL,
  due_date date,
  returned_date date,
  notes text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz
);

-- Local-only: queue of writes made while offline (or optimistically, before
-- server confirmation), replayed against the API by Task 5's outbox worker.
--
-- `touched`: which mirror row(s) this row's optimistic write applied to --
-- a jsonb array of {"table": ..., "id": ...}, derived from the optimistic
-- SQL statements passed to enqueue() (see outbox.ts's deriveTouchedEntities).
-- Exists so a dismissed row (final review fix round, Important 6) doesn't
-- silently leave an orphaned, permanently-diverged-from-server optimistic
-- row with no trace of which row it was -- listDismissedTouchedEntities()
-- reads this to expose "these mirror rows may be out of sync" for a future
-- UI affordance to act on. Nullable/absent for rows enqueued before this
-- column existed (pre-fix-round data) or with no optimistic write at all.
CREATE TABLE IF NOT EXISTS outbox (
  id uuid PRIMARY KEY,
  endpoint text NOT NULL,
  method text NOT NULL,
  body jsonb,
  touched jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  attempts int NOT NULL DEFAULT 0,
  next_retry_at timestamptz,
  status text NOT NULL DEFAULT 'pending'
);

-- Additive migration for local mirrors created before `touched` existed
-- (this schema has no separate migration-tracking mechanism -- see the
-- file header comment -- so an ALTER ... ADD COLUMN IF NOT EXISTS
-- alongside the CREATE TABLE IF NOT EXISTS above is how a column gets
-- added to an already-persisted browser database). A no-op on a fresh
-- mirror, where the CREATE TABLE above already includes the column.
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS touched jsonb;
