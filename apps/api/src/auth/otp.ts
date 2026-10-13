import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { redis } from "../lib/redis.js";

const MAX_ATTEMPTS = 5;
const hash = (phone: string, code: string) =>
  createHash("sha256").update(`${phone}:${code}`).digest();

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

/** Issue a 6-digit code. Returns it only when OTP_DEV_ECHO is on. */
export async function issueOtp(phone: string): Promise<string | undefined> {
  const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
  await redis
    .multi()
    .set(`otp:${phone}`, hash(phone, code).toString("hex"), "EX", env.OTP_TTL_SECONDS)
    .del(`otp:attempts:${phone}`)
    .exec();
  await sms.send(phone, `Simple Ride code: ${code}`);
  return env.OTP_DEV_ECHO ? code : undefined;
}

/** True once per issued code; burns the code after too many wrong guesses. */
export async function verifyOtp(phone: string, code: string): Promise<boolean> {
  const stored = await redis.get(`otp:${phone}`);
  if (!stored) return false;

  const attempts = await redis.incr(`otp:attempts:${phone}`);
  await redis.expire(`otp:attempts:${phone}`, env.OTP_TTL_SECONDS);
  if (attempts > MAX_ATTEMPTS) {
    await redis.del(`otp:${phone}`);
    return false;
  }

  const ok = timingSafeEqual(Buffer.from(stored, "hex"), hash(phone, code));
  if (ok) await redis.del(`otp:${phone}`, `otp:attempts:${phone}`);
  return ok;
}
