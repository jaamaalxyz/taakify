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
