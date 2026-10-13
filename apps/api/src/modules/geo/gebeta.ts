import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import { redis } from "../../lib/redis.js";

/**
 * Gebeta Maps client (https://gebeta.app) — Ethiopian maps, routing and
 * geocoding. All map services go through this module so caching, fallbacks
 * and key handling live in one place; the API key never reaches clients.
 *
 * VERIFIED WITH LIVE CALLS (Oct 2026). Where the docs differ, the live
 * behaviour wins and is noted:
 *   directions   GET /api/route/direction/?origin=lat,lng&destination=lat,lng&apiKey=
 *                → { msg, timetaken (s), totalDistance (m), direction: [[lat, lng], ...] }
 *   one-to-many  GET /api/route/onm?origin=lat,lng&json=[{lat,lng},{lat,lng}]&apiKey=
 *                (NO trailing slash — "/onm/" as documented returns 502; max 5 targets)
 *                → { origins, destinations,
 *                    origin_to_destination: [{ from, to, distance (KM!), time (s) }] }
 *                (the documented { directions: [...] } shape is not what is returned)
 *   geocode      GET /v2/search/geocode?query=&country=et&proximity=lng,lat&limit=&apiKey=
 *   reverse      GET /v2/search/reverse-geocoding?lat=&lon=&size=&apiKey=
 *                (the documented Authorization: Bearer header is rejected: "missing api key")
 *                → { data: { query, results: [{ id, name, display_name, category,
 *                    location: { lat, lng }, address: { city, country, country_code },
 *                    neighborhood }] } }   (names may contain a tab separator)
 *   tiles        tiles.gebeta.app, Authorization: Bearer <key> (see apps/web Map.tsx)
 *   errors       { error: { code, message, status } }
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
  id?: string;
  name: string;
  /** Full label, e.g. "Bole Medhanialem Church, Addis Ababa, Ethiopia". */
  displayName: string;
  lat: number;
  lng: number;
  /** Local area riders recognise, e.g. "Bole Medhanialem", "Piassa". */
  neighborhood?: string;
  city?: string;
  category?: string;
}

/** Road distance and time from one origin to one target. */
export interface Leg {
  distanceM: number;
  durationS: number;
}

const CACHE_TTL_ROUTE = 60 * 10; // traffic changes; keep routes short-lived
const CACHE_TTL_GEOCODE = 60 * 60 * 24 * 7;
const AVG_CITY_SPEED_KMH = 22; // Addis Ababa congestion, used for fallbacks

// ~11 m precision: nearby requests share cache entries.
const key = (p: LatLng) => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`;

export class GebetaError extends Error {
  constructor(public status: number, public code: string | undefined, message: string) {
    super(`Gebeta ${status}${code ? ` ${code}` : ""}: ${message}`);
  }
}

async function call(path: string, params: Record<string, string | undefined>): Promise<any> {
  const url = new URL(path, env.GEBETA_BASE_URL);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  // Every endpoint takes the key as ?apiKey. Never log `url`: it contains the key.
  url.searchParams.set("apiKey", env.GEBETA_API_KEY);

  const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5000) });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new GebetaError(res.status, body?.error?.code, body?.error?.message ?? res.statusText);
  }
  return body;
}

async function cached<T>(cacheKey: string, ttl: number, load: () => Promise<T>): Promise<T> {
  const hit = await redis.get(cacheKey);
  if (hit) return JSON.parse(hit) as T;
  const value = await load();
  await redis.set(cacheKey, JSON.stringify(value), "EX", ttl);
  return value;
}

/**
 * Gebeta returns paths as [lat, lng] pairs (per the docs' sample). Inside
 * Ethiopia latitude is ~3–15 and longitude ~33–48, so the ranges never
 * overlap and the order is detected rather than assumed.
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

const secondsAt = (distanceM: number, kmh: number) => Math.round(distanceM / (kmh / 3.6));

/**
 * Fallback when Gebeta is unavailable: straight-line distance × 1.35 road
 * factor at the average city speed. Good enough to quote a fare.
 */
export function estimateRoute(from: LatLng, to: LatLng): Route {
  const distanceM = Math.round(haversineM(from, to) * 1.35);
  return { distanceM, durationS: secondsAt(distanceM, AVG_CITY_SPEED_KMH), path: [], source: "estimate" };
}

/**
 * Parse a direction response. timetaken is used as seconds only if the
 * implied speed is plausible for a car (3–100 km/h); otherwise duration is
 * estimated from distance, as the official SDK does.
 */
export function parseRoute(data: any): Route {
  const distanceM = Number(data?.totalDistance);
  if (!Number.isFinite(distanceM) || distanceM < 0) throw new Error("Gebeta direction: missing totalDistance");
  const timetaken = Number(data?.timetaken);
  const kmh = timetaken > 0 ? (distanceM / timetaken) * 3.6 : NaN;
  const durationS = kmh >= 3 && kmh <= 100 ? Math.round(timetaken) : secondsAt(distanceM, AVG_CITY_SPEED_KMH);
  return { distanceM: Math.round(distanceM), durationS, path: toLngLatPath(data?.direction), source: "gebeta" };
}

/**
 * Some names come as "Short\tLong form" (e.g. "Bole Medhanialem Branch\tCommercial
 * Bank Of Ethiopia - Bole Medhanialem Branch"); keep the descriptive long form.
 */
const cleanName = (raw: unknown) => {
  const parts = String(raw ?? "").split("\t").map((p) => p.trim()).filter(Boolean);
  return parts.at(-1) ?? "";
};
const titleCase = (s: string) => s.toLowerCase().replace(/\b\p{L}/gu, (c) => c.toUpperCase());

/** Parse a v2 geocode / reverse-geocoding response. */
export function parsePlaces(body: any): Place[] {
  const results: any[] = Array.isArray(body?.data?.results) ? body.data.results : [];
  return results
    .map((r) => {
      const name = cleanName(r.name ?? r.display_name);
      const display = String(r.display_name ?? "").split("\t").at(-1)?.trim();
      return {
        id: r.id ? String(r.id) : undefined,
        name,
        displayName: display || name,
        lat: Number(r.location?.lat),
        lng: Number(r.location?.lng),
        neighborhood: r.neighborhood ? titleCase(String(r.neighborhood)) : undefined,
        city: r.address?.city,
        category: r.category,
      };
    })
    .filter((p) => p.name && Number.isFinite(p.lat) && Number.isFinite(p.lng));
}

/** Parse a one-to-many response into legs ordered like the targets. Distance is km. */
export function parseLegs(body: any, targets: number): (Leg | null)[] {
  const legs: (Leg | null)[] = Array.from({ length: targets }, () => null);
  for (const l of Array.isArray(body?.origin_to_destination) ? body.origin_to_destination : []) {
    const km = Number(l?.distance), s = Number(l?.time), i = Number(l?.to);
    if (Number.isInteger(i) && i >= 0 && i < targets && Number.isFinite(km) && Number.isFinite(s)) {
      legs[i] = { distanceM: Math.round(km * 1000), durationS: Math.round(s) };
    }
  }
  return legs;
}

export async function getRoute(from: LatLng, to: LatLng): Promise<Route> {
  if (!env.GEBETA_API_KEY) return estimateRoute(from, to);
  try {
    return await cached(`gebeta:route:${key(from)}:${key(to)}`, CACHE_TTL_ROUTE, async () =>
      parseRoute(await call("/api/route/direction/", {
        origin: `${from.lat},${from.lng}`,
        destination: `${to.lat},${to.lng}`,
      })),
    );
  } catch (err) {
    logger.warn({ err }, "Gebeta routing failed, using estimate");
    return estimateRoute(from, to);
  }
}

/**
 * Place search, limited to Ethiopia and biased towards `near` (usually the
 * rider's position) so "Bole" finds the Bole near them first.
 */
export async function geocode(query: string, near?: LatLng): Promise<Place[]> {
  if (!env.GEBETA_API_KEY) return [];
  const q = query.trim().toLowerCase();
  // Proximity rounded to ~1 km so the cache still gets hits.
  const bias = near ? `${near.lng.toFixed(2)},${near.lat.toFixed(2)}` : undefined;
  const places = await cached(`gebeta:geo:${q}:${bias ?? "-"}`, CACHE_TTL_GEOCODE, async () =>
    parsePlaces(await call("/v2/search/geocode", { query: q, country: "et", limit: "10", proximity: bias })),
  );
  return near ? rankByProximity(places, near) : places;
}

const NEARBY_M = 60_000;

/**
 * Gebeta's proximity bias is weak: "Piassa" from Bole returned Mekelle and
 * Hawassa matches before Addis Ababa's Piassa (live test). Keep Gebeta's
 * relevance order, but put everything within 60 km of the rider first.
 */
export function rankByProximity(places: Place[], near: LatLng): Place[] {
  const close = places.filter((p) => haversineM(near, p) <= NEARBY_M);
  const far = places.filter((p) => haversineM(near, p) > NEARBY_M);
  return [...close, ...far];
}

export async function reverseGeocode(p: LatLng): Promise<Place[]> {
  if (!env.GEBETA_API_KEY) return [];
  return cached(`gebeta:rev:${key(p)}`, CACHE_TTL_GEOCODE, async () =>
    parsePlaces(await call("/v2/search/reverse-geocoding", { lat: String(p.lat), lon: String(p.lng), size: "3" })),
  );
}

/**
 * Road distance/time from one origin to up to 5 targets in one call (Gebeta
 * ONM). Built for dispatch v2: rank nearby drivers by real driving time to
 * the pickup instead of straight-line distance. Returns null for a target
 * Gebeta couldn't route; throws if the service fails so callers can fall back.
 */
export async function legsFrom(origin: LatLng, targets: LatLng[]): Promise<(Leg | null)[]> {
  if (targets.length === 0) return [];
  if (targets.length > 5) throw new Error("Gebeta ONM accepts at most 5 targets");
  if (!env.GEBETA_API_KEY) throw new Error("GEBETA_API_KEY not configured");
  const json = `[${targets.map((t) => `{${t.lat},${t.lng}}`).join(",")}]`;
  return parseLegs(await call("/api/route/onm", { origin: `${origin.lat},${origin.lng}`, json }), targets.length);
}

/**
 * Road distance/time from each origin TO one destination (Gebeta matrix:
 * every pair, both directions). Used by dispatch: driver → pickup, which can
 * differ a lot from pickup → driver on one-way and divided roads (live:
 * Megenagna→Bole 5.0 km, Bole→Megenagna 4.2 km). Up to 9 origins per call
 * (the matrix takes 10 points). Throws on failure so callers can fall back.
 */
export async function drivingTimesTo(origins: LatLng[], destination: LatLng): Promise<(Leg | null)[]> {
  if (origins.length === 0) return [];
  if (origins.length > 9) throw new Error("Gebeta matrix accepts at most 10 points (9 origins + destination)");
  if (!env.GEBETA_API_KEY) throw new Error("GEBETA_API_KEY not configured");
  const points = [...origins, destination];
  const json = `[${points.map((p) => `{${p.lat},${p.lng}}`).join(",")}]`;
  return parseMatrixTo(await call("/api/route/matrix", { json }), origins.length);
}

/** From a full matrix, the legs i → last point, for i < origins. Distance is km. */
export function parseMatrixTo(body: any, origins: number): (Leg | null)[] {
  const legs: (Leg | null)[] = Array.from({ length: origins }, () => null);
  for (const l of Array.isArray(body?.origin_to_destination) ? body.origin_to_destination : []) {
    const from = Number(l?.from), to = Number(l?.to), km = Number(l?.distance), s = Number(l?.time);
    if (to === origins && Number.isInteger(from) && from >= 0 && from < origins && Number.isFinite(km) && Number.isFinite(s)) {
      legs[from] = { distanceM: Math.round(km * 1000), durationS: Math.round(s) };
    }
  }
  return legs;
}
