import type { PoolClient } from "pg";

/**
 * Post one entry to the immutable wallet ledger and update the cached
 * balance. Money moves only through here, in SYSTEM context (RLS forbids
 * users and most staff from writing wallets directly).
 */
export async function postLedger(
  db: PoolClient,
  entry: {
    userId: string;
    amount: number;          // signed santim
    kind: "topup" | "deposit" | "trip_payment" | "trip_earning" | "commission" | "payout" | "refund" | "bonus" | "adjustment";
    tripId?: string | null;
    reference?: string | null;
    createdBy?: string | null;
  },
): Promise<number> {
  const { rows } = await db.query<{ balance: number }>(
    "UPDATE wallets SET balance = balance + $2, updated_at = now() WHERE user_id = $1 RETURNING balance",
    [entry.userId, entry.amount],
  );
  if (!rows[0]) throw new Error(`wallet missing for ${entry.userId}`);
  await db.query(
    `INSERT INTO wallet_transactions (user_id, amount, balance_after, kind, trip_id, reference, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [entry.userId, entry.amount, rows[0].balance, entry.kind, entry.tripId ?? null,
     entry.reference ?? null, entry.createdBy ?? null],
  );
  return rows[0].balance;
}
