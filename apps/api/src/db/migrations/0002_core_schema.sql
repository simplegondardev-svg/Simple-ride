-- Core domain schema. Conventions:
--   * money is integer santim (1 ETB = 100 santim), never floats
--   * coordinates are geography(Point, 4326); PostGIS takes (lon, lat) order
--   * every table the API touches has RLS enabled in 0003_rls.sql

-- ───────────────────────── Identity ─────────────────────────

CREATE TYPE user_role AS ENUM ('customer', 'driver', 'admin');
CREATE TYPE user_status AS ENUM ('active', 'suspended', 'deleted');
CREATE TYPE client_platform AS ENUM ('web', 'android', 'ios');

-- One row per (phone, role): the same person can hold a customer account and
-- a driver account, mirroring the separate rider/driver apps.
CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone       text NOT NULL CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),  -- E.164
  role        user_role NOT NULL DEFAULT 'customer',
  status      user_status NOT NULL DEFAULT 'active',
  full_name   text,
  email       text,
  locale      text NOT NULL DEFAULT 'am' CHECK (locale IN ('am', 'en', 'om', 'ti')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (phone, role)
);
CREATE TRIGGER users_touch BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Refresh-token sessions, one per device. Only a hash of the token is stored.
CREATE TABLE auth_sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash  text NOT NULL UNIQUE,
  platform            client_platform NOT NULL,
  device_id           text,
  user_agent          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_used_at        timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  revoked_at          timestamptz
);
CREATE INDEX auth_sessions_user_idx ON auth_sessions (user_id);

-- FCM tokens (Flutter apps and web push).
CREATE TABLE push_tokens (
  token       text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform    client_platform NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX push_tokens_user_idx ON push_tokens (user_id);

-- ───────────────────────── Fleet ─────────────────────────

CREATE TYPE approval_status AS ENUM ('pending', 'approved', 'rejected', 'suspended');
CREATE TYPE driver_availability AS ENUM ('offline', 'online', 'on_trip');

CREATE TABLE driver_profiles (
  user_id            uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  approval_status    approval_status NOT NULL DEFAULT 'pending',
  license_number     text,
  license_expires_on date,
  national_id        text,
  availability       driver_availability NOT NULL DEFAULT 'offline',
  -- Last persisted position. The live, high-frequency position lives in
  -- Redis (GEO set); this column is written on a throttle for analytics,
  -- dispute resolution and fallback search.
  last_location      geography(Point, 4326),
  last_location_at   timestamptz,
  rating_avg         numeric(3, 2) NOT NULL DEFAULT 5.00,
  rating_count       integer NOT NULL DEFAULT 0,
  approved_at        timestamptz,
  approved_by        uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX driver_profiles_location_idx ON driver_profiles USING gist (last_location);
CREATE TRIGGER driver_profiles_touch BEFORE UPDATE ON driver_profiles
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Ride products and their fare rules. Admin-managed.
CREATE TABLE vehicle_categories (
  code              text PRIMARY KEY CHECK (code ~ '^[a-z_]+$'),
  name              text NOT NULL,
  seats             smallint NOT NULL CHECK (seats > 0),
  base_fare         integer NOT NULL CHECK (base_fare >= 0),      -- santim
  per_km            integer NOT NULL CHECK (per_km >= 0),         -- santim
  per_minute        integer NOT NULL CHECK (per_minute >= 0),     -- santim
  minimum_fare      integer NOT NULL CHECK (minimum_fare >= 0),   -- santim
  booking_fee       integer NOT NULL DEFAULT 0 CHECK (booking_fee >= 0),
  commission_bps    integer NOT NULL CHECK (commission_bps BETWEEN 0 AND 10000),
  is_active         boolean NOT NULL DEFAULT true,
  sort_order        smallint NOT NULL DEFAULT 0,
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER vehicle_categories_touch BEFORE UPDATE ON vehicle_categories
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE vehicles (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category_code  text NOT NULL REFERENCES vehicle_categories(code),
  plate_number   text NOT NULL UNIQUE,
  make           text NOT NULL,
  model          text NOT NULL,
  color          text NOT NULL,
  year           smallint CHECK (year BETWEEN 1970 AND 2100),
  status         approval_status NOT NULL DEFAULT 'pending',
  is_current     boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vehicles_driver_idx ON vehicles (driver_id);
-- A driver drives one vehicle at a time.
CREATE UNIQUE INDEX vehicles_one_current_per_driver ON vehicles (driver_id) WHERE is_current;
CREATE TRIGGER vehicles_touch BEFORE UPDATE ON vehicles
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ───────────────────────── Geography ─────────────────────────

CREATE TYPE zone_kind AS ENUM ('operating', 'airport', 'restricted');

-- Polygons drawn by ops: where we operate, airport pickup rules, no-go areas.
CREATE TABLE service_zones (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  kind             zone_kind NOT NULL DEFAULT 'operating',
  area             geography(MultiPolygon, 4326) NOT NULL,
  fare_multiplier  numeric(4, 2) NOT NULL DEFAULT 1.00 CHECK (fare_multiplier > 0),
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX service_zones_area_idx ON service_zones USING gist (area);

CREATE TABLE saved_places (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label       text NOT NULL,
  address     text,
  location    geography(Point, 4326) NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX saved_places_user_idx ON saved_places (user_id);

-- ───────────────────────── Trips ─────────────────────────

CREATE TYPE trip_status AS ENUM (
  'searching',     -- created, dispatch looking for a driver
  'accepted',      -- driver assigned, heading to pickup
  'arrived',       -- driver at pickup, waiting
  'in_progress',   -- rider on board
  'completed',
  'cancelled',
  'expired'        -- no driver accepted in time
);
CREATE TYPE trip_actor AS ENUM ('customer', 'driver', 'admin', 'system');
CREATE TYPE payment_method AS ENUM ('cash', 'telebirr', 'wallet');
CREATE TYPE payment_status AS ENUM ('pending', 'paid', 'failed', 'refunded');

CREATE TABLE trips (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Client-generated idempotency key: a mobile app retrying on a flaky
  -- network gets the same trip back instead of booking twice.
  client_request_id  uuid NOT NULL,
  customer_id        uuid NOT NULL REFERENCES users(id),
  driver_id          uuid REFERENCES users(id),
  vehicle_id         uuid REFERENCES vehicles(id),
  category_code      text NOT NULL REFERENCES vehicle_categories(code),
  status             trip_status NOT NULL DEFAULT 'searching',

  pickup             geography(Point, 4326) NOT NULL,
  pickup_address     text,
  dropoff            geography(Point, 4326) NOT NULL,
  dropoff_address    text,
  planned_route      geography(LineString, 4326),
  est_distance_m     integer,
  est_duration_s     integer,

  fare_estimate      integer NOT NULL,   -- santim, locked at request time
  final_fare         integer,            -- santim
  currency           char(3) NOT NULL DEFAULT 'ETB',
  payment_method     payment_method NOT NULL DEFAULT 'cash',
  payment_status     payment_status NOT NULL DEFAULT 'pending',

  -- Rider tells the driver this code at pickup so they get in the right car.
  ride_pin           char(4) NOT NULL DEFAULT lpad((floor(random() * 10000))::int::text, 4, '0'),

  scheduled_for      timestamptz,
  requested_at       timestamptz NOT NULL DEFAULT now(),
  accepted_at        timestamptz,
  arrived_at         timestamptz,
  started_at         timestamptz,
  completed_at       timestamptz,
  cancelled_at       timestamptz,
  cancelled_by       trip_actor,
  cancel_reason      text,
  updated_at         timestamptz NOT NULL DEFAULT now(),

  UNIQUE (customer_id, client_request_id),
  CHECK (status IN ('searching', 'expired', 'cancelled') OR driver_id IS NOT NULL)
);
CREATE INDEX trips_customer_idx ON trips (customer_id, requested_at DESC);
CREATE INDEX trips_driver_idx ON trips (driver_id, requested_at DESC);
CREATE INDEX trips_status_idx ON trips (status) WHERE status IN ('searching', 'accepted', 'arrived', 'in_progress');
CREATE INDEX trips_pickup_idx ON trips USING gist (pickup);
-- At most one live trip per customer and per driver.
CREATE UNIQUE INDEX trips_one_active_per_customer ON trips (customer_id)
  WHERE status IN ('searching', 'accepted', 'arrived', 'in_progress');
CREATE UNIQUE INDEX trips_one_active_per_driver ON trips (driver_id)
  WHERE status IN ('accepted', 'arrived', 'in_progress');
CREATE TRIGGER trips_touch BEFORE UPDATE ON trips
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TYPE offer_status AS ENUM ('pending', 'accepted', 'declined', 'expired');

-- Dispatch offers a trip to drivers one at a time (or in small batches).
CREATE TABLE trip_offers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id       uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  driver_id     uuid NOT NULL REFERENCES users(id),
  status        offer_status NOT NULL DEFAULT 'pending',
  eta_s         integer,
  distance_m    integer,
  offered_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  responded_at  timestamptz,
  UNIQUE (trip_id, driver_id)
);
CREATE INDEX trip_offers_driver_idx ON trip_offers (driver_id, offered_at DESC);

-- Append-only timeline: state changes, route deviations, chat metadata, etc.
CREATE TABLE trip_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  trip_id     uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  actor_id    uuid REFERENCES users(id),
  event       text NOT NULL,
  data        jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX trip_events_trip_idx ON trip_events (trip_id, id);

CREATE TABLE ratings (
  trip_id     uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  rater_id    uuid NOT NULL REFERENCES users(id),
  ratee_id    uuid NOT NULL REFERENCES users(id),
  score       smallint NOT NULL CHECK (score BETWEEN 1 AND 5),
  comment     text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trip_id, rater_id)
);
CREATE INDEX ratings_ratee_idx ON ratings (ratee_id);

-- ───────────────────────── Money ─────────────────────────

-- Every user has a wallet. For drivers it is also the commission account:
-- on cash trips the driver collects the fare, and the platform commission is
-- debited here (prepaid-float model used by Ethiopian ride-hailing apps).
CREATE TABLE wallets (
  user_id     uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance     bigint NOT NULL DEFAULT 0,   -- santim
  currency    char(3) NOT NULL DEFAULT 'ETB',
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE wallet_txn_kind AS ENUM (
  'topup', 'trip_payment', 'trip_earning', 'commission', 'payout', 'refund', 'bonus', 'adjustment'
);

-- Immutable ledger. The wallet balance is a cache of SUM(amount).
CREATE TABLE wallet_transactions (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id        uuid NOT NULL REFERENCES wallets(user_id),
  amount         bigint NOT NULL CHECK (amount <> 0),   -- signed santim
  balance_after  bigint NOT NULL,
  kind           wallet_txn_kind NOT NULL,
  trip_id        uuid REFERENCES trips(id),
  reference      text,
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wallet_transactions_user_idx ON wallet_transactions (user_id, id DESC);

CREATE TABLE payments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id       uuid REFERENCES trips(id),
  payer_id      uuid NOT NULL REFERENCES users(id),
  method        payment_method NOT NULL,
  amount        bigint NOT NULL CHECK (amount > 0),
  status        payment_status NOT NULL DEFAULT 'pending',
  provider      text,            -- 'telebirr', 'chapa', ...
  provider_ref  text,
  raw           jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_ref)
);
CREATE INDEX payments_trip_idx ON payments (trip_id);
CREATE TRIGGER payments_touch BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ───────────────────────── Safety & audit ─────────────────────────

CREATE TYPE sos_status AS ENUM ('open', 'acknowledged', 'resolved');

CREATE TABLE sos_alerts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id      uuid REFERENCES trips(id),
  user_id      uuid NOT NULL REFERENCES users(id),
  location     geography(Point, 4326),
  status       sos_status NOT NULL DEFAULT 'open',
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz,
  resolved_by  uuid REFERENCES users(id)
);
CREATE INDEX sos_alerts_open_idx ON sos_alerts (created_at) WHERE status <> 'resolved';

CREATE TABLE audit_logs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id    uuid REFERENCES users(id),
  action      text NOT NULL,
  entity      text NOT NULL,
  entity_id   text,
  data        jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_entity_idx ON audit_logs (entity, entity_id);
