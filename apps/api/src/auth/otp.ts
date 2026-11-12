import { createHash, randomInt } from "node:crypto";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { redis } from "../lib/redis.js";

const MAX_ATTEMPTS = 5;
const hash = (phone: string, code: string) =>
  createHash("sha256").update(`${phone}:${code}`).digest();

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
export async function issueOtp(phone: string): Promise<string | undefined> {
  const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
  await redis
    .multi()
    .set(`otp:${phone}`, hash(phone, code).toString("hex"), "EX", env.OTP_TTL_SECONDS)
    .del(`otp:attempts:${phone}`)
    .exec();
  try {
    await sms.send(phone, `Simple Ride code: ${code}`);
  } catch (err) {
    await redis.del(`otp:${phone}`, `otp:attempts:${phone}`);
    throw err;
  }
  return env.OTP_DEV_ECHO ? code : undefined;
}

/** True once per issued code; burns the code after too many wrong guesses. */
export async function verifyOtp(phone: string, code: string): Promise<boolean> {
  const expectedHash = hash(phone, code).toString("hex");
  const res = (await redis.eval(
    VERIFY_OTP_LUA,
    2,
    `otp:${phone}`,
    `otp:attempts:${phone}`,
    expectedHash,
    env.OTP_TTL_SECONDS,
    MAX_ATTEMPTS,
  )) as number;
  return res === 1;
}
