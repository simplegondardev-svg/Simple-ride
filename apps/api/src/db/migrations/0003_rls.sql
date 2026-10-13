-- Row level security.
--
-- Model: the API connects as `simpleride_app` (not the table owner, NOBYPASSRLS)
-- and sets app.user_id / app.role per transaction. Policies below are the
-- source of truth for who can see and change which rows; the API's own role
-- checks are a first line of defence, not the only one.
--
-- Tables are intentionally NOT `FORCE ROW LEVEL SECURITY`: the owner role is
-- used only by migrations/seeds, and the SECURITY DEFINER helpers below rely
-- on running as the owner to look across tables without recursing into the
-- policies of the table they are called from.

-- ───────────────────────── Helpers (SECURITY DEFINER) ─────────────────────────

-- Is the current user the customer or driver on this trip?
CREATE FUNCTION app.is_trip_party(p_trip_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM trips
      WHERE id = p_trip_id AND app.uid() IN (customer_id, driver_id)
    )
  $$;

-- Have the current user and `other` been on a trip together (as rider and
-- driver)? Lets a rider see their driver's name/rating and vice versa.
CREATE FUNCTION app.shares_trip_with(p_other uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM trips
      WHERE (customer_id = app.uid() AND driver_id = p_other)
         OR (driver_id = app.uid() AND customer_id = p_other)
    )
  $$;

-- Is this vehicle on one of the current user's trips (rider needs the plate)?
CREATE FUNCTION app.vehicle_on_my_trip(p_vehicle_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM trips
      WHERE vehicle_id = p_vehicle_id AND customer_id = app.uid()
    )
  $$;

-- Has the current driver been offered this trip? Lets them read the pickup
-- details before accepting.
CREATE FUNCTION app.has_offer_for(p_trip_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM trip_offers
      WHERE trip_id = p_trip_id AND driver_id = app.uid()
    )
  $$;

-- Can the current user rate `p_ratee` for this trip? Completed trips only,
-- and only the counter-party.
CREATE FUNCTION app.can_rate(p_trip_id uuid, p_ratee uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM trips
      WHERE id = p_trip_id AND status = 'completed'
        AND ((customer_id = app.uid() AND driver_id = p_ratee)
          OR (driver_id = app.uid() AND customer_id = p_ratee))
    )
  $$;

REVOKE ALL ON FUNCTION app.is_trip_party(uuid), app.shares_trip_with(uuid),
  app.vehicle_on_my_trip(uuid), app.has_offer_for(uuid), app.can_rate(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.uid(), app.role(), app.is_admin(), app.is_staff(),
  app.is_trip_party(uuid), app.shares_trip_with(uuid), app.vehicle_on_my_trip(uuid),
  app.has_offer_for(uuid), app.can_rate(uuid, uuid) TO simpleride_app;

-- ───────────────────────── Column guards ─────────────────────────
-- Policies decide which ROWS you may update; these triggers stop non-staff
-- from changing privileged COLUMNS on rows they otherwise own.
-- Like RLS, they only bind the runtime role: the owner (migrations, seeds,
-- ops scripts) is not restricted.
CREATE FUNCTION app.guarded() RETURNS boolean
  LANGUAGE sql STABLE
  AS $$ SELECT current_user = 'simpleride_app' AND NOT app.is_staff() $$;
GRANT EXECUTE ON FUNCTION app.guarded() TO simpleride_app;

CREATE FUNCTION app.guard_users() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF app.guarded() AND (
       NEW.role IS DISTINCT FROM OLD.role
    OR NEW.status IS DISTINCT FROM OLD.status
    OR NEW.phone IS DISTINCT FROM OLD.phone) THEN
    RAISE EXCEPTION 'only staff may change role, status or phone' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER users_guard BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION app.guard_users();

CREATE FUNCTION app.guard_driver_profiles() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF app.guarded() AND (
       (TG_OP = 'INSERT' AND NEW.approval_status <> 'pending')
    OR (TG_OP = 'UPDATE' AND (
          NEW.approval_status IS DISTINCT FROM OLD.approval_status
       OR NEW.rating_avg IS DISTINCT FROM OLD.rating_avg
       OR NEW.rating_count IS DISTINCT FROM OLD.rating_count
       OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
       OR NEW.approved_by IS DISTINCT FROM OLD.approved_by))) THEN
    RAISE EXCEPTION 'only staff may change approval or rating fields' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER driver_profiles_guard BEFORE INSERT OR UPDATE ON driver_profiles
  FOR EACH ROW EXECUTE FUNCTION app.guard_driver_profiles();

CREATE FUNCTION app.guard_vehicles() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF app.guarded() AND (
       (TG_OP = 'INSERT' AND NEW.status <> 'pending')
    OR (TG_OP = 'UPDATE' AND (
          NEW.status IS DISTINCT FROM OLD.status
       OR NEW.plate_number IS DISTINCT FROM OLD.plate_number
       OR NEW.category_code IS DISTINCT FROM OLD.category_code))) THEN
    RAISE EXCEPTION 'only staff may change vehicle status, plate or category' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER vehicles_guard BEFORE INSERT OR UPDATE ON vehicles
  FOR EACH ROW EXECUTE FUNCTION app.guard_vehicles();

-- Riders and drivers may move a trip through its lifecycle (the API enforces
-- the state machine), but money, parties and geometry are set by the server.
CREATE FUNCTION app.guard_trips() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF app.guarded() AND (
       NEW.customer_id    IS DISTINCT FROM OLD.customer_id
    OR NEW.driver_id      IS DISTINCT FROM OLD.driver_id
    OR NEW.vehicle_id     IS DISTINCT FROM OLD.vehicle_id
    OR NEW.category_code  IS DISTINCT FROM OLD.category_code
    OR NEW.fare_estimate  IS DISTINCT FROM OLD.fare_estimate
    OR NEW.final_fare     IS DISTINCT FROM OLD.final_fare
    OR NEW.payment_status IS DISTINCT FROM OLD.payment_status
    OR NEW.ride_pin       IS DISTINCT FROM OLD.ride_pin
    OR NOT ST_Equals(NEW.pickup::geometry, OLD.pickup::geometry)
    OR NOT ST_Equals(NEW.dropoff::geometry, OLD.dropoff::geometry)) THEN
    RAISE EXCEPTION 'only staff may change trip parties, fare or route' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trips_guard BEFORE UPDATE ON trips
  FOR EACH ROW EXECUTE FUNCTION app.guard_trips();

CREATE FUNCTION app.guard_trip_offers() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF app.guarded() AND (
       NEW.trip_id    IS DISTINCT FROM OLD.trip_id
    OR NEW.driver_id  IS DISTINCT FROM OLD.driver_id
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.status = 'accepted') THEN   -- acceptance goes through the dispatcher
    RAISE EXCEPTION 'drivers may only decline offers directly' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trip_offers_guard BEFORE UPDATE ON trip_offers
  FOR EACH ROW EXECUTE FUNCTION app.guard_trip_offers();

-- ───────────────────────── Grants ─────────────────────────
-- Table privileges are the outer gate; policies filter rows within them.
-- No DELETE except where users legitimately remove their own data.

GRANT SELECT, INSERT, UPDATE ON
  users, auth_sessions, driver_profiles, vehicles, vehicle_categories,
  service_zones, trips, trip_offers, ratings, wallets, payments, sos_alerts
  TO simpleride_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON push_tokens, saved_places TO simpleride_app;
GRANT SELECT, INSERT ON trip_events, wallet_transactions, audit_logs TO simpleride_app;

-- ───────────────────────── Policies ─────────────────────────

ALTER TABLE users               ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_sessions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_tokens         ENABLE ROW LEVEL SECURITY;
ALTER TABLE driver_profiles     ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicle_categories  ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicles            ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_zones       ENABLE ROW LEVEL SECURITY;
ALTER TABLE saved_places        ENABLE ROW LEVEL SECURITY;
ALTER TABLE trips               ENABLE ROW LEVEL SECURITY;
ALTER TABLE trip_offers         ENABLE ROW LEVEL SECURITY;
ALTER TABLE trip_events         ENABLE ROW LEVEL SECURITY;
ALTER TABLE ratings             ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallets             ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments            ENABLE ROW LEVEL SECURITY;
ALTER TABLE sos_alerts          ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs          ENABLE ROW LEVEL SECURITY;

-- users: yourself, people you've shared a trip with, staff. Accounts are
-- created by the server during OTP verification (system context).
CREATE POLICY users_select ON users FOR SELECT
  USING (id = app.uid() OR app.is_staff() OR app.shares_trip_with(id));
CREATE POLICY users_insert ON users FOR INSERT
  WITH CHECK (app.is_staff());
CREATE POLICY users_update ON users FOR UPDATE
  USING (id = app.uid() OR app.is_staff())
  WITH CHECK (id = app.uid() OR app.is_staff());

CREATE POLICY auth_sessions_all ON auth_sessions FOR ALL
  USING (user_id = app.uid() OR app.is_staff())
  WITH CHECK (user_id = app.uid() OR app.is_staff());

CREATE POLICY push_tokens_all ON push_tokens FOR ALL
  USING (user_id = app.uid() OR app.is_staff())
  WITH CHECK (user_id = app.uid() OR app.is_staff());

-- driver_profiles: the driver, their riders, staff.
CREATE POLICY driver_profiles_select ON driver_profiles FOR SELECT
  USING (user_id = app.uid() OR app.is_staff() OR app.shares_trip_with(user_id));
CREATE POLICY driver_profiles_insert ON driver_profiles FOR INSERT
  WITH CHECK ((user_id = app.uid() AND app.role() = 'driver') OR app.is_staff());
CREATE POLICY driver_profiles_update ON driver_profiles FOR UPDATE
  USING (user_id = app.uid() OR app.is_staff())
  WITH CHECK (user_id = app.uid() OR app.is_staff());

-- vehicle_categories / service_zones: public reference data, admin-managed.
CREATE POLICY vehicle_categories_select ON vehicle_categories FOR SELECT USING (true);
CREATE POLICY vehicle_categories_write ON vehicle_categories FOR ALL
  USING (app.is_admin()) WITH CHECK (app.is_admin());

CREATE POLICY service_zones_select ON service_zones FOR SELECT USING (true);
CREATE POLICY service_zones_write ON service_zones FOR ALL
  USING (app.is_admin()) WITH CHECK (app.is_admin());

-- vehicles: the owning driver, riders of that vehicle, staff.
CREATE POLICY vehicles_select ON vehicles FOR SELECT
  USING (driver_id = app.uid() OR app.is_staff() OR app.vehicle_on_my_trip(id));
CREATE POLICY vehicles_insert ON vehicles FOR INSERT
  WITH CHECK ((driver_id = app.uid() AND app.role() = 'driver') OR app.is_staff());
CREATE POLICY vehicles_update ON vehicles FOR UPDATE
  USING (driver_id = app.uid() OR app.is_staff())
  WITH CHECK (driver_id = app.uid() OR app.is_staff());

CREATE POLICY saved_places_all ON saved_places FOR ALL
  USING (user_id = app.uid() OR app.is_staff())
  WITH CHECK (user_id = app.uid() OR app.is_staff());

-- trips: rider, assigned driver, drivers holding an offer, staff.
-- Customers create their own trips. Assignment (driver_id) is done by the
-- dispatcher in system context, so a driver can never self-assign.
CREATE POLICY trips_select ON trips FOR SELECT
  USING (customer_id = app.uid() OR driver_id = app.uid() OR app.is_staff()
         OR (app.role() = 'driver' AND app.has_offer_for(id)));
CREATE POLICY trips_insert ON trips FOR INSERT
  WITH CHECK ((customer_id = app.uid() AND app.role() = 'customer' AND driver_id IS NULL)
              OR app.is_staff());
CREATE POLICY trips_update ON trips FOR UPDATE
  USING (customer_id = app.uid() OR driver_id = app.uid() OR app.is_staff())
  WITH CHECK (customer_id = app.uid() OR driver_id = app.uid() OR app.is_staff());

CREATE POLICY trip_offers_select ON trip_offers FOR SELECT
  USING (driver_id = app.uid() OR app.is_staff());
CREATE POLICY trip_offers_insert ON trip_offers FOR INSERT
  WITH CHECK (app.is_staff());
CREATE POLICY trip_offers_update ON trip_offers FOR UPDATE
  USING (driver_id = app.uid() OR app.is_staff())
  WITH CHECK (driver_id = app.uid() OR app.is_staff());

CREATE POLICY trip_events_select ON trip_events FOR SELECT
  USING (app.is_staff() OR app.is_trip_party(trip_id));
CREATE POLICY trip_events_insert ON trip_events FOR INSERT
  WITH CHECK (app.is_staff() OR (app.is_trip_party(trip_id) AND actor_id = app.uid()));

CREATE POLICY ratings_select ON ratings FOR SELECT
  USING (rater_id = app.uid() OR ratee_id = app.uid() OR app.is_staff());
CREATE POLICY ratings_insert ON ratings FOR INSERT
  WITH CHECK ((rater_id = app.uid() AND app.can_rate(trip_id, ratee_id)) OR app.is_staff());

-- Money: read your own, only server code (system) or admins move it.
CREATE POLICY wallets_select ON wallets FOR SELECT
  USING (user_id = app.uid() OR app.is_staff());
CREATE POLICY wallets_write ON wallets FOR ALL
  USING (app.is_staff()) WITH CHECK (app.is_staff());

CREATE POLICY wallet_transactions_select ON wallet_transactions FOR SELECT
  USING (user_id = app.uid() OR app.is_staff());
CREATE POLICY wallet_transactions_insert ON wallet_transactions FOR INSERT
  WITH CHECK (app.is_staff());

CREATE POLICY payments_select ON payments FOR SELECT
  USING (payer_id = app.uid() OR app.is_staff()
         OR (trip_id IS NOT NULL AND app.is_trip_party(trip_id)));
CREATE POLICY payments_write ON payments FOR ALL
  USING (app.is_staff()) WITH CHECK (app.is_staff());

-- SOS: anyone can raise one for themselves (optionally tied to their trip);
-- only staff acknowledge/resolve.
CREATE POLICY sos_alerts_select ON sos_alerts FOR SELECT
  USING (user_id = app.uid() OR app.is_staff());
CREATE POLICY sos_alerts_insert ON sos_alerts FOR INSERT
  WITH CHECK ((user_id = app.uid() AND (trip_id IS NULL OR app.is_trip_party(trip_id)))
              OR app.is_staff());
CREATE POLICY sos_alerts_update ON sos_alerts FOR UPDATE
  USING (app.is_staff()) WITH CHECK (app.is_staff());

CREATE POLICY audit_logs_select ON audit_logs FOR SELECT USING (app.is_admin());
CREATE POLICY audit_logs_insert ON audit_logs FOR INSERT WITH CHECK (app.is_staff());
