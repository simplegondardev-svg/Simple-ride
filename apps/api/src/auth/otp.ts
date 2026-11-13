import { createHash, randomInt } from "node:crypto";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { redis } from "../lib/redis.js";

const MAX_ATTEMPTS = 5;

export type OtpScope =
  | { purpose: "register"; phone: string; role: "customer" | "driver" }
  | { purpose: "verify_phone"; phone: string; userId: string }
  | { purpose: "password_reset"; phone: string; userId: string };

export function getOtpIdentity(scope: OtpScope): string {
  switch (scope.purpose) {
    case "register":
      return `${scope.role}:${scope.phone}`;
    case "verify_phone":
    case "password_reset":
      return scope.userId;
  }
}

export const otpKey = (scope: OtpScope) => `otp:${scope.purpose}:${scope.phone}:${getOtpIdentity(scope)}`;
export const attemptsKey = (scope: OtpScope) =>
  `otp:attempts:${scope.purpose}:${scope.phone}:${getOtpIdentity(scope)}`;

const hash = (scope: OtpScope, code: string) =>
  createHash("sha256")
    .update(`${scope.purpose}:${getOtpIdentity(scope)}:${scope.phone}:${code}`)
    .digest();

const VERIFY_OTP_LUA = `
local stored = redis.call('GET', KEYS[1])
if not stored then
  return 0
end
local attempts = redis.call('INCR', KEYS[2])
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[2]))
if attempts > tonumber(ARGV[3]) then
  redis.call('DEL', KEYS[1])
  return 0
end

local expected = ARGV[1]
local diff = 0
if type(stored) ~= 'string' or #stored ~= 64 or type(expected) ~= 'string' or #expected ~= 64 then
  diff = diff + 1
end

local s = type(stored) == 'string' and stored or ''
local e = type(expected) == 'string' and expected or ''

-- Fixed-length full-scan comparison across all 64 SHA-256 hex characters without early exit or branching.
for i = 1, 64 do
  local a = (i <= #s) and string.byte(s, i) or 0
  local b = (i <= #e) and string.byte(e, i) or 0
  local delta = a - b
  diff = diff + (delta * delta)
end

if diff == 0 then
  redis.call('DEL', KEYS[1], KEYS[2])
  return 1
else
  return 0
end
`;

/**
 * SMS delivery. Swap the console implementation for a real provider
 * (e.g. AfroMessage, or Ethio Telecom's bulk SMS gateway) behind this
 * interface; nothing else needs to change.
 */
export interface SmsSender {
  send(phone: string, message: string): Promise<void>;
}

export const consoleSms: SmsSender = {
  async send(phone, message) {
    logger.info({ phone, message }, "SMS (console sender)");
  },
};

let sms: SmsSender = consoleSms;
export const setSmsSender = (sender: SmsSender) => { sms = sender; };
export const getSmsSender = () => sms;

export class MockSmsSender implements SmsSender {
  sent: { phone: string; message: string }[] = [];
  async send(phone: string, message: string) {
    this.sent.push({ phone, message });
  }
  clear() {
    this.sent = [];
  }
}

/** Issue a 6-digit code. Returns it only when OTP_DEV_ECHO is on. */
export async function issueOtp(scope: OtpScope): Promise<string | undefined> {
  const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
  const key = otpKey(scope);
  const attKey = attemptsKey(scope);
  await redis
    .multi()
    .set(key, hash(scope, code).toString("hex"), "EX", env.OTP_TTL_SECONDS)
    .del(attKey)
    .exec();
  try {
    await sms.send(scope.phone, `Simple Ride code: ${code}`);
  } catch (err) {
    await redis.del(key, attKey);
    throw err;
  }
  return env.OTP_DEV_ECHO ? code : undefined;
}

/** True once per issued code; burns the code after too many wrong guesses. */
export async function verifyOtp(scope: OtpScope, code: string): Promise<boolean> {
  const expectedHash = hash(scope, code).toString("hex");
  const res = (await redis.eval(
    VERIFY_OTP_LUA,
    2,
    otpKey(scope),
    attemptsKey(scope),
    expectedHash,
    env.OTP_TTL_SECONDS,
    MAX_ATTEMPTS,
  )) as number;
  return res === 1;
}

/** Explicitly clear an in-flight OTP and attempt counter. */
export async function clearOtp(scope: OtpScope): Promise<void> {
  await redis.del(otpKey(scope), attemptsKey(scope));
}
