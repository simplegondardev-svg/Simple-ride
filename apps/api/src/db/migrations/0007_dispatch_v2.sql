-- CP2: dispatch by driving time, driver-cancel re-dispatch, overtime fares,
-- and admin-adjustable business settings.

-- ───────────────────────── Settings ─────────────────────────
-- Business rules the admin can change without a deploy. Values are JSON so
-- each setting keeps its natural type; the API validates every key it accepts.
CREATE TABLE app_settings (
  key         text PRIMARY KEY CHECK (key ~ '^[a-z_]+$'),
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid REFERENCES users(id)
);
CREATE TRIGGER app_settings_touch BEFORE UPDATE ON app_settings
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Longer-than-quoted trips pay extra minutes, capped at this share of the
-- quote (business decision Oct 2026: 25%).
INSERT INTO app_settings (key, value) VALUES ('overtime_cap_bps', '2500');

GRANT SELECT, UPDATE ON app_settings TO simpleride_app;
ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;
-- Settings are not secret, but only the back office and server code need them.
CREATE POLICY app_settings_select ON app_settings FOR SELECT
  USING (app.role() IN ('admin', 'staff', 'system'));
CREATE POLICY app_settings_update ON app_settings FOR UPDATE
  USING (app.can('pricing.manage')) WITH CHECK (app.can('pricing.manage'));

-- ───────────────────────── Trips ─────────────────────────
-- When the trip (re-)entered 'searching'. A trip the driver abandons goes
-- back to searching with a fresh window, instead of expiring at once
-- because it was requested long ago.
ALTER TABLE trips ADD COLUMN searching_since timestamptz NOT NULL DEFAULT now();
UPDATE trips SET searching_since = requested_at;

-- Extra charged at completion for minutes beyond the estimate (santim).
ALTER TABLE trips ADD COLUMN overtime_amount integer NOT NULL DEFAULT 0 CHECK (overtime_amount >= 0);

-- ───────────────────────── Trip guard (tightened) ─────────────────────────
-- Riders and drivers update their own trips through RLS. Besides parties,
-- money and route (as before, now including the commission and overtime
-- amounts and estimates), they may only make the status changes the trip
-- state machine allows them. Everything else is server code (system) or staff.
CREATE OR REPLACE FUNCTION app.guard_trips() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  is_customer boolean := NEW.customer_id = app.uid();
  allowed boolean;
BEGIN
  IF NOT app.guarded() THEN RETURN NEW; END IF;

  IF NEW.customer_id       IS DISTINCT FROM OLD.customer_id
  OR NEW.driver_id         IS DISTINCT FROM OLD.driver_id
  OR NEW.vehicle_id        IS DISTINCT FROM OLD.vehicle_id
  OR NEW.category_code     IS DISTINCT FROM OLD.category_code
  OR NEW.fare_estimate     IS DISTINCT FROM OLD.fare_estimate
  OR NEW.final_fare        IS DISTINCT FROM OLD.final_fare
  OR NEW.commission_amount IS DISTINCT FROM OLD.commission_amount
  OR NEW.overtime_amount   IS DISTINCT FROM OLD.overtime_amount
  OR NEW.payment_method    IS DISTINCT FROM OLD.payment_method
  OR NEW.payment_status    IS DISTINCT FROM OLD.payment_status
  OR NEW.ride_pin          IS DISTINCT FROM OLD.ride_pin
  OR NEW.est_distance_m    IS DISTINCT FROM OLD.est_distance_m
  OR NEW.est_duration_s    IS DISTINCT FROM OLD.est_duration_s
  OR NEW.searching_since   IS DISTINCT FROM OLD.searching_since
  OR NOT ST_Equals(NEW.pickup::geometry, OLD.pickup::geometry)
  OR NOT ST_Equals(NEW.dropoff::geometry, OLD.dropoff::geometry) THEN
    RAISE EXCEPTION 'only staff may change trip parties, fare or route' USING ERRCODE = '42501';
  END IF;

  -- Riders and staff (trips.cancel) may only cancel; drivers may also move
  -- their trip forward. Completion is settlement and runs as system.
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    allowed := CASE
      WHEN NEW.status = 'cancelled' THEN OLD.status IN ('searching', 'accepted', 'arrived')
      WHEN is_customer OR app.role() = 'staff' THEN false
      ELSE (OLD.status, NEW.status) IN (('accepted', 'arrived'), ('arrived', 'in_progress'))
    END;
    IF NOT allowed THEN
      RAISE EXCEPTION 'status change % → % not allowed', OLD.status, NEW.status USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;
