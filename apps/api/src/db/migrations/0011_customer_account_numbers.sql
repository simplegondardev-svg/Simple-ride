-- 0011_customer_account_numbers.sql
-- Human-readable unique customer account numbers (e.g. SR-100001).

CREATE SEQUENCE customer_account_number_seq START WITH 100001;

ALTER TABLE users ADD COLUMN account_number text;

-- Deterministically backfill existing customers in order of created_at ASC, id ASC.
-- CTE avoids invalid PostgreSQL 'UPDATE ... ORDER BY' syntax.
WITH numbered_customers AS (
  SELECT id,
         ROW_NUMBER() OVER (ORDER BY created_at ASC, id ASC) - 1 AS row_offset
    FROM users
   WHERE role = 'customer'
)
UPDATE users u
   SET account_number = 'SR-' || (100001 + numbered_customers.row_offset)::text
  FROM numbered_customers
 WHERE u.id = numbered_customers.id;

-- Align sequence state to the maximum allocated number so subsequent registrations
-- continue monotonically. If no customers exist, set to 100000 so nextval() yields 100001.
SELECT setval(
  'customer_account_number_seq',
  COALESCE((SELECT MAX(SUBSTRING(account_number FROM 4)::bigint) FROM users WHERE account_number IS NOT NULL), 100000)
);

-- Unique index on account_number among non-null values.
CREATE UNIQUE INDEX users_customer_account_number_idx ON users (account_number) WHERE account_number IS NOT NULL;

-- Role-based constraint:
-- Customers MUST have an account number matching SR-[0-9]{6,}.
-- Non-customers (driver, staff, admin) MUST have account_number IS NULL.
ALTER TABLE users ADD CONSTRAINT users_customer_account_number_check
  CHECK (
    (role = 'customer' AND account_number IS NOT NULL AND account_number ~ '^SR-[0-9]{6,}$')
    OR
    (role <> 'customer' AND account_number IS NULL)
  );

-- Keep account_number immutable for callers acting under app.guarded().
CREATE OR REPLACE FUNCTION app.guard_users() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF app.guarded() AND (
       NEW.role IS DISTINCT FROM OLD.role
    OR NEW.status IS DISTINCT FROM OLD.status
    OR NEW.phone IS DISTINCT FROM OLD.phone
    OR NEW.account_number IS DISTINCT FROM OLD.account_number) THEN
    RAISE EXCEPTION 'Cannot update protected user columns' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

-- Grant permissions for runtime user.
GRANT USAGE, SELECT ON SEQUENCE customer_account_number_seq TO simpleride_app;
