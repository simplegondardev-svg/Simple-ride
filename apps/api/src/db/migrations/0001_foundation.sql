-- Extensions, the runtime role, and the request-context helpers that every
-- RLS policy is built on.

CREATE EXTENSION IF NOT EXISTS postgis;

-- The runtime role normally comes from infra/postgres/init.sh (with LOGIN and
-- a password). Create a NOLOGIN placeholder if it is missing so migrations
-- never depend on that script having run.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'simpleride_app') THEN
    CREATE ROLE simpleride_app NOLOGIN NOBYPASSRLS;
  END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS app;
GRANT USAGE ON SCHEMA app TO simpleride_app;
GRANT USAGE ON SCHEMA public TO simpleride_app;

-- Request context. The API sets these with set_config(..., true) at the start
-- of every transaction (see src/db/context.ts), so they reset at COMMIT.
--   app.user_id : uuid of the authenticated user, empty for anonymous
--   app.role    : 'customer' | 'driver' | 'admin' | 'system' | 'anonymous'
-- 'system' is never derived from a token; only trusted server code paths
-- (login, dispatch, payments callbacks) use it.
CREATE FUNCTION app.uid() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

CREATE FUNCTION app.role() RETURNS text
  LANGUAGE sql STABLE
  AS $$ SELECT coalesce(nullif(current_setting('app.role', true), ''), 'anonymous') $$;

CREATE FUNCTION app.is_admin() RETURNS boolean
  LANGUAGE sql STABLE
  AS $$ SELECT app.role() = 'admin' $$;

-- Admins and trusted server code: full access through the policies.
CREATE FUNCTION app.is_staff() RETURNS boolean
  LANGUAGE sql STABLE
  AS $$ SELECT app.role() IN ('admin', 'system') $$;

CREATE FUNCTION app.touch_updated_at() RETURNS trigger
  LANGUAGE plpgsql
  AS $$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;
