import { Redis } from "ioredis";
import { env } from "../config/env.js";
import { getVerifiedRedisUrl } from "../db/isolation.js";

/**
 * Redis roles in this system:
 *   - OTP codes and attempt counters (short TTL)
 *   - rate limiting
 *   - live driver positions (GEO set) for nearby-driver search
 *   - cache for Gebeta routing/geocoding responses (each call costs money)
 *   - Socket.IO adapter pub/sub when the API runs on several instances
 */
let _redis: Redis | null = null;

function getRedis(): Redis {
  if (!_redis) {
    const redisUrl = getVerifiedRedisUrl(env.REDIS_URL);
    _redis = new Redis(redisUrl, { maxRetriesPerRequest: 3 });
  }
  return _redis;
}

export const redis = new Proxy({} as Redis, {
  get(_target, prop, receiver) {
    const r = getRedis();
    const val = Reflect.get(r, prop, receiver);
    if (typeof val === "function") {
      return val.bind(r);
    }
    return val;
  },
});
