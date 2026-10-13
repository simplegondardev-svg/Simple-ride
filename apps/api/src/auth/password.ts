import { randomBytes, randomInt, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: ScryptOptions) => Promise<Buffer>;

// OWASP-recommended scrypt cost (N=2^17, r=8, p=1) uses 128 MiB per hash;
// N=2^15 keeps memory at 32 MiB while staying well above brute-force reach
// for 10+ character passwords. Parameters are stored in each hash, so they
// can be raised later without breaking existing passwords.
const N = 32768, R = 8, P = 1, KEYLEN = 64;
const MAXMEM = 64 * 1024 * 1024;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, n, r, p, salt, hash] = stored.split("$");
  if (algo !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const key = await scrypt(password, Buffer.from(salt, "base64"), expected.length, {
    N: Number(n), r: Number(r), p: Number(p), maxmem: MAXMEM,
  });
  return timingSafeEqual(key, expected);
}

/** Hash used when the phone has no account, so response time doesn't reveal which phones exist. */
let dummy: Promise<string> | undefined;
export const dummyHash = () => (dummy ??= hashPassword("not-a-real-password"));

/** Rules for passwords people choose. Returns a reason, or null if acceptable. */
export function passwordProblem(password: string, phone: string): string | null {
  if (password.length < 10) return "Password must be at least 10 characters";
  if (password.length > 128) return "Password must be at most 128 characters";
  if (password.replace(/\D/g, "").includes(phone.replace(/\D/g, "").slice(-9))) {
    return "Password must not contain your phone number";
  }
  if (/^(.)\1+$/.test(password)) return "Password must not be one repeated character";
  return null;
}

/**
 * Temporary password an admin hands to a staff member, e.g. "kemu-7Rq4-tazb".
 * Unambiguous characters only (no 0/O, 1/l/I). Must be changed at first login.
 */
export function temporaryPassword(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const chunk = () => Array.from({ length: 4 }, () => alphabet[randomInt(alphabet.length)]).join("");
  return `${chunk()}-${chunk()}-${chunk()}`;
}
