/**
 * Validates password against Simple Ride password policy:
 * - Minimum 10 characters
 * - Maximum 128 characters
 * - Cannot contain the user's phone number digits (last 9 digits)
 * - Cannot be one repeated character
 *
 * Matches backend passwordProblem() in apps/api/src/auth/password.ts.
 */
export function checkPasswordPolicy(password: string, phone: string = ""): string | null {
  if (password.length < 10) return "Password must be at least 10 characters";
  if (password.length > 128) return "Password must be at most 128 characters";
  const cleanPhone = phone.replace(/\D/g, "");
  if (cleanPhone.length >= 9 && password.replace(/\D/g, "").includes(cleanPhone.slice(-9))) {
    return "Password must not contain your phone number";
  }
  if (/^(.)\1+$/.test(password)) return "Password must not be one repeated character";
  return null;
}

/**
 * Returns detailed checklist items for real-time password feedback.
 */
export function getPasswordRequirements(password: string, phone: string = "", confirm: string = "") {
  const cleanPhone = phone.replace(/\D/g, "");
  const hasMinLength = password.length >= 10;
  const notTooLong = password.length <= 128;
  const noPhone = !(cleanPhone.length >= 9 && password.replace(/\D/g, "").includes(cleanPhone.slice(-9)));
  const notRepeated = !/^(.)\1+$/.test(password);
  const matchesConfirm = password.length > 0 && confirm.length > 0 && password === confirm;

  return {
    hasMinLength,
    notTooLong,
    noPhone,
    notRepeated,
    matchesConfirm,
    isValid: hasMinLength && notTooLong && noPhone && notRepeated,
  };
}

/**
 * Safely resolves an internal redirect destination:
 * - Defaults to "/ride" (or specified fallback)
 * - Accepts only same-origin relative internal paths (e.g. "/ride", "/account", "/ride?tab=history#receipt")
 * - Rejects external absolute URLs (e.g. "https://attacker.example")
 * - Rejects protocol-relative URLs (e.g. "//attacker.example")
 * - Rejects backslash-based URL ambiguities (e.g. "/\\attacker.example", "\\\\attacker.example", "/foo\\bar")
 * - Rejects non-HTTP(S) schemes (e.g. "javascript:alert(1)", "data:...")
 * - Rejects control characters, invalid percent-encoding, and malformed URLs
 * - Preserves valid internal paths, query strings, and fragments
 */
export function resolveSafeRedirect(next?: string | null, fallback: string = "/ride"): string {
  if (!next || typeof next !== "string") {
    return fallback;
  }

  // Reject strings containing control characters
  if (/[\u0000-\u001f\u007f]/.test(next)) {
    return fallback;
  }

  // Must begin with a single slash, not a double slash, and must not contain any backslash (\)
  if (!next.startsWith("/") || next.startsWith("//") || next.includes("\\")) {
    return fallback;
  }

  // Check the path segment before any query string or hash for encoded slashes/backslashes
  const pathOnly = next.split("?")[0].split("#")[0];
  try {
    const decodedPath = decodeURIComponent(pathOnly);
    // Reject if decoded path starts with double slashes (//) or contains any single backslash (\)
    if (decodedPath.startsWith("//") || decodedPath.includes("\\")) {
      return fallback;
    }
  } catch {
    return fallback;
  }

  try {
    const base = "http://localhost";
    const parsed = new URL(next, base);

    // Origin must match our dummy origin exactly (ensures relative same-origin resolution)
    if (parsed.origin !== base) {
      return fallback;
    }

    // Protocol must be http:
    if (parsed.protocol !== "http:") {
      return fallback;
    }

    return parsed.pathname + parsed.search + parsed.hash;
  } catch {
    return fallback;
  }
}

export const resolveSafeNext = resolveSafeRedirect;


