-- Phone + password login for every role (replaces SMS codes for now).
--
-- Credentials live in their own table, NOT on users: admins and staff can
-- read user rows, and a password hash must never come back from any query
-- they can run. Only server code in the 'system' context touches this
-- table (register, login, password change, resets).

CREATE TABLE user_credentials (
  user_id               uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  password_hash         text NOT NULL,          -- scrypt$N$r$p$salt$hash
  -- true for temporary passwords issued by an admin or support: the user
  -- must choose their own before they get a session.
  must_change_password  boolean NOT NULL DEFAULT false,
  password_changed_at   timestamptz NOT NULL DEFAULT now(),
  failed_attempts       smallint NOT NULL DEFAULT 0,
  locked_until          timestamptz
);

GRANT SELECT, INSERT, UPDATE ON user_credentials TO simpleride_app;

ALTER TABLE user_credentials ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_credentials_system_only ON user_credentials FOR ALL
  USING (app.role() = 'system') WITH CHECK (app.role() = 'system');

-- Without SMS codes nobody proves they own their number at signup. Recorded
-- here so verification can be added later (and required for sensitive
-- actions) without another schema change. NULL = never verified.
ALTER TABLE users ADD COLUMN phone_verified_at timestamptz;

-- Support can issue temporary passwords to riders and drivers who forgot theirs.
INSERT INTO permissions (code, category, description, sort_order) VALUES
  ('users.reset_password', 'Riders & drivers', 'Reset rider and driver passwords (issue a temporary password)', 12);

-- Support needs to find the rider whose password they reset.
CREATE OR REPLACE FUNCTION app.can_see_people() RETURNS boolean
  LANGUAGE sql STABLE
  AS $$
    SELECT app.can('users.view') OR app.can('users.suspend') OR app.can('users.reset_password')
        OR app.can('trips.view')
        OR app.can('finance.daybook.view') OR app.can('finance.wallets.view')
        OR app.can('sos.view') OR app.can('sos.manage')
  $$;
