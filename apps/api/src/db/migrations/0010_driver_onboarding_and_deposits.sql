-- CP5: driver documents, prepaid commission deposits, per-driver commission,
-- deposit refunds, and the business settings that drive them.

-- ───────────────────────── Settings ─────────────────────────
-- Business decisions (Oct 2026); all admin-adjustable. Money in santim.
INSERT INTO app_settings (key, value) VALUES
  ('default_commission_bps', '1000'),       -- 10% for drivers without a custom rate
  ('min_deposit', '1000000'),               -- 10,000 ETB: smallest accepted deposit
  ('low_balance_threshold', '20000'),       -- 200 ETB: below this, no going online / no offers
  ('low_balance_warning', '100000'),        -- 1,000 ETB: warn the driver to top up
  ('refund_after_days', '90');              -- deposit refundable 3 months after approval

-- Commission now comes from the setting above or the driver's own rate; the
-- per-category column stays for history but is no longer used.
COMMENT ON COLUMN vehicle_categories.commission_bps IS
  'Unused since CP5: commission = driver_profiles.commission_bps or app_settings.default_commission_bps';

-- ───────────────────────── Per-driver commission ─────────────────────────
ALTER TABLE driver_profiles
  ADD COLUMN commission_bps integer CHECK (commission_bps BETWEEN 0 AND 10000);
COMMENT ON COLUMN driver_profiles.commission_bps IS 'Custom commission set by admin; NULL = default';

-- Why the driver was last suspended (e.g. an expired document), shown in the back office.
ALTER TABLE driver_profiles ADD COLUMN suspended_reason text;

-- ───────────────────────── Permissions ─────────────────────────
INSERT INTO permissions (code, category, description, sort_order) VALUES
  ('drivers.commission',       'Driver onboarding', 'Set a driver''s custom commission rate', 22),
  ('finance.deposits.record',  'Finance',           'Record driver deposits received at the office', 43),
  ('finance.refunds.manage',   'Finance',           'Approve or reject deposit refund requests and record payouts', 44);

-- ───────────────────────── Documents ─────────────────────────
CREATE TYPE document_type AS ENUM (
  'license',            -- driving licence
  'photo',              -- driver's face photo
  'national_id',        -- kebele / national ID
  'vehicle_libre',      -- vehicle ownership booklet ("libre")
  'vehicle_insurance',
  'vehicle_bolo'        -- annual roadworthiness inspection ("bolo")
);
CREATE TYPE document_status AS ENUM ('uploading', 'pending', 'approved', 'rejected', 'expired', 'replaced');

CREATE TABLE driver_documents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vehicle_id     uuid REFERENCES vehicles(id) ON DELETE CASCADE,
  doc_type       document_type NOT NULL,
  status         document_status NOT NULL DEFAULT 'uploading',
  storage_key    text NOT NULL UNIQUE,
  content_type   text NOT NULL,
  size_bytes     integer NOT NULL CHECK (size_bytes > 0),
  expires_on     date,
  reject_reason  text,
  uploaded_at    timestamptz NOT NULL DEFAULT now(),
  submitted_at   timestamptz,
  reviewed_at    timestamptz,
  reviewed_by    uuid REFERENCES users(id),
  -- Vehicle documents belong to a vehicle; personal documents don't.
  CHECK ((doc_type::text LIKE 'vehicle_%') = (vehicle_id IS NOT NULL))
);
CREATE INDEX driver_documents_driver_idx ON driver_documents (driver_id, doc_type);
CREATE INDEX driver_documents_expiry_idx ON driver_documents (expires_on) WHERE status = 'approved';

-- Drivers upload and submit; only reviewers approve, reject or change expiry after submission.
CREATE FUNCTION app.guard_driver_documents() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT app.guarded() OR app.can('drivers.approve') THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'uploading' OR NEW.reviewed_by IS NOT NULL THEN
      RAISE EXCEPTION 'new documents start as uploading' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT (OLD.status = 'uploading' AND NEW.status IN ('uploading', 'pending'))
     OR NEW.driver_id IS DISTINCT FROM OLD.driver_id
     OR NEW.vehicle_id IS DISTINCT FROM OLD.vehicle_id
     OR NEW.doc_type IS DISTINCT FROM OLD.doc_type
     OR NEW.storage_key IS DISTINCT FROM OLD.storage_key
     OR NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by
     OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at
     OR NEW.reject_reason IS DISTINCT FROM OLD.reject_reason THEN
    RAISE EXCEPTION 'drivers may only submit their own uploaded documents' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER driver_documents_guard BEFORE INSERT OR UPDATE ON driver_documents
  FOR EACH ROW EXECUTE FUNCTION app.guard_driver_documents();

GRANT SELECT, INSERT, UPDATE ON driver_documents TO simpleride_app;
ALTER TABLE driver_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY driver_documents_select ON driver_documents FOR SELECT
  USING (driver_id = app.uid() OR app.can('drivers.view') OR app.can('drivers.approve'));
CREATE POLICY driver_documents_insert ON driver_documents FOR INSERT
  WITH CHECK ((driver_id = app.uid() AND app.role() = 'driver') OR app.is_staff());
CREATE POLICY driver_documents_update ON driver_documents FOR UPDATE
  USING (driver_id = app.uid() OR app.can('drivers.approve'))
  WITH CHECK (driver_id = app.uid() OR app.can('drivers.approve'));

-- ───────────────────────── Refund requests ─────────────────────────
CREATE TYPE refund_status AS ENUM ('pending', 'paid', 'rejected', 'cancelled');

CREATE TABLE deposit_refunds (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id      uuid NOT NULL REFERENCES users(id),
  status         refund_status NOT NULL DEFAULT 'pending',
  requested_at   timestamptz NOT NULL DEFAULT now(),
  note           text,                       -- driver's note (e.g. bank account)
  amount         bigint CHECK (amount > 0),  -- santim, set when paid
  reference      text,                       -- payout reference (bank/telebirr/cash receipt)
  reject_reason  text,
  decided_at     timestamptz,
  decided_by     uuid REFERENCES users(id)
);
CREATE UNIQUE INDEX deposit_refunds_one_open ON deposit_refunds (driver_id) WHERE status = 'pending';

CREATE FUNCTION app.guard_deposit_refunds() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT app.guarded() OR app.can('finance.refunds.manage') THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' AND (NEW.status <> 'pending' OR NEW.amount IS NOT NULL OR NEW.decided_by IS NOT NULL) THEN
    RAISE EXCEPTION 'refund requests start as pending' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'UPDATE' AND NOT (OLD.status = 'pending' AND NEW.status = 'cancelled'
       AND NEW.amount IS NOT DISTINCT FROM OLD.amount AND NEW.decided_by IS NOT DISTINCT FROM OLD.decided_by) THEN
    RAISE EXCEPTION 'drivers may only cancel their pending request' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER deposit_refunds_guard BEFORE INSERT OR UPDATE ON deposit_refunds
  FOR EACH ROW EXECUTE FUNCTION app.guard_deposit_refunds();

GRANT SELECT, INSERT, UPDATE ON deposit_refunds TO simpleride_app;
ALTER TABLE deposit_refunds ENABLE ROW LEVEL SECURITY;
CREATE POLICY deposit_refunds_select ON deposit_refunds FOR SELECT
  USING (driver_id = app.uid() OR app.can('finance.refunds.manage'));
CREATE POLICY deposit_refunds_insert ON deposit_refunds FOR INSERT
  WITH CHECK (driver_id = app.uid() AND app.role() = 'driver');
CREATE POLICY deposit_refunds_update ON deposit_refunds FOR UPDATE
  USING (driver_id = app.uid() OR app.can('finance.refunds.manage'))
  WITH CHECK (driver_id = app.uid() OR app.can('finance.refunds.manage'));

-- ───────────────────────── Visibility for the new permissions ─────────────────────────
-- Finance staff recording deposits or paying refunds need to find the driver and see the wallet.
CREATE OR REPLACE FUNCTION app.can_see_people() RETURNS boolean
  LANGUAGE sql STABLE
  AS $$
    SELECT app.can('users.view') OR app.can('users.suspend') OR app.can('users.reset_password')
        OR app.can('trips.view')
        OR app.can('finance.daybook.view') OR app.can('finance.wallets.view')
        OR app.can('finance.deposits.record') OR app.can('finance.refunds.manage')
        OR app.can('sos.view') OR app.can('sos.manage')
  $$;
CREATE POLICY wallets_select_finance ON wallets FOR SELECT
  USING (app.can('finance.deposits.record') OR app.can('finance.refunds.manage'));
CREATE POLICY driver_profiles_select_finance ON driver_profiles FOR SELECT
  USING (app.can('finance.deposits.record') OR app.can('finance.refunds.manage') OR app.can('drivers.commission'));
CREATE POLICY driver_profiles_update_commission ON driver_profiles FOR UPDATE
  USING (app.can('drivers.commission')) WITH CHECK (app.can('drivers.commission'));

-- ───────────────────────── Driver profile guard (adds commission, suspension) ─────────────────────────
CREATE OR REPLACE FUNCTION app.guard_driver_profiles() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF app.guarded() AND (
       (TG_OP = 'INSERT' AND (NEW.approval_status <> 'pending' OR NEW.commission_bps IS NOT NULL))
    OR (TG_OP = 'UPDATE' AND (
          NEW.rating_avg IS DISTINCT FROM OLD.rating_avg
       OR NEW.rating_count IS DISTINCT FROM OLD.rating_count
       OR (NEW.commission_bps IS DISTINCT FROM OLD.commission_bps AND NOT app.can('drivers.commission'))
       OR ((NEW.approval_status IS DISTINCT FROM OLD.approval_status
            OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
            OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
            OR NEW.suspended_reason IS DISTINCT FROM OLD.suspended_reason)
           AND NOT app.can('drivers.approve'))))) THEN
    RAISE EXCEPTION 'not allowed to change approval, commission or rating fields' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

-- ───────────────────────── Dashboard ─────────────────────────
CREATE OR REPLACE FUNCTION app.dashboard_stats() RETURNS json
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
BEGIN
  IF NOT app.can('dashboard.view') THEN
    RAISE EXCEPTION 'missing permission dashboard.view' USING ERRCODE = '42501';
  END IF;
  RETURN json_build_object(
    'customers',         (SELECT count(*) FROM users WHERE role = 'customer'),
    'drivers',           (SELECT count(*) FROM users WHERE role = 'driver'),
    'pendingDrivers',    (SELECT count(*) FROM driver_profiles WHERE approval_status = 'pending'),
    'driversOnline',     (SELECT count(*) FROM driver_profiles WHERE availability <> 'offline'),
    'activeTrips',       (SELECT count(*) FROM trips WHERE status IN ('searching','accepted','arrived','in_progress')),
    'tripsToday',        (SELECT count(*) FROM trips WHERE status = 'completed' AND completed_at > now() - interval '1 day'),
    'openSos',           (SELECT count(*) FROM sos_alerts WHERE status <> 'resolved'),
    'documentsToReview', (SELECT count(*) FROM driver_documents WHERE status = 'pending'),
    'documentsExpiring', (SELECT count(*) FROM driver_documents WHERE status = 'approved'
                            AND expires_on < current_date + 30),
    'pendingRefunds',    (SELECT count(*) FROM deposit_refunds WHERE status = 'pending'));
END $$;

-- Drivers need the deposit rules (minimum deposit, threshold) to see their own
-- status; none of the settings are secret. Writes stay with pricing.manage.
DROP POLICY app_settings_select ON app_settings;
CREATE POLICY app_settings_select ON app_settings FOR SELECT
  USING (app.role() <> 'anonymous');
