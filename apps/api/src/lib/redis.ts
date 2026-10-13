import { Redis } from "ioredis";
import { env } from "../config/env.js";

/**
 * Redis roles in this system:
 *   - OTP codes and attempt counters (short TTL)
 *   - rate limiting
 *   - live driver positions (GEO set) for nearby-driver search
 *   - cache for Gebeta routing/geocoding responses (each call costs money)
 *   - Socket.IO adapter pub/sub when the API runs on several instances
 */
export const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3 });
