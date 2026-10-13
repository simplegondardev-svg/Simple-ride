-- Prepaid commission deposits get their own ledger entry type, so the day
-- book separates them from manual adjustments and rider top-ups.
-- Own migration: a new enum value can't be used in the transaction that adds it.
ALTER TYPE wallet_txn_kind ADD VALUE IF NOT EXISTS 'deposit';
