import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { env } from "../src/config/env.js";
import { redis } from "../src/lib/redis.js";
import { geocode, getRoute, legsFrom, parseLegs, parsePlaces, parseRoute, rankByProximity, reverseGeocode } from "../src/modules/geo/gebeta.js";
import { BOLE, PIASSA } from "./helpers.js";

// Live responses captured from mapapi.gebeta.app (Oct 2026), trimmed.
const LIVE_GEOCODE = {
  data: {
    query: "bole medhanialem",
    results: [
      { id: "forge-340332",
        name: "Bole Medhanialem Branch\tCommercial Bank Of Ethiopia - Bole Medhanialem Branch",
        display_name: "Bole Medhanialem Branch\tCommercial Bank Of Ethiopia - Bole Medhanialem Branch, Addis Ababa, Ethiopia",
        category: "registration location", location: { lat: 8.997, lng: 38.787 },
        address: { city: "Addis Ababa", country: "Ethiopia", country_code: "ET" }, neighborhood: "BOLE MEDHANIALEM" },
      { id: "forge-2258", name: "Bole Medhanialem Church", display_name: "Bole Medhanialem Church, Addis Ababa, Ethiopia",
        category: "Orthodox church", location: { lat: 8.995867, lng: 38.789909 },
        address: { city: "Addis Ababa", country: "Ethiopia", country_code: "ET" }, neighborhood: "BOLE MEDHANIALEM" },
    ],
  },
};
const LIVE_ONM = {
  origins: [{ lat: 8.996186, lon: 38.789243, radius: null }],
  destinations: [{ lat: 9.03507, lon: 38.752848, radius: null }, { lat: 9.020295, lon: 38.80168, radius: null }],
  origin_to_destination: [{ from: 0, to: 0, distance: 8.016, time: 1169 }, { from: 0, to: 1, distance: 4.248, time: 640 }],
};

// Sample responses copied from docs.gebeta.app (llms-full.txt).
const DOCS_GEOCODE = {
  data: {
    query: "Bole Road",
    results: [{
      id: "way:123456", name: "Bole Road", display_name: "Bole Road, Addis Ababa, Ethiopia",
      category: "highway", location: { lat: 9.019185, lng: 38.757812 },
      address: { city: "Addis Ababa", country: "Ethiopia", country_code: "ETH" },
    }],
  },
};
// ONM sample's inner direction (the Direction page's own sample is truncated).
const DOCS_ROUTE = {
  msg: "Ok", timetaken: 504.00467, totalDistance: 1512.014,
  direction: [[9.033223152160645, 38.73643493652344], [9.0335, 38.7368]],
};

describe("parsers (documented response shapes)", () => {
  it("geocode results → places", () => {
    expect(parsePlaces(DOCS_GEOCODE)).toEqual([{
      id: "way:123456", name: "Bole Road", displayName: "Bole Road, Addis Ababa, Ethiopia",
      lat: 9.019185, lng: 38.757812, city: "Addis Ababa", category: "highway",
    }]);
  });

  it("live geocode: tab-separated names cleaned, neighborhood kept", () => {
    const [bank, church] = parsePlaces(LIVE_GEOCODE);
    expect(bank).toMatchObject({
      name: "Commercial Bank Of Ethiopia - Bole Medhanialem Branch",
      displayName: "Commercial Bank Of Ethiopia - Bole Medhanialem Branch, Addis Ababa, Ethiopia",
      neighborhood: "Bole Medhanialem",
    });
    expect(church).toMatchObject({ name: "Bole Medhanialem Church", lat: 8.995867, lng: 38.789909 });
  });

  it("live one-to-many: km → metres, in target order, unroutable targets are null", () => {
    expect(parseLegs(LIVE_ONM, 3)).toEqual([
      { distanceM: 8016, durationS: 1169 },
      { distanceM: 4248, durationS: 640 },
      null,
    ]);
    expect(parseLegs({}, 2)).toEqual([null, null]);
  });

  it("nearby results first (live: 'piassa' from Bole ranked Mekelle and Hawassa above Addis)", () => {
    const place = (name: string, lat: number, lng: number) => ({ name, displayName: name, lat, lng });
    const ranked = rankByProximity([
      place("Piassa Pharmacy (Mekelle)", 13.496168, 39.474274),
      place("Piassa Hotel (Hawassa)", 7.0498, 38.47323),
      place("Piassa 2 Square (Addis)", 9.035849, 38.752391),
    ], BOLE);
    expect(ranked.map((p) => p.name)).toEqual([
      "Piassa 2 Square (Addis)", "Piassa Pharmacy (Mekelle)", "Piassa Hotel (Hawassa)",
    ]);
  });

  it("tolerates empty or malformed bodies", () => {
    expect(parsePlaces({ data: { results: [] } })).toEqual([]);
    expect(parsePlaces({ data: [] })).toEqual([]);
    expect(parsePlaces(null)).toEqual([]);
    expect(parsePlaces({ data: { results: [{ name: "No coords" }] } })).toEqual([]);
  });

  it("direction: metres, seconds, and [lat,lng] path flipped to GeoJSON order", () => {
    const r = parseRoute(DOCS_ROUTE);
    expect(r).toMatchObject({ distanceM: 1512, durationS: 504, source: "gebeta" });
    expect(r.path[0]).toEqual([38.73643493652344, 9.033223152160645]);
  });

  it("implausible timetaken falls back to a distance-based estimate", () => {
    // Direction page sample: 15.7 m in 52 "seconds" ≈ 1 km/h — not a car.
    const r = parseRoute({ msg: "Ok", timetaken: 51.905, totalDistance: 15.715, direction: [] });
    expect(r.durationS).toBe(Math.round(15.715 / (22 / 3.6)));
  });

  it("rejects a response without a distance", () => {
    expect(() => parseRoute({ msg: "Ok" })).toThrow(/totalDistance/);
  });
});

describe("requests sent to Gebeta", () => {
  const calls: { url: URL; headers: Record<string, string> }[] = [];
  let reply: { status: number; body: unknown } = { status: 200, body: {} };
  const originalKey = env.GEBETA_API_KEY;

  beforeAll(() => {
    env.GEBETA_API_KEY = "test-key";
    vi.stubGlobal("fetch", async (url: URL, init: { headers: Record<string, string> }) => {
      calls.push({ url: new URL(url), headers: init.headers });
      return new Response(JSON.stringify(reply.body), { status: reply.status });
    });
  });
  afterEach(async () => {
    calls.length = 0;
    await redis.flushdb(); // test Redis DB; avoids cached responses between tests
  });
  afterAll(() => {
    env.GEBETA_API_KEY = originalKey;
    vi.unstubAllGlobals();
    redis.disconnect();
  });

  it("directions: lat,lng without braces, key as query param (as the official SDK does)", async () => {
    reply = { status: 200, body: DOCS_ROUTE };
    const r = await getRoute(BOLE, PIASSA);
    expect(r.source).toBe("gebeta");
    const { url } = calls[0]!;
    expect(url.origin + url.pathname).toBe("https://mapapi.gebeta.app/api/route/direction/");
    expect(url.searchParams.get("origin")).toBe(`${BOLE.lat},${BOLE.lng}`);
    expect(url.searchParams.get("destination")).toBe(`${PIASSA.lat},${PIASSA.lng}`);
    expect(url.searchParams.get("apiKey")).toBe("test-key");
  });

  it("directions errors fall back to the estimate instead of failing the booking", async () => {
    reply = { status: 401, body: { error: { code: "HE00004", message: "Invalid token!", status: 401 } } };
    const r = await getRoute(BOLE, PIASSA);
    expect(r.source).toBe("estimate");
  });

  it("geocode: v2 endpoint, Ethiopia only, proximity as lng,lat, key as ?apiKey (header is rejected live)", async () => {
    reply = { status: 200, body: DOCS_GEOCODE };
    const places = await geocode("  Bole Road ", BOLE);
    expect(places[0]?.name).toBe("Bole Road");
    const { url, headers } = calls[0]!;
    expect(url.pathname).toBe("/v2/search/geocode");
    expect(url.searchParams.get("query")).toBe("bole road");
    expect(url.searchParams.get("country")).toBe("et");
    expect(url.searchParams.get("proximity")).toBe(`${BOLE.lng.toFixed(2)},${BOLE.lat.toFixed(2)}`);
    expect(url.searchParams.get("apiKey")).toBe("test-key");
    expect(headers.authorization).toBeUndefined();
  });

  it("one-to-many: /onm without trailing slash, targets as [{lat,lng},…], max 5", async () => {
    reply = { status: 200, body: LIVE_ONM };
    const targets = [PIASSA, { lat: 9.0203, lng: 38.8017 }];
    expect(await legsFrom(BOLE, targets)).toEqual([
      { distanceM: 8016, durationS: 1169 }, { distanceM: 4248, durationS: 640 },
    ]);
    const { url } = calls[0]!;
    expect(url.pathname).toBe("/api/route/onm");
    expect(url.searchParams.get("origin")).toBe(`${BOLE.lat},${BOLE.lng}`);
    expect(url.searchParams.get("json")).toBe(`[{${PIASSA.lat},${PIASSA.lng}},{9.0203,38.8017}]`);
    await expect(legsFrom(BOLE, Array(6).fill(PIASSA))).rejects.toThrow(/at most 5/);
  });

  it("geocode results are cached", async () => {
    reply = { status: 200, body: DOCS_GEOCODE };
    await geocode("bole");
    await geocode("BOLE ");
    expect(calls).toHaveLength(1);
  });

  it("reverse geocoding: v2 endpoint with lat and lon", async () => {
    reply = { status: 200, body: DOCS_GEOCODE };
    await reverseGeocode(BOLE);
    const { url } = calls[0]!;
    expect(url.pathname).toBe("/v2/search/reverse-geocoding");
    expect(url.searchParams.get("lat")).toBe(String(BOLE.lat));
    expect(url.searchParams.get("lon")).toBe(String(BOLE.lng));
  });

  it("geocode errors surface (the route turns them into 502 MAPS_UNAVAILABLE)", async () => {
    reply = { status: 401, body: { error: { code: "HE00004", message: "Invalid token!", status: 401 } } };
    await expect(geocode("bole")).rejects.toThrow(/Gebeta 401 HE00004/);
  });
});
