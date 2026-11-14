/**
 * Normalise an Ethiopian mobile number to E.164 (+2519XXXXXXXX / +2517XXXXXXXX).
 * Accepts 09..., 07..., 9..., 7..., 2519..., +2519... with spaces, dashes, or parentheses.
 * Ethio Telecom numbers start with 9, Safaricom Ethiopia with 7.
 * Returns null for anything that is not a valid Ethiopian mobile number.
 *
 * Consistent with backend phone schema in apps/api/src/lib/phone.ts.
 */
export function normalizeEthiopianPhone(input: string | null | undefined): string | null {
  if (!input || typeof input !== "string") return null;
  const digits = input.replace(/[\s\-()]/g, "").replace(/^\+/, "");
  const m = /^(?:251|0)?([79]\d{8})$/.exec(digits);
  return m ? `+251${m[1]}` : null;
}

/**
 * Returns true if the input is a valid Ethiopian mobile number.
 */
export function isValidEthiopianPhone(input: string | null | undefined): boolean {
  return normalizeEthiopianPhone(input) !== null;
}

/**
 * Formats an Ethiopian phone number for UI display.
 * - "international": "+251 91 122 3344"
 * - "local": "0911 22 33 44"
 * Returns trimmed input if invalid or unnormalizable.
 */
export function formatEthiopianPhone(
  input: string | null | undefined,
  format: "international" | "local" = "international",
): string {
  if (!input || typeof input !== "string") return "";
  const normalized = normalizeEthiopianPhone(input);
  if (!normalized) return input.trim();

  // normalized is "+251" + 9 digits (e.g. "+251911223344")
  const prefix = normalized.slice(4, 6); // "91" or "71"
  const part1 = normalized.slice(6, 9);  // "122"
  const part2 = normalized.slice(9, 13); // "3344"

  if (format === "local") {
    return `0${prefix} ${part1} ${part2}`;
  }
  return `+251 ${prefix} ${part1} ${part2}`;
}

