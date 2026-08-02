-- App role: what the API uses for all tenant-data access. RLS applies to it.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'taakify_app') THEN
    -- Dev-only password. Production pre-creates this role with a real secret
    -- (the IF NOT EXISTS guard makes this block a no-op there); the API reads
    -- credentials from APP_DATABASE_URL, never from this file.
    CREATE ROLE taakify_app LOGIN PASSWORD 'taakify_app_dev';
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO taakify_app;
-- No DELETE grant anywhere: deletes are soft (UPDATE deleted_at).
-- Grants mirror the RLS policy surface (least privilege; RLS is the backstop).
GRANT SELECT, UPDATE ON household TO taakify_app;
GRANT SELECT ON membership TO taakify_app;
GRANT SELECT, INSERT ON invite TO taakify_app;
GRANT SELECT, INSERT, UPDATE ON
  edition, bookcase, shelf, book,
  reading_status, tag, book_tag, contact, loan
TO taakify_app;

-- Membership lookup that bypasses RLS (SECURITY DEFINER, owned by the
-- migration superuser) to avoid policy recursion on membership itself.
CREATE FUNCTION app_user_households() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT household_id FROM membership
  WHERE user_id = current_setting('app.user_id', true)
    AND deleted_at IS NULL
$$;

ALTER TABLE household ENABLE ROW LEVEL SECURITY;
CREATE POLICY household_select ON household FOR SELECT
  USING (id IN (SELECT app_user_households()));
CREATE POLICY household_update ON household FOR UPDATE
  USING (id IN (SELECT app_user_households()));
-- No INSERT policy: households are created via the privileged pool (service op).

ALTER TABLE membership ENABLE ROW LEVEL SECURITY;
CREATE POLICY membership_select ON membership FOR SELECT
  USING (household_id IN (SELECT app_user_households()));
-- No INSERT/UPDATE policies: memberships change only via privileged service ops.

ALTER TABLE invite ENABLE ROW LEVEL SECURITY;
CREATE POLICY invite_select ON invite FOR SELECT
  USING (household_id IN (SELECT app_user_households()));
CREATE POLICY invite_insert ON invite FOR INSERT
  WITH CHECK (household_id IN (SELECT app_user_households()));
-- Acceptance (UPDATE) happens via the privileged pool: the accepting user
-- is not yet a member, so no RLS path can permit it.

-- Global catalog: readable/writable by any authenticated user.
ALTER TABLE edition ENABLE ROW LEVEL SECURITY;
CREATE POLICY edition_select ON edition FOR SELECT USING (true);
CREATE POLICY edition_insert ON edition FOR INSERT WITH CHECK (true);
CREATE POLICY edition_update ON edition FOR UPDATE USING (true);

-- Tenant data tables: uniform member-only CRUD (soft delete = UPDATE).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['bookcase','shelf','book','reading_status','tag','book_tag','contact','loan'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I_select ON %I FOR SELECT USING (household_id IN (SELECT app_user_households()))', t, t);
    EXECUTE format(
      'CREATE POLICY %I_insert ON %I FOR INSERT WITH CHECK (household_id IN (SELECT app_user_households()))', t, t);
    EXECUTE format(
      'CREATE POLICY %I_update ON %I FOR UPDATE USING (household_id IN (SELECT app_user_households()))', t, t);
  END LOOP;
END $$;
