CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE household (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  plan text NOT NULL DEFAULT 'free',
  plan_status text NOT NULL DEFAULT 'active',
  billing_customer_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE membership (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES household (id),
  user_id text NOT NULL REFERENCES "user" ("id"),
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX membership_live_uniq ON membership (household_id, user_id) WHERE deleted_at IS NULL;
CREATE INDEX membership_user_idx ON membership (user_id);

CREATE TABLE invite (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES household (id),
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'member')),
  token text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  created_by text NOT NULL REFERENCES "user" ("id"),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

-- Global shared catalog: no household_id by design.
CREATE TABLE edition (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  isbn text,
  title text NOT NULL,
  authors text NOT NULL DEFAULT '',
  language text,
  publisher text,
  published_year int,
  cover_url text,
  series_name text,
  series_number numeric(6,2),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX edition_isbn_idx ON edition (isbn);

CREATE TABLE bookcase (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES household (id),
  name text NOT NULL,
  created_by text NOT NULL REFERENCES "user" ("id"),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE shelf (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES household (id),
  bookcase_id uuid NOT NULL REFERENCES bookcase (id),
  position int NOT NULL,
  label text,
  created_by text NOT NULL REFERENCES "user" ("id"),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE book (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES household (id),
  edition_id uuid NOT NULL REFERENCES edition (id),
  ownership text NOT NULL CHECK (ownership IN ('owned', 'borrowed_in', 'wishlist')),
  format text,
  shelf_id uuid REFERENCES shelf (id),
  do_not_lend boolean NOT NULL DEFAULT false,
  wishlist_priority text CHECK (wishlist_priority IN ('high', 'medium', 'low')),
  notes text,
  created_by text NOT NULL REFERENCES "user" ("id"),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE reading_status (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES household (id),
  book_id uuid NOT NULL REFERENCES book (id),
  user_id text NOT NULL REFERENCES "user" ("id"),
  status text NOT NULL CHECK (status IN ('unread', 'want_to_read', 'reading', 'finished', 'abandoned')),
  started_at date,
  finished_at date,
  rating int CHECK (rating BETWEEN 1 AND 5),
  review_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX reading_status_live_uniq ON reading_status (book_id, user_id) WHERE deleted_at IS NULL;

CREATE TABLE tag (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES household (id),
  name text NOT NULL,
  created_by text NOT NULL REFERENCES "user" ("id"),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX tag_live_uniq ON tag (household_id, name) WHERE deleted_at IS NULL;

CREATE TABLE book_tag (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES household (id),
  book_id uuid NOT NULL REFERENCES book (id),
  tag_id uuid NOT NULL REFERENCES tag (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX book_tag_live_uniq ON book_tag (book_id, tag_id) WHERE deleted_at IS NULL;

CREATE TABLE contact (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES household (id),
  name text NOT NULL,
  phone text,
  email text,
  linked_user_id text REFERENCES "user" ("id"),
  created_by text NOT NULL REFERENCES "user" ("id"),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE loan (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES household (id),
  book_id uuid NOT NULL REFERENCES book (id),
  contact_id uuid NOT NULL REFERENCES contact (id),
  direction text NOT NULL CHECK (direction IN ('lent_out', 'borrowed_in')),
  out_date date NOT NULL DEFAULT CURRENT_DATE,
  due_date date,
  returned_date date,
  notes text,
  created_by text NOT NULL REFERENCES "user" ("id"),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX membership_household_idx ON membership (household_id);
CREATE INDEX bookcase_household_idx ON bookcase (household_id);
CREATE INDEX shelf_household_idx ON shelf (household_id);
CREATE INDEX book_household_idx ON book (household_id);
CREATE INDEX reading_status_household_idx ON reading_status (household_id);
CREATE INDEX tag_household_idx ON tag (household_id);
CREATE INDEX book_tag_household_idx ON book_tag (household_id);
CREATE INDEX contact_household_idx ON contact (household_id);
CREATE INDEX loan_household_idx ON loan (household_id);
CREATE INDEX invite_household_idx ON invite (household_id);
