/**
 * Dispatch simulation (CP2 exit check). Runs against a live API server:
 *
 *   pnpm --filter @simple-ride/api dev                     # in one terminal
 *   pnpm --filter @simple-ride/api simulate                # in another
 *
 * Creates SIM_DRIVERS approved drivers spread over Addis Ababa, connected by
 * Socket.IO and pinging their location like the driver app, who accept most
 * offers after a human-like delay, decline some and ignore a few. Then
 * SIM_TRIPS riders request trips spread over SIM_SECONDS. Drivers drive each
 * accepted trip through arrive → start (with the ride PIN) → complete.
 *
 * Reports: stuck trips, time to accept (median/p90), pickup ETA, offers per
 * trip, outcome counts. Exit criteria: no stuck trips, median accept < 30 s.
 *
 * Accounts are created directly in the database (owner connection) and tokens
 * signed with the server's JWT secret, so the run isn't throttled by the
 * per-IP sign-up limits. Sim accounts are named "Sim driver N" / "Sim customer
 * N"; each run first takes earlier runs' sim drivers offline.
 */
import { randomInt, randomUUID } from "node:crypto";
import pg from "pg";
import { io, type Socket } from "socket.io-client";
import { signAccessToken } from "../src/auth/tokens.js";

const API = process.env.SIM_API ?? "http://localhost:4000";
const DRIVERS = Number(process.env.SIM_DRIVERS ?? 50);
const TRIPS = Number(process.env.SIM_TRIPS ?? 200);
const SECONDS = Number(process.env.SIM_SECONDS ?? 150);
const P_ACCEPT = 0.8, P_DECLINE = 0.15; // the rest ignore the offer
const runId = Date.now().toString().slice(-5);

// Busy areas of Addis Ababa (pickups and driver starting points cluster here).
const HOTSPOTS = [
  { name: "Bole", lat: 8.9961, lng: 38.7894 }, { name: "Piassa", lat: 9.0349, lng: 38.7525 },
  { name: "Megenagna", lat: 9.0203, lng: 38.8017 }, { name: "Mexico", lat: 9.0107, lng: 38.7464 },
  { name: "Kazanchis", lat: 9.0157, lng: 38.7685 }, { name: "Sarbet", lat: 8.9985, lng: 38.7350 },
  { name: "CMC", lat: 9.0215, lng: 38.8413 }, { name: "Gerji", lat: 8.9960, lng: 38.8100 },
];
const jitter = (p: { lat: number; lng: number }, metres: number) => ({
  lat: p.lat + ((Math.random() - 0.5) * 2 * metres) / 111_000,
  lng: p.lng + ((Math.random() - 0.5) * 2 * metres) / 109_000,
});
const pick = <T>(a: T[]) => a[randomInt(a.length)]!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const between = (lo: number, hi: number) => lo + Math.random() * (hi - lo);

async function api(path: string, token: string, body?: unknown, method = body ? "POST" : "GET") {
  const res = await fetch(`${API}/api/v1/${path}`, {
    method, headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
}

const db = new pg.Client({ connectionString: process.env.DATABASE_OWNER_URL });

async function createUser(role: "customer" | "driver", n: number) {
  // Valid Ethiopian format: +2519 + 3 digits of the run id + 5-digit counter.
  const phone = `+2519${runId.slice(-3)}${String(n).padStart(5, "0")}`;
  const { rows: [u] } = await db.query(
    `INSERT INTO users (phone, role, full_name) VALUES ($1, $2, $3)
     ON CONFLICT (phone, role) DO UPDATE SET status = 'active' RETURNING id`,
    [phone, role, `Sim ${role} ${n}`],
  );
  await db.query("INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT DO NOTHING", [u.id]);
  if (role === "driver") {
    await db.query(
      `INSERT INTO driver_profiles (user_id, approval_status) VALUES ($1, 'approved')
       ON CONFLICT (user_id) DO UPDATE SET approval_status = 'approved', availability = 'offline'`, [u.id]);
    await db.query(
      `INSERT INTO vehicles (driver_id, category_code, plate_number, make, model, color, status, is_current)
       VALUES ($1, 'economy', $2, 'Toyota', 'Vitz', 'Blue', 'approved', true) ON CONFLICT DO NOTHING`,
      [u.id, `SIM-${runId}-${n}`]);
  }
  return { id: u.id as string, token: signAccessToken({ sub: u.id, role }) };
}

// ───────────────────────── Drivers ─────────────────────────

interface SimDriver { id: string; token: string; pos: { lat: number; lng: number }; socket: Socket; busy: boolean }
const pins = new Map<string, string>(); // tripId → ride PIN (the rider tells the driver)
const counts = { offers: 0, accepts: 0, declines: 0, ignores: 0, acceptLost: 0 };

async function startDriver(n: number): Promise<SimDriver> {
  const u = await createUser("driver", n);
  const d: SimDriver = { ...u, pos: jitter(pick(HOTSPOTS), 2500), busy: false, socket: io(API, { auth: { token: u.token } }) };
  await api("drivers/me/online", d.token, { location: d.pos });

  // Location pings every 5 s with a little movement, like the driver app.
  setInterval(() => {
    d.pos = jitter(d.pos, 60);
    d.socket.emit("driver:location", d.pos);
  }, 5000).unref();

  d.socket.on("trip:offer", async (offer: { tripId: string }) => {
    counts.offers++;
    if (d.busy) return;
    const roll = Math.random();
    if (roll < P_ACCEPT) {
      await sleep(between(2000, 8000));
      if (d.busy) return;
      const res = await api(`trips/${offer.tripId}/accept`, d.token, {});
      if (res.status !== 200) { counts.acceptLost++; return; }
      counts.accepts++;
      d.busy = true;
      driveTrip(d, offer.tripId).finally(() => { d.busy = false; });
    } else if (roll < P_ACCEPT + P_DECLINE) {
      counts.declines++;
      await sleep(between(1000, 5000));
      await api(`trips/${offer.tripId}/decline`, d.token, {});
    } else {
      counts.ignores++; // lets the 20 s offer window lapse
    }
  });
  return d;
}

async function driveTrip(d: SimDriver, tripId: string) {
  await sleep(between(3000, 6000));
  await api(`trips/${tripId}/arrive`, d.token, {});
  await sleep(between(1000, 3000));
  await api(`trips/${tripId}/start`, d.token, { ridePin: pins.get(tripId) });
  await sleep(between(4000, 10000));
  await api(`trips/${tripId}/complete`, d.token, {});
}

// ───────────────────────── Run ─────────────────────────

async function main() {
  await db.connect();
  // Earlier runs' drivers must not take this run's trips.
  await db.query(`UPDATE driver_profiles SET availability = 'offline'
                   WHERE user_id IN (SELECT id FROM users WHERE full_name LIKE 'Sim %')`);

  console.log(`Simulation ${runId}: ${DRIVERS} drivers, ${TRIPS} trips over ${SECONDS}s against ${API}`);
  const drivers: SimDriver[] = [];
  for (let i = 0; i < DRIVERS; i++) drivers.push(await startDriver(i));
  console.log(`${drivers.length} drivers online`);
  await sleep(2000);

  const tripIds: string[] = [];
  const started = Date.now();
  for (let i = 0; i < TRIPS; i++) {
    const rider = await createUser("customer", 500 + i);
    const from = pick(HOTSPOTS);
    const to = pick(HOTSPOTS.filter((h) => h !== from));
    const res = await api("trips", rider.token, {
      clientRequestId: randomUUID(), categoryCode: "economy", paymentMethod: "cash",
      pickup: { ...jitter(from, 1500), address: `Near ${from.name}` },
      dropoff: { ...jitter(to, 800), address: `Near ${to.name}` },
    });
    if (res.status !== 201) console.warn("trip request failed", res.status, res.body?.error?.code);
    else { tripIds.push(res.body.id); pins.set(res.body.id, res.body.ridePin); }
    const target = started + ((i + 1) * SECONDS * 1000) / TRIPS;
    await sleep(Math.max(0, target - Date.now()));
  }
  console.log(`${tripIds.length} trips requested; waiting for them to finish…`);

  // Wait until every trip has finished (or the 3-minute search timeout + slack).
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const { rows: [r] } = await db.query(
      `SELECT count(*)::int AS open FROM trips WHERE id = ANY($1)
          AND status IN ('searching', 'accepted', 'arrived', 'in_progress')`, [tripIds]);
    if (r.open === 0) break;
    await sleep(3000);
  }

  const { rows: outcome } = await db.query(
    "SELECT status, count(*)::int AS n FROM trips WHERE id = ANY($1) GROUP BY status ORDER BY status", [tripIds]);
  const { rows: [m] } = await db.query(
    `SELECT
       percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM accepted_at - requested_at)) AS accept_p50,
       percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM accepted_at - requested_at)) AS accept_p90,
       max(extract(epoch FROM accepted_at - requested_at)) AS accept_max
     FROM trips WHERE id = ANY($1) AND accepted_at IS NOT NULL`, [tripIds]);
  const { rows: [e] } = await db.query(
    `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY eta_s) AS eta_p50,
            percentile_cont(0.9) WITHIN GROUP (ORDER BY eta_s) AS eta_p90,
            avg(c)::numeric(5,2) AS offers_per_trip
       FROM (SELECT o.eta_s, (SELECT count(*) FROM trip_offers x WHERE x.trip_id = o.trip_id) AS c
               FROM trip_offers o WHERE o.trip_id = ANY($1) AND o.status = 'accepted') s`, [tripIds]);
  const stuck = outcome.filter((o) => ["searching", "accepted", "arrived", "in_progress"].includes(o.status))
    .reduce((n, o) => n + o.n, 0);

  const secs = (v: unknown) => (v == null ? "—" : `${Number(v).toFixed(1)} s`);
  console.log("\n── Results ─────────────────────────────");
  console.log("Trip outcomes:      ", Object.fromEntries(outcome.map((o) => [o.status, o.n])));
  console.log("Stuck trips:        ", stuck);
  console.log("Time to accept:      median", secs(m.accept_p50), "· p90", secs(m.accept_p90), "· max", secs(m.accept_max));
  console.log("Driver ETA to pickup: median", secs(e.eta_p50), "· p90", secs(e.eta_p90));
  console.log("Offers per accepted trip:", e.offers_per_trip ?? "—");
  console.log("Driver behaviour:   ", counts);
  const pass = stuck === 0 && m.accept_p50 != null && Number(m.accept_p50) < 30;
  console.log(`\nCP2 exit criteria (no stuck trips, median accept < 30 s): ${pass ? "PASS" : "FAIL"}`);

  for (const d of drivers) d.socket.close();
  await db.end();
  process.exit(pass ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await db.end().catch(() => {});
  process.exit(1);
});
