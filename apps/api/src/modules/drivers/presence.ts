import { SYSTEM, withContext } from "../../db/context.js";
import { redis } from "../../lib/redis.js";
import { emitToUser } from "../../realtime/socket.js";
import type { LatLng } from "../geo/gebeta.js";

/**
 * Live driver positions. Drivers ping every few seconds, which is far too
 * hot for Postgres, so the live state is in Redis:
 *   drivers:geo:<category>   GEO set of AVAILABLE drivers, by vehicle category
 *   drivers:seen             ZSET driverId → last ping (ms), to drop stale ones
 *   driver:<id>              HASH { category, lat, lng, heading, at }
 * Postgres (driver_profiles.last_location) is written on a 30 s throttle.
 */

const STALE_MS = 60_000;
const PERSIST_EVERY_S = 30;

export async function setAvailable(driverId: string, category: string, p: LatLng) {
  await redis
    .multi()
    .geoadd(`drivers:geo:${category}`, p.lng, p.lat, driverId)
    .zadd("drivers:seen", Date.now(), driverId)
    .hset(`driver:${driverId}`, { category, lat: p.lat, lng: p.lng, at: Date.now() })
    .exec();
}

/** Remove from matching (offline, or busy on a trip). */
export async function setUnavailable(driverId: string) {
  const category = await redis.hget(`driver:${driverId}`, "category");
  const tx = redis.multi().zrem("drivers:seen", driverId);
  if (category) tx.zrem(`drivers:geo:${category}`, driverId);
  await tx.exec();
}

/**
 * Record a position ping. Only drivers currently in a GEO set (available)
 * are re-indexed for matching; drivers on a trip still get their position
 * stored so the rider can follow them.
 */
export async function recordPing(driverId: string, p: LatLng & { heading?: number }) {
  const state = await redis.hgetall(`driver:${driverId}`);
  const tx = redis.multi().hset(`driver:${driverId}`, {
    lat: p.lat, lng: p.lng, heading: p.heading ?? "", at: Date.now(),
  });
  if (state.category && (await redis.zscore("drivers:seen", driverId)) !== null) {
    tx.geoadd(`drivers:geo:${state.category}`, p.lng, p.lat, driverId);
    tx.zadd("drivers:seen", Date.now(), driverId);
  }
  await tx.exec();

  // On a trip: stream the position to the rider's map.
  const onTrip = await redis.get(`driver:trip:${driverId}`);
  if (onTrip) {
    const [tripId, customerId] = onTrip.split(":");
    emitToUser(customerId!, "driver:location", { tripId, lat: p.lat, lng: p.lng, heading: p.heading });
  }

  const shouldPersist = await redis.set(`driver:persist:${driverId}`, "1", "EX", PERSIST_EVERY_S, "NX");
  if (shouldPersist) {
    await withContext(SYSTEM, (db) =>
      db.query(
        `UPDATE driver_profiles
            SET last_location = ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography,
                last_location_at = now()
          WHERE user_id = $1`,
        [driverId, p.lng, p.lat],
      ),
    );
  }
}

export interface NearbyDriver {
  driverId: string;
  /** Straight-line distance to the search point. */
  distanceM: number;
  lat: number;
  lng: number;
}

export async function findNearby(
  category: string, p: LatLng, radiusM = 5000, limit = 10,
): Promise<NearbyDriver[]> {
  const raw = (await redis.geosearch(
    `drivers:geo:${category}`, "FROMLONLAT", p.lng, p.lat,
    "BYRADIUS", radiusM, "m", "ASC", "COUNT", limit * 2, "WITHDIST", "WITHCOORD",
  )) as [string, string, [string, string]][];
  if (raw.length === 0) return [];

  const seen = await redis.zmscore("drivers:seen", ...raw.map(([id]) => id));
  const cutoff = Date.now() - STALE_MS;
  return raw
    .filter((_, i) => Number(seen[i] ?? 0) > cutoff)
    .slice(0, limit)
    .map(([driverId, dist, [lng, lat]]) => ({
      driverId, distanceM: Math.round(Number(dist)), lat: Number(lat), lng: Number(lng),
    }));
}

/** Available drivers whose last ping is older than the stale cutoff. */
export async function staleDrivers(): Promise<string[]> {
  return redis.zrangebyscore("drivers:seen", "-inf", Date.now() - STALE_MS);
}

export async function getPosition(driverId: string): Promise<(LatLng & { at: number }) | null> {
  const s = await redis.hgetall(`driver:${driverId}`);
  if (!s.lat || !s.lng) return null;
  return { lat: Number(s.lat), lng: Number(s.lng), at: Number(s.at) };
}
