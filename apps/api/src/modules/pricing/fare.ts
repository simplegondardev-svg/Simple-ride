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
