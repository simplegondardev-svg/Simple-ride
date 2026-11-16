-- 0012_wallet_ledger_hardening.sql
-- Financial ledger hardening: dedicated idempotency key and partial unique index.

-- 1. Add dedicated idempotency_key column to wallet_transactions
ALTER TABLE wallet_transactions
  ADD COLUMN IF NOT EXISTS idempotency_key text;

COMMENT ON COLUMN wallet_transactions.idempotency_key IS
  'Deterministic unique key preventing duplicate transactions and enabling safe retries';

-- 2. Enforce database-level uniqueness across non-null idempotency keys
CREATE UNIQUE INDEX IF NOT EXISTS wallet_transactions_idempotency_key_idx
  ON wallet_transactions (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- 3. Explicit permissions for runtime application user
GRANT SELECT, INSERT ON wallet_transactions TO simpleride_app;
