import type { PoolClient } from "pg";
import { AppError } from "../../lib/errors.js";

export const VALID_WALLET_TXN_KINDS = [
  "topup",
  "deposit",
  "trip_payment",
  "trip_earning",
  "commission",
  "payout",
  "refund",
  "bonus",
  "adjustment",
] as const;

export type WalletTxnKind = (typeof VALID_WALLET_TXN_KINDS)[number];

export interface LedgerEntry {
  userId: string;
  amount: number; // signed santim
  kind: WalletTxnKind;
  tripId?: string | null;
  reference?: string | null;
  createdBy?: string | null;
  idempotencyKey?: string | null;
}

let hasIdempotencyKeyColumnCache: boolean | null = null;

export async function checkIdempotencySupport(db: PoolClient): Promise<boolean> {
  if (hasIdempotencyKeyColumnCache !== null) return hasIdempotencyKeyColumnCache;
  try {
    const { rows } = await db.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'wallet_transactions' AND column_name = 'idempotency_key'`,
    );
    hasIdempotencyKeyColumnCache = rows.length > 0;
  } catch {
    hasIdempotencyKeyColumnCache = false;
  }
  return hasIdempotencyKeyColumnCache;
}

/** Reset idempotency column cache (primarily used in test suites). */
export function _resetIdempotencySupportCache(): void {
  hasIdempotencyKeyColumnCache = null;
}

/** Explicitly override idempotency column support for testing. */
export function _setIdempotencySupportForTest(enabled: boolean | null): void {
  hasIdempotencyKeyColumnCache = enabled;
}

/**
 * Validate monetary amount and parameters before touching the database.
 */
export function validateLedgerEntry(entry: LedgerEntry): void {
  if (!entry.userId || typeof entry.userId !== "string" || entry.userId.trim() === "") {
    throw new AppError(400, "INVALID_USER_ID", "Wallet user ID is required");
  }

  if (!entry.kind || !VALID_WALLET_TXN_KINDS.includes(entry.kind)) {
    throw new AppError(
      400,
      "INVALID_TRANSACTION_KIND",
      `Invalid wallet transaction kind: ${entry.kind}`,
      { kind: entry.kind },
    );
  }

  const { amount } = entry;
  if (
    typeof amount !== "number" ||
    !Number.isFinite(amount) ||
    Number.isNaN(amount) ||
    !Number.isSafeInteger(amount) ||
    amount === 0 ||
    Object.is(amount, -0)
  ) {
    throw new AppError(
      400,
      "INVALID_AMOUNT",
      "Transaction amount must be a non-zero safe integer santim value",
      { amount },
    );
  }

  if (entry.idempotencyKey !== undefined && entry.idempotencyKey !== null) {
    if (typeof entry.idempotencyKey !== "string" || entry.idempotencyKey.trim() === "") {
      throw new AppError(
        400,
        "INVALID_IDEMPOTENCY_KEY",
        "Idempotency key must be a non-empty string when provided",
        { idempotencyKey: entry.idempotencyKey },
      );
    }
  }
}

interface PersistedTx {
  id?: string;
  user_id: string;
  amount: string;
  balance_after: string;
  kind: string;
  trip_id: string | null;
  reference: string | null;
  created_by: string | null;
}

function isIdempotentMatch(existing: PersistedTx, entry: LedgerEntry): boolean {
  const existingAmount = Number(existing.amount);
  const entryTripId = entry.tripId ?? null;
  const existingTripId = existing.trip_id ?? null;
  const entryReference = entry.reference ?? null;
  const existingReference = existing.reference ?? null;
  const entryCreatedBy = entry.createdBy ?? null;
  const existingCreatedBy = existing.created_by ?? null;

  return (
    existing.user_id === entry.userId &&
    existingAmount === entry.amount &&
    existing.kind === entry.kind &&
    existingTripId === entryTripId &&
    existingReference === entryReference &&
    existingCreatedBy === entryCreatedBy
  );
}

function throwIdempotencyConflict(existing: PersistedTx, entry: LedgerEntry): never {
  throw new AppError(
    409,
    "IDEMPOTENCY_CONFLICT",
    "Idempotency key has already been used with different parameters",
    {
      idempotencyKey: entry.idempotencyKey,
      existing: {
        userId: existing.user_id,
        amount: Number(existing.amount),
        kind: existing.kind,
        tripId: existing.trip_id,
        reference: existing.reference,
        createdBy: existing.created_by,
      },
      attempted: {
        userId: entry.userId,
        amount: entry.amount,
        kind: entry.kind,
        tripId: entry.tripId ?? null,
        reference: entry.reference ?? null,
        createdBy: entry.createdBy ?? null,
      },
    },
  );
}

let savepointSeq = 0;

/**
 * Post one entry to the immutable wallet ledger and update the cached
 * balance atomically.
 *
 * Guarantees:
 * 1. Strict pre-validation of amount, kind, and user ID.
 * 2. Atomic non-negative balance protection for customers; concurrent debits
 *    cannot spend the same balance twice.
 * 3. Driver float compatibility: drivers may have negative balances for cash trip commission.
 * 4. Idempotency: retries with identical parameters return the existing balance safely;
 *    retries with conflicting parameters throw 409 IDEMPOTENCY_CONFLICT.
 * 5. Atomicity: operates within caller's transaction; failure rolls back both balance and ledger.
 */
export async function postLedger(
  db: PoolClient,
  entry: LedgerEntry,
): Promise<number> {
  validateLedgerEntry(entry);

  const hasIdempotency = await checkIdempotencySupport(db);

  if (entry.idempotencyKey && !hasIdempotency) {
    throw new AppError(
      500,
      "SCHEMA_MIGRATION_REQUIRED",
      "Idempotency key provided but database schema does not support idempotency (migration 0012 pending)",
      { idempotencyKey: entry.idempotencyKey },
    );
  }

  // 1. Check idempotency if supported and key provided
  if (hasIdempotency && entry.idempotencyKey) {
    const existingTx = await db.query<PersistedTx>(
      `SELECT id, user_id, amount, balance_after, kind, trip_id, reference, created_by
         FROM wallet_transactions
        WHERE idempotency_key = $1`,
      [entry.idempotencyKey],
    );

    const existing = existingTx.rows[0];
    if (existing) {
      if (isIdempotentMatch(existing, entry)) {
        return Number(existing.balance_after);
      }
      throwIdempotencyConflict(existing, entry);
    }
  }

  // 2. Perform balance update and ledger insert inside a SAVEPOINT to protect against
  // aborted transaction state on unique constraint violation (code 23505) during concurrent races.
  const spName = `sp_ledger_${Date.now()}_${++savepointSeq}`;
  await db.query(`SAVEPOINT ${spName}`);

  let newBalance: number;

  try {
    // Atomic balance update with customer non-negative protection & driver commission-only negative float
    const { rows } = await db.query<{ balance: string; role: string }>(
      `UPDATE wallets w
          SET balance = w.balance + $2,
              updated_at = now()
         FROM users u
        WHERE w.user_id = $1
          AND u.id = w.user_id
          AND (w.balance + $2 >= 0 OR (u.role = 'driver' AND $3 = 'commission' AND $2 < 0))
       RETURNING w.balance, u.role`,
      [entry.userId, entry.amount, entry.kind],
    );

    if (!rows[0]) {
      // Determine exact cause of non-update
      const walletCheck = await db.query<{ balance: string; role: string }>(
        `SELECT w.balance, u.role
           FROM wallets w
           JOIN users u ON u.id = w.user_id
          WHERE w.user_id = $1`,
        [entry.userId],
      );

      if (!walletCheck.rows[0]) {
        throw new AppError(404, "WALLET_NOT_FOUND", `Wallet not found for user ${entry.userId}`, {
          userId: entry.userId,
        });
      }

      const currentBalance = Number(walletCheck.rows[0].balance);
      const userRole = walletCheck.rows[0].role;
      const isAllowedDriverNegative =
        userRole === "driver" && entry.kind === "commission" && entry.amount < 0;

      if (!isAllowedDriverNegative && currentBalance + entry.amount < 0) {
        throw new AppError(402, "INSUFFICIENT_FUNDS", "Insufficient wallet balance", {
          userId: entry.userId,
          currentBalance,
          requiredAmount: Math.abs(entry.amount),
          deficit: Math.abs(currentBalance + entry.amount),
        });
      }

      throw new AppError(500, "LEDGER_UPDATE_FAILED", `Failed to update wallet for ${entry.userId}`);
    }

    newBalance = Number(rows[0].balance);

    // 3. Insert immutable ledger entry
    if (hasIdempotency && entry.idempotencyKey) {
      await db.query(
        `INSERT INTO wallet_transactions (user_id, amount, balance_after, kind, trip_id, reference, created_by, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          entry.userId,
          entry.amount,
          newBalance,
          entry.kind,
          entry.tripId ?? null,
          entry.reference ?? null,
          entry.createdBy ?? null,
          entry.idempotencyKey,
        ],
      );
    } else {
      await db.query(
        `INSERT INTO wallet_transactions (user_id, amount, balance_after, kind, trip_id, reference, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          entry.userId,
          entry.amount,
          newBalance,
          entry.kind,
          entry.tripId ?? null,
          entry.reference ?? null,
          entry.createdBy ?? null,
        ],
      );
    }

    // Success: release the savepoint
    await db.query(`RELEASE SAVEPOINT ${spName}`);
    return newBalance;
  } catch (err: any) {
    // Unique constraint violation (23505) on idempotency_key indicates a concurrent request
    // inserted the record first between our initial lookup and our insert.
    const isIdempotencyViolation =
      err.code === "23505" &&
      (err.constraint?.includes("idempotency_key") ||
        err.message?.includes("idempotency_key") ||
        (Boolean(entry.idempotencyKey) && !err.constraint?.includes("pkey")));

    if (isIdempotencyViolation && entry.idempotencyKey) {
      // Roll back to the savepoint:
      // 1) Undoes the tentative wallet balance update from this failed attempt.
      // 2) Clears PostgreSQL's aborted transaction state (SQLSTATE 25P02), allowing subsequent queries.
      await db.query(`ROLLBACK TO SAVEPOINT ${spName}`);

      // Re-read the committed transaction record inserted by the concurrent winning request
      const raceCheck = await db.query<PersistedTx>(
        `SELECT id, user_id, amount, balance_after, kind, trip_id, reference, created_by
           FROM wallet_transactions
          WHERE idempotency_key = $1`,
        [entry.idempotencyKey],
      );

      const existing = raceCheck.rows[0];
      if (existing) {
        if (isIdempotentMatch(existing, entry)) {
          return Number(existing.balance_after);
        }
        throwIdempotencyConflict(existing, entry);
      }
    }

    // Roll back to savepoint to ensure no partial state remains in savepoint
    try {
      await db.query(`ROLLBACK TO SAVEPOINT ${spName}`);
    } catch {
      // If transaction is already broken or aborted at a higher level, ignore rollback error
    }
    throw err;
  }
}
