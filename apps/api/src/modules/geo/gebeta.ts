import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import { redis } from "../../lib/redis.js";

/**
 * Gebeta Maps client (https://gebeta.app) — Ethiopian maps, routing and
 * geocoding. All map services go through this module so caching, fallbacks
 * and key handling live in one place. The API key never reaches clients for
 * routing/geocoding; web and Flutter only use a (restricted) key for tiles.
 *
 * VERIFY against https://docs.gebeta.app before production: endpoint paths
 * below match the public docs as researched, but response field names are
 * parsed defensively because they were not confirmed against a live call.
 */

export interface LatLng {
  lat: number;
  lng: number;
}

export interface Route {
  distanceM: number;
  durationS: number;
  /** [lng, lat] pairs (GeoJSON order), empty when using the fallback. */
  path: [number, number][];
  source: "gebeta" | "estimate";
}

export interface Place {
  name: string;
  lat: number;
  lng: number;
  city?: string;
  type?: string;
}

const CACHE_TTL_ROUTE = 60 * 10; // traffic changes; keep routes short-lived
const CACHE_TTL_GEOCODE = 60 * 60 * 24 * 7;

// ~11 m precision: nearby requests share cache entries.
const key = (p: LatLng) => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`;

async function call(path: string, params: Record<string, string>): Promise<any> {
  const url = new URL(path, env.GEBETA_BASE_URL);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("apiKey", env.GEBETA_API_KEY);
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Gebeta ${path} responded ${res.status}`);
  return res.json();
}

async function cached<T>(cacheKey: string, ttl: number, load: () => Promise<T>): Promise<T> {
  const hit = await redis.get(cacheKey);
  if (hit) return JSON.parse(hit) as T;
  const value = await load();
  await redis.set(cacheKey, JSON.stringify(value), "EX", ttl);
  return value;
}

/**
 * Gebeta paths are coordinate pairs whose order is not pinned down in the
 * docs. Inside Ethiopia latitude is ~3–15 and longitude ~33–48, so the
 * ranges never overlap and the order can be detected reliably.
 */
export function toLngLatPath(raw: unknown): [number, number][] {
  if (!Array.isArray(raw)) return [];
  const pairs = raw.filter(
    (p): p is [number, number] => Array.isArray(p) && typeof p[0] === "number" && typeof p[1] === "number",
  );
  if (pairs.length === 0) return [];
  const firstIsLng = pairs[0]![0] > 30;
  return pairs.map(([a, b]) => (firstIsLng ? [a, b] : [b, a]));
}

/** Haversine distance in metres. */
export function haversineM(a: LatLng, b: LatLng): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Fallback when Gebeta is unavailable: straight-line distance × 1.35 road
 * factor at an average 22 km/h (Addis Ababa congestion). Good enough to
 * quote a fare; the trip is re-priced on completion anyway.
 */
export function estimateRoute(from: LatLng, to: LatLng): Route {
  const distanceM = Math.round(haversineM(from, to) * 1.35);
  return { distanceM, durationS: Math.round(distanceM / (22_000 / 3600)), path: [], source: "estimate" };
}

export async function getRoute(from: LatLng, to: LatLng): Promise<Route> {
  if (!env.GEBETA_API_KEY) return estimateRoute(from, to);
  try {
    return await cached(`gebeta:route:${key(from)}:${key(to)}`, CACHE_TTL_ROUTE, async () => {
      const data = await call("/api/route/direction/", {
        origin: `${from.lat},${from.lng}`,
        destination: `${to.lat},${to.lng}`,
      });
      const distanceM = Number(data.totalDistance ?? data.totaldistance ?? data.distance);
      const durationS = Number(data.timetaken ?? data.timeTaken ?? data.duration);
      if (!Number.isFinite(distanceM) || !Number.isFinite(durationS)) {
        throw new Error("unexpected Gebeta direction response shape");
      }
      return {
        distanceM: Math.round(distanceM),
        durationS: Math.round(durationS),
        path: toLngLatPath(data.direction ?? data.path),
        source: "gebeta" as const,
      };
    });
  } catch (err) {
    logger.warn({ err }, "Gebeta routing failed, using estimate");
    return estimateRoute(from, to);
  }
}

function toPlaces(data: any): Place[] {
  const list: any[] = Array.isArray(data?.data) ? data.data : [];
  return list
    .map((p) => ({
      name: String(p.name ?? p.display_name ?? ""),
      lat: Number(p.lat ?? p.latitude),
      lng: Number(p.lng ?? p.lon ?? p.longitude),
      city: p.city,
      type: p.type,
    }))
    .filter((p) => p.name && Number.isFinite(p.lat) && Number.isFinite(p.lng));
}

export async function geocode(query: string): Promise<Place[]> {
  if (!env.GEBETA_API_KEY) return [];
  const q = query.trim().toLowerCase();
  return cached(`gebeta:geo:${q}`, CACHE_TTL_GEOCODE, async () =>
    toPlaces(await call("/api/v1/route/geocoding", { name: q })),
  );
}

export async function reverseGeocode(p: LatLng): Promise<Place[]> {
  if (!env.GEBETA_API_KEY) return [];
  return cached(`gebeta:rev:${key(p)}`, CACHE_TTL_GEOCODE, async () =>
    toPlaces(await call("/api/v1/route/revgeocoding", { lat: String(p.lat), lon: String(p.lng) })),
  );
}
