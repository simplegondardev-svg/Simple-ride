-- Staff accounts with a per-person permission list.
--
--   admin  : everything (unchanged), and the only role that manages staff
--   staff  : exactly the permissions an admin switched on for them
--
-- Permissions are loaded into the request context once per transaction by
-- app.init_context(), so policies check a string, not a table, per row.
-- Policies below are ADDED next to those in 0003 (Postgres ORs permissive
-- policies together); nothing from 0003 is loosened for other roles.
--
-- Naming note: app.is_staff() from 0003 means "admin or system" (full
-- access). Staff permissions are checked with app.can('<permission>').

-- ───────────────────────── Catalog ─────────────────────────

CREATE TABLE permissions (
  code         text PRIMARY KEY CHECK (code ~ '^[a-z_]+(\.[a-z_]+)+$'),
  category     text NOT NULL,
  description  text NOT NULL,
  sort_order   smallint NOT NULL DEFAULT 0
);

INSERT INTO permissions (code, category, description, sort_order) VALUES
  ('dashboard.view',         'Dashboard',          'See dashboard statistics', 1),
  ('users.view',             'Riders & drivers',   'View rider and driver accounts', 10),
  ('users.suspend',          'Riders & drivers',   'Suspend or reactivate riders and drivers', 11),
  ('drivers.view',           'Driver onboarding',  'View driver profiles and vehicles', 20),
  ('drivers.approve',        'Driver onboarding',  'Approve, reject or suspend drivers and vehicles', 21),
  ('trips.view',             'Trips',              'View trips, their timeline and ratings', 30),
  ('trips.cancel',           'Trips',              'Cancel active trips', 31),
  ('finance.daybook.view',   'Finance',            'View the day book (all money movements per day)', 40),
  ('finance.wallets.view',   'Finance',            'View wallet balances and transactions', 41),
  ('finance.wallets.adjust', 'Finance',            'Credit or debit a wallet (manual adjustment)', 42),
  ('pricing.manage',         'Pricing & zones',    'Edit vehicle categories, fares and commission', 50),
  ('zones.manage',           'Pricing & zones',    'Create and edit service zones', 51),
  ('sos.view',               'Safety',             'View SOS alerts', 60),
  ('sos.manage',             'Safety',             'Acknowledge and resolve SOS alerts', 61),
  ('audit.view',             'Audit',              'View the audit log', 70);

CREATE TABLE staff_permissions (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission  text NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  granted_by  uuid REFERENCES users(id),
  granted_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, permission)
);

-- Only staff accounts hold permissions (admins already have everything).
CREATE FUNCTION app.check_staff_permission_holder() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id AND role = 'staff') THEN
    RAISE EXCEPTION 'permissions can only be granted to staff accounts' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER staff_permissions_holder BEFORE INSERT OR UPDATE ON staff_permissions
  FOR EACH ROW EXECUTE FUNCTION app.check_staff_permission_holder();

-- Commission is stored on the trip at completion so reports don't depend on
-- the category's current rate.
ALTER TABLE trips ADD COLUMN commission_amount integer;  -- santim

-- ───────────────────────── Request context ─────────────────────────

-- Replaces the two bare set_config calls in db/context.ts. Besides setting
-- the context it re-checks the account on EVERY transaction: a suspended or
-- deleted user, or a token whose role no longer matches, is rejected at
-- once instead of when the access token expires.
CREATE FUNCTION app.init_context(p_user_id uuid, p_role text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE
  v_role   user_role;
  v_status user_status;
  v_perms  text;
BEGIN
  PERFORM set_config('app.user_id', coalesce(p_user_id::text, ''), true);
  PERFORM set_config('app.role', p_role, true);
  PERFORM set_config('app.permissions', '', true);
  IF p_user_id IS NULL OR p_role IN ('system', 'anonymous') THEN
    RETURN;
  END IF;

  SELECT role, status INTO v_role, v_status FROM users WHERE id = p_user_id;
  IF NOT FOUND OR v_status <> 'active' OR v_role::text <> p_role THEN
    RAISE EXCEPTION 'account is not active' USING ERRCODE = '28000';
  END IF;

  IF p_role = 'staff' THEN
    SELECT ',' || string_agg(permission, ',') || ',' INTO v_perms
      FROM staff_permissions WHERE user_id = p_user_id;
    PERFORM set_config('app.permissions', coalesce(v_perms, ''), true);
  END IF;
END $$;

-- Admin/system can do everything; staff only what they were granted.
CREATE FUNCTION app.can(p_permission text) RETURNS boolean
  LANGUAGE sql STABLE
  AS $$
    SELECT app.is_staff()
        OR (app.role() = 'staff'
            AND position(',' || p_permission || ',' IN coalesce(current_setting('app.permissions', true), '')) > 0)
  $$;

-- Any of these lets a staff member see rider/driver accounts (names, phones).
CREATE FUNCTION app.can_see_people() RETURNS boolean
  LANGUAGE sql STABLE
  AS $$
    SELECT app.can('users.view') OR app.can('users.suspend') OR app.can('trips.view')
        OR app.can('finance.daybook.view') OR app.can('finance.wallets.view')
        OR app.can('sos.view') OR app.can('sos.manage')
  $$;

REVOKE ALL ON FUNCTION app.init_context(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.init_context(uuid, text), app.can(text), app.can_see_people()
  TO simpleride_app;

-- ───────────────────────── Aggregate reports ─────────────────────────
-- Totals must count every row, not only the rows the viewer may read, so
-- these run as the owner and check the permission themselves.

CREATE FUNCTION app.dashboard_stats() RETURNS json
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
BEGIN
  IF NOT app.can('dashboard.view') THEN
    RAISE EXCEPTION 'missing permission dashboard.view' USING ERRCODE = '42501';
  END IF;
  RETURN json_build_object(
    'customers',      (SELECT count(*) FROM users WHERE role = 'customer'),
    'drivers',        (SELECT count(*) FROM users WHERE role = 'driver'),
    'pendingDrivers', (SELECT count(*) FROM driver_profiles WHERE approval_status = 'pending'),
    'driversOnline',  (SELECT count(*) FROM driver_profiles WHERE availability <> 'offline'),
    'activeTrips',    (SELECT count(*) FROM trips WHERE status IN ('searching','accepted','arrived','in_progress')),
    'tripsToday',     (SELECT count(*) FROM trips WHERE status = 'completed' AND completed_at > now() - interval '1 day'),
    'openSos',        (SELECT count(*) FROM sos_alerts WHERE status <> 'resolved'));
END $$;

-- The day book: one Addis Ababa calendar day of money movements.
--   trips   : completed trips by payment method (gross fares, commission)
--   ledger  : wallet movements by kind (top-ups, commission, payouts, ...)
--   entries : every wallet transaction that day, in order
CREATE FUNCTION app.daybook(p_day date) RETURNS json
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE
  v_from timestamptz := (p_day::timestamp AT TIME ZONE 'Africa/Addis_Ababa');
  v_to   timestamptz := ((p_day + 1)::timestamp AT TIME ZONE 'Africa/Addis_Ababa');
BEGIN
  IF NOT app.can('finance.daybook.view') THEN
    RAISE EXCEPTION 'missing permission finance.daybook.view' USING ERRCODE = '42501';
  END IF;
  RETURN json_build_object(
    'date', p_day,
    'timezone', 'Africa/Addis_Ababa',
    'trips', (
      SELECT coalesce(json_agg(t ORDER BY t."paymentMethod"), '[]') FROM (
        SELECT payment_method AS "paymentMethod", count(*)::int AS trips,
               coalesce(sum(final_fare), 0)::bigint AS gross,
               coalesce(sum(commission_amount), 0)::bigint AS commission
          FROM trips
         WHERE status = 'completed' AND completed_at >= v_from AND completed_at < v_to
         GROUP BY payment_method) t),
    'ledger', (
      SELECT coalesce(json_agg(l ORDER BY l.kind), '[]') FROM (
        SELECT kind, count(*)::int AS entries,
               coalesce(sum(amount) FILTER (WHERE amount > 0), 0)::bigint AS credits,
               coalesce(-sum(amount) FILTER (WHERE amount < 0), 0)::bigint AS debits
          FROM wallet_transactions
         WHERE created_at >= v_from AND created_at < v_to
         GROUP BY kind) l),
    'entries', (
      SELECT coalesce(json_agg(e ORDER BY e.id), '[]') FROM (
        SELECT w.id, w.created_at AS "createdAt", w.kind, w.amount, w.balance_after AS "balanceAfter",
               w.trip_id AS "tripId", w.reference, u.phone, u.full_name AS "fullName", u.role
          FROM wallet_transactions w JOIN users u ON u.id = w.user_id
         WHERE w.created_at >= v_from AND w.created_at < v_to) e));
END $$;

REVOKE ALL ON FUNCTION app.dashboard_stats(), app.daybook(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.dashboard_stats(), app.daybook(date) TO simpleride_app;

-- ───────────────────────── Column guards (updated) ─────────────────────────
-- Same rules as 0003, plus: a staff member holding the matching permission
-- may change the specific fields that permission is about.

CREATE OR REPLACE FUNCTION app.guard_users() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF app.guarded() AND (
       NEW.role IS DISTINCT FROM OLD.role
    OR NEW.phone IS DISTINCT FROM OLD.phone
    OR (NEW.status IS DISTINCT FROM OLD.status
        AND NOT (app.can('users.suspend') AND OLD.role IN ('customer', 'driver')))) THEN
    RAISE EXCEPTION 'not allowed to change role, status or phone' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION app.guard_driver_profiles() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF app.guarded() AND (
       (TG_OP = 'INSERT' AND NEW.approval_status <> 'pending')
    OR (TG_OP = 'UPDATE' AND (
          NEW.rating_avg IS DISTINCT FROM OLD.rating_avg
       OR NEW.rating_count IS DISTINCT FROM OLD.rating_count
       OR ((NEW.approval_status IS DISTINCT FROM OLD.approval_status
            OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
            OR NEW.approved_by IS DISTINCT FROM OLD.approved_by)
           AND NOT app.can('drivers.approve'))))) THEN
    RAISE EXCEPTION 'not allowed to change approval or rating fields' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION app.guard_vehicles() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF app.guarded() AND NOT app.can('drivers.approve') AND (
       (TG_OP = 'INSERT' AND NEW.status <> 'pending')
    OR (TG_OP = 'UPDATE' AND (
          NEW.status IS DISTINCT FROM OLD.status
       OR NEW.plate_number IS DISTINCT FROM OLD.plate_number
       OR NEW.category_code IS DISTINCT FROM OLD.category_code))) THEN
    RAISE EXCEPTION 'not allowed to change vehicle status, plate or category' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

-- ───────────────────────── Grants ─────────────────────────

GRANT SELECT ON permissions TO simpleride_app;
GRANT SELECT, INSERT, DELETE ON staff_permissions TO simpleride_app;

-- ───────────────────────── Policies ─────────────────────────

ALTER TABLE permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_permissions ENABLE ROW LEVEL SECURITY;

CREATE POLICY permissions_select ON permissions FOR SELECT
  USING (app.role() IN ('admin', 'staff', 'system'));

-- Staff can read their own list; only admins (and trusted server code)
-- grant and revoke. A staff account can never write here.
CREATE POLICY staff_permissions_select ON staff_permissions FOR SELECT
  USING (user_id = app.uid() OR app.is_staff());
CREATE POLICY staff_permissions_write ON staff_permissions FOR ALL
  USING (app.is_staff()) WITH CHECK (app.is_staff());

-- People. Staff never see or touch admin or other staff accounts.
CREATE POLICY users_select_by_permission ON users FOR SELECT
  USING (app.role() = 'staff' AND (
           (role IN ('customer', 'driver') AND app.can_see_people())
        OR (role = 'driver' AND (app.can('drivers.view') OR app.can('drivers.approve')))));
CREATE POLICY users_update_by_permission ON users FOR UPDATE
  USING (app.can('users.suspend') AND role IN ('customer', 'driver'))
  WITH CHECK (app.can('users.suspend') AND role IN ('customer', 'driver'));

CREATE POLICY auth_sessions_select_by_permission ON auth_sessions FOR SELECT
  USING (app.can('users.suspend'));
CREATE POLICY auth_sessions_update_by_permission ON auth_sessions FOR UPDATE
  USING (app.can('users.suspend')) WITH CHECK (app.can('users.suspend'));

-- Fleet.
CREATE POLICY driver_profiles_select_by_permission ON driver_profiles FOR SELECT
  USING (app.can('drivers.view') OR app.can('drivers.approve'));
CREATE POLICY driver_profiles_update_by_permission ON driver_profiles FOR UPDATE
  USING (app.can('drivers.approve')) WITH CHECK (app.can('drivers.approve'));
CREATE POLICY vehicles_select_by_permission ON vehicles FOR SELECT
  USING (app.can('drivers.view') OR app.can('drivers.approve') OR app.can('trips.view'));
CREATE POLICY vehicles_update_by_permission ON vehicles FOR UPDATE
  USING (app.can('drivers.approve')) WITH CHECK (app.can('drivers.approve'));

-- Trips.
CREATE POLICY trips_select_by_permission ON trips FOR SELECT
  USING (app.can('trips.view') OR app.can('trips.cancel'));
CREATE POLICY trips_update_by_permission ON trips FOR UPDATE
  USING (app.can('trips.cancel')) WITH CHECK (app.can('trips.cancel'));
CREATE POLICY trip_offers_select_by_permission ON trip_offers FOR SELECT
  USING (app.can('trips.view'));
CREATE POLICY trip_events_select_by_permission ON trip_events FOR SELECT
  USING (app.can('trips.view'));
CREATE POLICY trip_events_insert_by_permission ON trip_events FOR INSERT
  WITH CHECK (app.can('trips.cancel') AND actor_id = app.uid());
CREATE POLICY ratings_select_by_permission ON ratings FOR SELECT
  USING (app.can('trips.view'));

-- Money.
CREATE POLICY wallets_select_by_permission ON wallets FOR SELECT
  USING (app.can('finance.wallets.view') OR app.can('finance.wallets.adjust'));
CREATE POLICY wallets_update_by_permission ON wallets FOR UPDATE
  USING (app.can('finance.wallets.adjust')) WITH CHECK (app.can('finance.wallets.adjust'));
CREATE POLICY wallet_transactions_select_by_permission ON wallet_transactions FOR SELECT
  USING (app.can('finance.wallets.view') OR app.can('finance.wallets.adjust'));
CREATE POLICY wallet_transactions_insert_by_permission ON wallet_transactions FOR INSERT
  WITH CHECK (app.can('finance.wallets.adjust') AND kind = 'adjustment' AND created_by = app.uid());
CREATE POLICY payments_select_by_permission ON payments FOR SELECT
  USING (app.can('finance.wallets.view'));

-- Configuration.
CREATE POLICY vehicle_categories_write_by_permission ON vehicle_categories FOR UPDATE
  USING (app.can('pricing.manage')) WITH CHECK (app.can('pricing.manage'));
CREATE POLICY vehicle_categories_insert_by_permission ON vehicle_categories FOR INSERT
  WITH CHECK (app.can('pricing.manage'));
CREATE POLICY service_zones_update_by_permission ON service_zones FOR UPDATE
  USING (app.can('zones.manage')) WITH CHECK (app.can('zones.manage'));
CREATE POLICY service_zones_insert_by_permission ON service_zones FOR INSERT
  WITH CHECK (app.can('zones.manage'));

-- Safety.
CREATE POLICY sos_alerts_select_by_permission ON sos_alerts FOR SELECT
  USING (app.can('sos.view') OR app.can('sos.manage'));
CREATE POLICY sos_alerts_update_by_permission ON sos_alerts FOR UPDATE
  USING (app.can('sos.manage')) WITH CHECK (app.can('sos.manage'));

-- Audit: anyone acting as staff records their own actions; reading needs audit.view.
CREATE POLICY audit_logs_select_by_permission ON audit_logs FOR SELECT
  USING (app.can('audit.view'));
CREATE POLICY audit_logs_insert_by_staff ON audit_logs FOR INSERT
  WITH CHECK (app.role() = 'staff' AND actor_id = app.uid());
