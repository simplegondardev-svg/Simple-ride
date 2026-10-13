-- An offer the driver never got to answer because the trip went elsewhere
-- (another driver accepted, the rider cancelled). Unlike 'declined' and
-- 'expired' (timed out), it doesn't count against the driver's acceptance
-- rate and the driver may be offered the same trip again later, e.g. after
-- the accepting driver backs out. Own migration: a new enum value can't be
-- used in the transaction that adds it.
ALTER TYPE offer_status ADD VALUE IF NOT EXISTS 'withdrawn';
