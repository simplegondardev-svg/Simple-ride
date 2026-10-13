import { redis } from "./redis.js";
import { AppError } from "./errors.js";

/** Fixed-window counter. Throws 429 once `limit` hits within `windowSeconds`. */
export async function rateLimit(key: string, limit: number, windowSeconds: number) {
  const k = `rl:${key}`;
  const [[, count]] = (await redis.multi().incr(k).expire(k, windowSeconds, "NX").exec()) as [
    [unknown, number],
  ];
  if (count > limit) {
    throw new AppError(429, "RATE_LIMITED", "Too many requests, try again later");
  }
}
