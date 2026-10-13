import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { SYSTEM, withContext } from "../src/db/context.js";
import { pool } from "../src/db/pool.js";
import { redis } from "../src/lib/redis.js";
import { rankByEta, sweepTrips } from "../src/modules/trips/service.js";
import { BOLE, fundDriver, grant, makeBackoffice, PASSWORD, PIASSA, randomPhone } from "./helpers.js";

const app = createApp();
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
type Session = { accessToken: string; user: { id: string } };

async function register(role: "customer" | "driver"): Promise<Session> {
  return (await request(app).post("/api/v1/auth/register")
    .send({ phone: randomPhone(), password: PASSWORD, role, platform: "android" }).expect(201)).body;
}

/** An approved driver with a vehicle, online at `at`. */
async function onlineDriver(at: { lat: number; lng: number }): Promise<Session> {
  const d = await register("driver");
  await withContext(SYSTEM, async (db) => {
    await db.query("UPDATE driver_profiles SET approval_status = 'approved' WHERE user_id = $1", [d.user.id]);
    await db.query(
      `INSERT INTO vehicles (driver_id, category_code, plate_number, make, model, color, status, is_current)
       VALUES ($1, 'economy', $2, 'Toyota', 'Vitz', 'Blue', 'approved', true)`,
      [d.user.id, `T-${randomUUID().slice(0, 8)}`],
    );
  });
  await fundDriver(d.user.id);
  await request(app).post("/api/v1/drivers/me/online").set(bearer(d.accessToken)).send({ location: at }).expect(200);
  return d;
}

async function book(rider: Session) {
  return (await request(app).post("/api/v1/trips").set(bearer(rider.accessToken)).send({
    clientRequestId: randomUUID(), categoryCode: "economy", paymentMethod: "cash",
    pickup: { ...BOLE, address: "Bole" }, dropoff: { ...PIASSA, address: "Piassa" },
  }).expect(201)).body;
}

const offersOf = async (d: Session) =>
  (await request(app).get("/api/v1/drivers/me/offers").set(bearer(d.accessToken)).expect(200)).body.data
    .map((o: any) => o.tripId);

// ~110 m per 0.001° latitude: drivers at increasing distance north of the pickup.
const north = (m: number) => ({ lat: BOLE.lat + m / 111_000, lng: BOLE.lng });

beforeEach(async () => {
  await redis.flushdb(); // test Redis: each test starts with no drivers online
  await withContext(SYSTEM, (db) =>
    db.query("UPDATE trips SET status = 'cancelled' WHERE status IN ('searching','accepted','arrived','in_progress')"));
});
afterAll(async () => {
  await pool.end();
  redis.disconnect();
});

describe("ranking", () => {
  const near = (id: string, distanceM: number) => ({ driverId: id, distanceM, lat: 0, lng: 0 });

  it("orders by real driving time, not straight-line distance", () => {
    const ranked = rankByEta(
      [near("close-but-slow", 600), near("farther-but-fast", 1500)],
      [{ distanceM: 4000, durationS: 600 }, { distanceM: 1600, durationS: 240 }],
    );
    expect(ranked.map((r) => r.driverId)).toEqual(["farther-but-fast", "close-but-slow"]);
    expect(ranked[0]!.etaSource).toBe("gebeta");
  });

  it("falls back to a straight-line estimate when Gebeta has no answer", () => {
    const ranked = rankByEta([near("a", 2000), near("b", 1000)], null);
    expect(ranked.map((r) => r.driverId)).toEqual(["b", "a"]);
    expect(ranked[0]).toMatchObject({ etaSource: "estimate", etaS: Math.round((1000 * 1.35) / (22 / 3.6)) });
  });
});

describe("offer rounds", () => {
  it("offers the 2 best drivers first; a decline passes it to the next", async () => {
    const [d1, d2, d3] = [await onlineDriver(north(300)), await onlineDriver(north(600)), await onlineDriver(north(900))];
    const trip = await book(await register("customer"));

    expect(await offersOf(d1)).toContain(trip.id);
    expect(await offersOf(d2)).toContain(trip.id);
    expect(await offersOf(d3)).not.toContain(trip.id);

    await request(app).post(`/api/v1/trips/${trip.id}/decline`).set(bearer(d1.accessToken)).expect(204);
    expect(await offersOf(d3)).not.toContain(trip.id); // d2 still holds a live offer
    await request(app).post(`/api/v1/trips/${trip.id}/decline`).set(bearer(d2.accessToken)).expect(204);
    expect(await offersOf(d3)).toContain(trip.id);     // next round immediately, no sweeper wait
  });

  it("offers carry the estimated time to the pickup", async () => {
    const d = await onlineDriver(north(500));
    const trip = await book(await register("customer"));
    const { rows: [o] } = await withContext(SYSTEM, (db) =>
      db.query("SELECT eta_s, distance_m FROM trip_offers WHERE trip_id = $1 AND driver_id = $2", [trip.id, d.user.id]));
    expect(o.distance_m).toBeGreaterThan(400);
    expect(o.eta_s).toBeGreaterThan(0);
  });

  it("acceptance rate is tracked per driver", async () => {
    const d = await onlineDriver(north(300));
    const rider = await register("customer");
    const t1 = await book(rider);
    await request(app).post(`/api/v1/trips/${t1.id}/decline`).set(bearer(d.accessToken)).expect(204);
    await request(app).post(`/api/v1/trips/${t1.id}/cancel`).set(bearer(rider.accessToken)).send({}).expect(200);
    const t2 = await book(rider);
    await request(app).post(`/api/v1/trips/${t2.id}/accept`).set(bearer(d.accessToken)).expect(200);
    const me = await request(app).get("/api/v1/drivers/me").set(bearer(d.accessToken)).expect(200);
    expect(me.body.acceptanceRate).toBe(0.5);
  });
});

describe("driver cancels after accepting", () => {
  it("the trip goes back to searching and the next driver gets it, not the one who cancelled", async () => {
    const [d1, d2] = [await onlineDriver(north(300)), await onlineDriver(north(600))];
    const rider = await register("customer");
    const trip = await book(rider);
    await request(app).post(`/api/v1/trips/${trip.id}/accept`).set(bearer(d1.accessToken)).expect(200);
    await request(app).post(`/api/v1/trips/${trip.id}/arrive`).set(bearer(d1.accessToken)).expect(200);

    // Age the search window so we can see it is reset.
    await withContext(SYSTEM, (db) =>
      db.query("UPDATE trips SET searching_since = now() - interval '10 minutes' WHERE id = $1", [trip.id]));

    await request(app).post(`/api/v1/trips/${trip.id}/cancel`).set(bearer(d1.accessToken))
      .send({ reason: "Flat tyre" }).expect(200);

    const seen = await request(app).get(`/api/v1/trips/${trip.id}`).set(bearer(rider.accessToken)).expect(200);
    expect(seen.body).toMatchObject({ status: "searching", driverId: null });

    const { rows: [t] } = await withContext(SYSTEM, (db) =>
      db.query("SELECT searching_since > now() - interval '1 minute' AS fresh FROM trips WHERE id = $1", [trip.id]));
    expect(t.fresh).toBe(true);

    // d2 had an offer that expired when d1 accepted; the re-dispatch offers it again.
    expect(await offersOf(d2)).toContain(trip.id);
    expect(await offersOf(d1)).not.toContain(trip.id);
    await sweepTrips();
    expect(await offersOf(d1)).not.toContain(trip.id);

    const me = await request(app).get("/api/v1/drivers/me").set(bearer(d1.accessToken)).expect(200);
    expect(me.body.availability).toBe("online");
  });

  it("can't cancel once the ride has started", async () => {
    const d = await onlineDriver(north(300));
    const rider = await register("customer");
    const trip = await book(rider);
    await request(app).post(`/api/v1/trips/${trip.id}/accept`).set(bearer(d.accessToken)).expect(200);
    await request(app).post(`/api/v1/trips/${trip.id}/arrive`).set(bearer(d.accessToken)).expect(200);
    await request(app).post(`/api/v1/trips/${trip.id}/start`).set(bearer(d.accessToken)).send({ ridePin: trip.ridePin }).expect(200);
    const res = await request(app).post(`/api/v1/trips/${trip.id}/cancel`).set(bearer(d.accessToken)).send({}).expect(409);
    expect(res.body.error.code).toBe("INVALID_TRANSITION");
  });
});

describe("overtime at completion", () => {
  async function rideStartedAgo(extraSeconds: number) {
    const d = await onlineDriver(north(300));
    const rider = await register("customer");
    const trip = await book(rider);
    await request(app).post(`/api/v1/trips/${trip.id}/accept`).set(bearer(d.accessToken)).expect(200);
    await request(app).post(`/api/v1/trips/${trip.id}/arrive`).set(bearer(d.accessToken)).expect(200);
    await request(app).post(`/api/v1/trips/${trip.id}/start`).set(bearer(d.accessToken)).send({ ridePin: trip.ridePin }).expect(200);
    await withContext(SYSTEM, (db) => db.query(
      "UPDATE trips SET started_at = now() - make_interval(secs => est_duration_s + $2) WHERE id = $1",
      [trip.id, extraSeconds]));
    const done = await request(app).post(`/api/v1/trips/${trip.id}/complete`).set(bearer(d.accessToken)).expect(200);
    return { trip, done: done.body, driver: d };
  }

  it("on time: the rider pays the quote", async () => {
    const { trip, done } = await rideStartedAgo(-60);
    expect(done).toMatchObject({ finalFare: trip.fareEstimate, overtimeAmount: 0 });
  });

  it("10 minutes over: quote + 10 × per-minute rate (2 ETB)", async () => {
    const { trip, done } = await rideStartedAgo(10 * 60 - 5);
    expect(done.overtimeAmount).toBe(2000);
    expect(done.finalFare).toBe(trip.fareEstimate + 2000);
  });

  it("very long: capped at 25% of the quote, and commission is on the final fare", async () => {
    const { trip, done, driver } = await rideStartedAgo(3 * 3600);
    const cap = Math.floor((trip.fareEstimate * 0.25) / 100) * 100;
    expect(done.overtimeAmount).toBe(cap);
    const wallet = await request(app).get("/api/v1/users/me/wallet").set(bearer(driver.accessToken)).expect(200);
    expect(wallet.body.balance).toBe(1_000_000 - Math.round((trip.fareEstimate + cap) * 0.1));
  });

  it("the cap follows the admin setting", async () => {
    await withContext(SYSTEM, (db) => db.query("UPDATE app_settings SET value = '0' WHERE key = 'overtime_cap_bps'"));
    try {
      const { trip, done } = await rideStartedAgo(3600);
      expect(done).toMatchObject({ overtimeAmount: 0, finalFare: trip.fareEstimate });
    } finally {
      await withContext(SYSTEM, (db) => db.query("UPDATE app_settings SET value = '2500' WHERE key = 'overtime_cap_bps'"));
    }
  });
});

describe("sweeper", () => {
  it("drivers whose app stopped pinging are taken offline", async () => {
    const d = await onlineDriver(north(300));
    await redis.zadd("drivers:seen", Date.now() - 5 * 60_000, d.user.id); // last ping 5 min ago
    await sweepTrips();
    const me = await request(app).get("/api/v1/drivers/me").set(bearer(d.accessToken)).expect(200);
    expect(me.body.availability).toBe("offline");
    const trip = await book(await register("customer"));
    expect(await offersOf(d)).not.toContain(trip.id);
  });

  it("drivers stuck 'on trip' without an active trip are repaired", async () => {
    const d = await onlineDriver(north(300));
    await withContext(SYSTEM, (db) =>
      db.query("UPDATE driver_profiles SET availability = 'on_trip' WHERE user_id = $1", [d.user.id]));
    await sweepTrips();
    const me = await request(app).get("/api/v1/drivers/me").set(bearer(d.accessToken)).expect(200);
    expect(me.body.availability).toBe("online");
  });

  it("only one instance sweeps at a time", async () => {
    const d = await onlineDriver(north(300));
    await redis.zadd("drivers:seen", Date.now() - 5 * 60_000, d.user.id);
    await redis.set("sweep:lock", "another-instance", "PX", 4000);
    await sweepTrips(); // lock held elsewhere → does nothing
    const me = await request(app).get("/api/v1/drivers/me").set(bearer(d.accessToken)).expect(200);
    expect(me.body.availability).toBe("online");
  });

  it("searching trips expire 3 minutes after they (re-)entered searching", async () => {
    const rider = await register("customer");
    const trip = await book(rider);
    await withContext(SYSTEM, (db) =>
      db.query("UPDATE trips SET searching_since = now() - interval '4 minutes' WHERE id = $1", [trip.id]));
    await sweepTrips();
    const seen = await request(app).get(`/api/v1/trips/${trip.id}`).set(bearer(rider.accessToken)).expect(200);
    expect(seen.body.status).toBe("expired");
  });
});

describe("database guard on trips", () => {
  it("riders, drivers and staff can't jump a trip to 'completed' or change money fields", async () => {
    const d = await onlineDriver(north(300));
    const rider = await register("customer");
    const trip = await book(rider);
    await request(app).post(`/api/v1/trips/${trip.id}/accept`).set(bearer(d.accessToken)).expect(200);
    const staff = await makeBackoffice("staff");
    await grant(staff.id, ["trips.cancel"]);

    const attempts: [string, "customer" | "driver" | "staff", string][] = [
      [rider.user.id, "customer", "UPDATE trips SET status = 'completed' WHERE id = $1"],
      [d.user.id, "driver", "UPDATE trips SET status = 'completed' WHERE id = $1"],
      [d.user.id, "driver", "UPDATE trips SET status = 'searching' WHERE id = $1"],
      [staff.id, "staff", "UPDATE trips SET status = 'completed' WHERE id = $1"],
      [rider.user.id, "customer", "UPDATE trips SET commission_amount = 0 WHERE id = $1"],
      [d.user.id, "driver", "UPDATE trips SET overtime_amount = 99999 WHERE id = $1"],
      [rider.user.id, "customer", "UPDATE trips SET payment_method = 'wallet' WHERE id = $1"],
    ];
    for (const [userId, role, sql] of attempts) {
      await expect(withContext({ userId, role }, (db) => db.query(sql, [trip.id])), `${role}: ${sql}`)
        .rejects.toMatchObject({ code: "42501" });
    }
    // Allowed: the driver moves the trip forward.
    await withContext({ userId: d.user.id, role: "driver" }, (db) =>
      db.query("UPDATE trips SET status = 'arrived', arrived_at = now() WHERE id = $1", [trip.id]));
  });
});

describe("settings", () => {
  it("admins and pricing staff change the overtime cap; other staff can't", async () => {
    const admin = await makeBackoffice("admin");
    const token = (await request(app).post("/api/v1/auth/login")
      .send({ phone: admin.phone, password: PASSWORD, role: "admin", platform: "web" })).body.accessToken;
    await request(app).patch("/api/v1/admin/settings").set(bearer(token)).send({ overtimeCapBps: 2000 }).expect(200);
    expect((await request(app).get("/api/v1/admin/settings").set(bearer(token))).body).toMatchObject({ overtimeCapBps: 2000 });
    await request(app).patch("/api/v1/admin/settings").set(bearer(token)).send({ overtimeCapBps: 20000 }).expect(422);
    await request(app).patch("/api/v1/admin/settings").set(bearer(token)).send({ somethingElse: 1 }).expect(422);
    await request(app).patch("/api/v1/admin/settings").set(bearer(token)).send({ overtimeCapBps: 2500 }).expect(200);

    const staff = await makeBackoffice("staff");
    const staffToken = (await request(app).post("/api/v1/auth/login")
      .send({ phone: staff.phone, password: PASSWORD, role: "staff", platform: "web" })).body.accessToken;
    await request(app).patch("/api/v1/admin/settings").set(bearer(staffToken)).send({ overtimeCapBps: 0 }).expect(403);
  });
});
