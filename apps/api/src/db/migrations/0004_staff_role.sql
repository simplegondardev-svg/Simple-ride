-- New account type for back-office employees with per-person permissions.
-- (Separate migration: a new enum value can't be used in the transaction
-- that adds it.)
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'staff';
