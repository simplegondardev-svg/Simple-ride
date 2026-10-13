/**
 * Normalise an Ethiopian mobile number to E.164 (+2519XXXXXXXX / +2517XXXXXXXX).
 * Accepts 09..., 07..., 9..., 7..., 2519..., +2519... with spaces or dashes.
 * Ethio Telecom numbers start with 9, Safaricom Ethiopia with 7.
 * Returns null for anything that is not a valid Ethiopian mobile number.
 */
export function normalizeEthiopianPhone(input: string): string | null {
  const digits = input.replace(/[\s\-()]/g, "").replace(/^\+/, "");
  const m = /^(?:251|0)?([79]\d{8})$/.exec(digits);
  return m ? `+251${m[1]}` : null;
}
