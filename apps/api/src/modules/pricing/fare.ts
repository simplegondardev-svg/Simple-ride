/** Fare rules for one vehicle category, all money in santim (1 ETB = 100). */
export interface FareRules {
  baseFare: number;
  perKm: number;
  perMinute: number;
  minimumFare: number;
  bookingFee: number;
  commissionBps: number;
}

export interface FareBreakdown {
  base: number;
  distance: number;
  time: number;
  multiplier: number;
  bookingFee: number;
  total: number;
  /** Platform share of `total`. Driver earns total - commission. */
  commission: number;
}

/**
 * total = max(minimum, base + km·perKm + min·perMinute) × zone multiplier
 *         + booking fee, rounded UP to a whole birr (cash-friendly).
 */
export function calculateFare(
  rules: FareRules,
  distanceM: number,
  durationS: number,
  multiplier = 1,
): FareBreakdown {
  const base = rules.baseFare;
  const distance = Math.round((distanceM / 1000) * rules.perKm);
  const time = Math.round((durationS / 60) * rules.perMinute);
  const metered = Math.max(rules.minimumFare, base + distance + time);
  const raw = metered * multiplier + rules.bookingFee;
  const total = Math.ceil(raw / 100) * 100;
  const commission = Math.round((total * rules.commissionBps) / 10_000);
  return { base, distance, time, multiplier, bookingFee: rules.bookingFee, total, commission };
}

/**
 * Extra charge when a trip takes longer than estimated (business decision,
 * Oct 2026): the extra minutes at the category's per-minute rate, capped at
 * `capBps` of the quote (default 25%). Never negative; rounded so the final
 * fare stays a whole birr and never exceeds quote + cap.
 */
export function overtimeCharge(input: {
  quote: number;          // santim, whole birr
  estimatedS: number;     // estimated trip duration
  actualS: number;        // started → completed
  perMinute: number;      // santim
  capBps: number;
}): number {
  const extraMinutes = Math.ceil(Math.max(0, input.actualS - input.estimatedS) / 60);
  if (extraMinutes === 0 || input.perMinute <= 0) return 0;
  const charge = Math.ceil((extraMinutes * input.perMinute) / 100) * 100;      // up to a whole birr
  const cap = Math.floor((input.quote * Math.max(0, input.capBps)) / 10_000 / 100) * 100; // down to a whole birr
  return Math.min(charge, cap);
}
