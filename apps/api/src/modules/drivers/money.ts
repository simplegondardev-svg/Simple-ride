import type { PoolClient } from "pg";

/**
 * Driver money rules (business decisions, Oct 2026), all admin-adjustable in
 * app_settings:
 *  - commission: the driver's custom rate, else the default (10%)
 *  - prepaid deposit: commission is deducted from the driver's wallet;
 *    each deposit must be at least min_deposit (10,000 ETB)
 *  - below low_balance_threshold (200 ETB) the driver can finish the current
 *    trip but can't go online, accept or receive offers until they deposit
 *  - below low_balance_warning (1,000 ETB) the driver is warned to top up
 *  - the remaining deposit is refundable refund_after_days (90) after approval
 */
export interface DriverMoneySettings {
  defaultCommissionBps: number;
  minDeposit: number;
  lowBalanceThreshold: number;
  lowBalanceWarning: number;
  refundAfterDays: number;
}

const DEFAULTS: DriverMoneySettings = {
  defaultCommissionBps: 1000, minDeposit: 1_000_000, lowBalanceThreshold: 20_000,
  lowBalanceWarning: 100_000, refundAfterDays: 90,
};

export async function moneySettings(db: PoolClient): Promise<DriverMoneySettings> {
  const { rows } = await db.query<{ key: string; value: unknown }>(
    `SELECT key, value FROM app_settings WHERE key IN
       ('default_commission_bps', 'min_deposit', 'low_balance_threshold', 'low_balance_warning', 'refund_after_days')`,
  );
  const v = Object.fromEntries(rows.map((r) => [r.key, Number(r.value)]));
  return {
    defaultCommissionBps: v.default_commission_bps ?? DEFAULTS.defaultCommissionBps,
    minDeposit: v.min_deposit ?? DEFAULTS.minDeposit,
    lowBalanceThreshold: v.low_balance_threshold ?? DEFAULTS.lowBalanceThreshold,
    lowBalanceWarning: v.low_balance_warning ?? DEFAULTS.lowBalanceWarning,
    refundAfterDays: v.refund_after_days ?? DEFAULTS.refundAfterDays,
  };
}

export interface WalletStatus {
  balance: number;
  threshold: number;
  warningLevel: number;
  minDeposit: number;
  /** Balance is at or above the threshold: may go online and receive trips. */
  canReceiveTrips: boolean;
  /** Balance is below the warning level: ask the driver to top up soon. */
  needsTopUp: boolean;
}

export function walletStatus(balance: number, s: DriverMoneySettings): WalletStatus {
  return {
    balance, threshold: s.lowBalanceThreshold, warningLevel: s.lowBalanceWarning, minDeposit: s.minDeposit,
    canReceiveTrips: balance >= s.lowBalanceThreshold,
    needsTopUp: balance < s.lowBalanceWarning,
  };
}

/** Wallet balance for each driver (0 when there's no wallet). */
export async function balances(db: PoolClient, driverIds: string[]): Promise<Map<string, number>> {
  if (driverIds.length === 0) return new Map();
  const { rows } = await db.query<{ user_id: string; balance: number }>(
    "SELECT user_id, balance FROM wallets WHERE user_id = ANY($1)", [driverIds],
  );
  return new Map(rows.map((r) => [r.user_id, r.balance]));
}

export async function commissionBps(db: PoolClient, driverId: string, s: DriverMoneySettings): Promise<number> {
  const { rows: [r] } = await db.query<{ commission_bps: number | null }>(
    "SELECT commission_bps FROM driver_profiles WHERE user_id = $1", [driverId],
  );
  return r?.commission_bps ?? s.defaultCommissionBps;
}
