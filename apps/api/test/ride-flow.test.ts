import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { SYSTEM, withContext } from "../src/db/context.js";
import { pool } from "../src/db/pool.js";
import { redis } from "../src/lib/redis.js";
import { BOLE, getOtpCode, makeBackoffice, makeLegacyUser, PASSWORD, PIASSA, randomPhone, uploadRequiredDocuments } from "./helpers.js";

const app = createApp();

type Session = { accessToken: string; refreshToken: string; user: { id: string } };

async function register(phone: string, role: "customer" | "driver"): Promise<Session> {
  const code = await getOtpCode(phone);
  const res = await request(app).post("/api/v1/auth/register")
    .send({ phone, code, password: PASSWORD, role, platform: "android" }).expect(201);
  return res.body;
}

async function login(phone: string, role: "customer" | "driver" | "admin"): Promise<Session> {
  const res = await request(app).post("/api/v1/auth/login")
    .send({ phone, password: PASSWORD, role, platform: "android" }).expect(200);
  return res.body;
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

let customer: Session;
let driver: Session;
let admin: Session;

beforeAll(async () => {
  await redis.flushdb();
  const { phone: adminPhone } = await makeBackoffice("admin");
  // Local Ethiopian formats are accepted and normalised.
  const local = `0${randomPhone().slice(4)}`;
  [customer, driver, admin] = await Promise.all([
    register(local, "customer"), register(randomPhone(), "driver"), login(adminPhone, "admin"),
  ]);
});

afterAll(async () => {
  await pool.end();
  redis.disconnect();
});

describe("auth", () => {
  it("rotates refresh tokens and detects reuse", async () => {
    const first = await request(app).post("/api/v1/auth/refresh")
      .send({ refreshToken: customer.refreshToken }).expect(200);
    // Replaying the old token revokes the session...
    await request(app).post("/api/v1/auth/refresh").send({ refreshToken: customer.refreshToken }).expect(401);
    // ...so the newly issued one is dead too.
    await request(app).post("/api/v1/auth/refresh").send({ refreshToken: first.body.refreshToken }).expect(401);
  });

  it("role checks return 403 with a stable error code", async () => {
    const res = await request(app).get("/api/v1/admin/stats").set(bearer(customer.accessToken)).expect(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });
});

describe("full ride", () => {
  let tripId: string;
  let ridePin: string;
  let fare: number;

  it("driver onboarding: profile, vehicle, documents, admin approval, deposit, go online", async () => {
    const d = bearer(driver.accessToken);
    await request(app).put("/api/v1/drivers/me/profile").set(d)
      .send({ licenseNumber: "AA-123456", licenseExpiresOn: "2030-01-01" }).expect(204);
    const v = await request(app).post("/api/v1/drivers/me/vehicles").set(d)
      .send({ categoryCode: "economy", plateNumber: `3-A${Date.now() % 100000}`, make: "Toyota",
              model: "Vitz", color: "Blue" }).expect(201);

    // Not approved yet
    const blocked = await request(app).post("/api/v1/drivers/me/online").set(d).send({ location: BOLE });
    expect(blocked.body.error.code).toBe("DRIVER_NOT_APPROVED");

    // Approval needs the documents first.
    const early = await request(app).post(`/api/v1/admin/drivers/${driver.user.id}/review`).set(bearer(admin.accessToken))
      .send({ decision: "approved", vehicleId: v.body.id }).expect(422);
    expect(early.body.error.code).toBe("DOCUMENTS_INCOMPLETE");
    expect(early.body.error.details.missing).toHaveLength(5);

    const docs = await uploadRequiredDocuments(app, driver.accessToken, v.body.id);
    for (const id of docs) {
      await request(app).post(`/api/v1/admin/documents/${id}/review`).set(bearer(admin.accessToken))
        .send({ decision: "approved" }).expect(200);
    }
    await request(app).post(`/api/v1/admin/drivers/${driver.user.id}/review`).set(bearer(admin.accessToken))
      .send({ decision: "approved", vehicleId: v.body.id }).expect(200);

    // Approved, but no deposit yet.
    const unfunded = await request(app).post("/api/v1/drivers/me/online").set(d).send({ location: BOLE }).expect(402);
    expect(unfunded.body.error.code).toBe("DEPOSIT_REQUIRED");

    // Driver pays 10,000 ETB at the office; staff record it.
    await request(app).post(`/api/v1/admin/drivers/${driver.user.id}/deposits`).set(bearer(admin.accessToken))
      .send({ amount: 1_000_000, reference: "RCPT-001" }).expect(201);

    // Driver is ~300 m from the pickup
    await request(app).post("/api/v1/drivers/me/online").set(d)
      .send({ location: { lat: BOLE.lat + 0.002, lng: BOLE.lng + 0.002 } }).expect(200);
  });

  it("customer gets an estimate", async () => {
    const res = await request(app).post("/api/v1/trips/estimate").set(bearer(customer.accessToken))
      .send({ pickup: BOLE, dropoff: PIASSA }).expect(200);
    const economy = res.body.options.find((o: any) => o.categoryCode === "economy");
    expect(economy.driversNearby).toBe(true);
    expect(res.body.routeSource).toBe("estimate"); // no Gebeta key in tests
    fare = economy.fare;
  });

  it("rejects pickups outside the operating zone", async () => {
    const res = await request(app).post("/api/v1/trips/estimate").set(bearer(customer.accessToken))
      .send({ pickup: { lat: 7.05, lng: 38.47 } /* Hawassa */, dropoff: PIASSA }).expect(422);
    expect(res.body.error.code).toBe("OUT_OF_SERVICE_AREA");
  });

  it("customer books; a retry with the same key returns the same trip", async () => {
    const body = {
      clientRequestId: randomUUID(), categoryCode: "economy", paymentMethod: "cash",
      pickup: { ...BOLE, address: "Bole Medhanialem" }, dropoff: { ...PIASSA, address: "Piassa" },
    };
    const res = await request(app).post("/api/v1/trips").set(bearer(customer.accessToken)).send(body).expect(201);
    expect(res.body.status).toBe("searching");
    expect(res.body.fareEstimate).toBe(fare);
    tripId = res.body.id;
    ridePin = res.body.ridePin;

    const retry = await request(app).post("/api/v1/trips").set(bearer(customer.accessToken)).send(body).expect(200);
    expect(retry.body.id).toBe(tripId);

    const second = await request(app).post("/api/v1/trips").set(bearer(customer.accessToken))
      .send({ ...body, clientRequestId: randomUUID() }).expect(409);
    expect(second.body.error.code).toBe("ACTIVE_TRIP_EXISTS");
  });

  it("dispatch offered the trip to the nearby driver, who accepts", async () => {
    const d = bearer(driver.accessToken);
    const offers = await request(app).get("/api/v1/drivers/me/offers").set(d).expect(200);
    expect(offers.body.data.map((o: any) => o.tripId)).toContain(tripId);

    // Driver sees the trip but not the PIN
    const peek = await request(app).get(`/api/v1/trips/${tripId}`).set(d).expect(200);
    expect(peek.body.ridePin).toBeUndefined();

    const res = await request(app).post(`/api/v1/trips/${tripId}/accept`).set(d).expect(200);
    expect(res.body.status).toBe("accepted");
    expect(res.body.driverId).toBe(driver.user.id);
  });

  it("customer now sees driver and vehicle details", async () => {
    const res = await request(app).get(`/api/v1/trips/${tripId}`).set(bearer(customer.accessToken)).expect(200);
    expect(res.body.driver.vehicle.make).toBe("Toyota");
    expect(res.body.ridePin).toBe(ridePin);
  });

  it("arrive → start (PIN checked) → complete", async () => {
    const d = bearer(driver.accessToken);
    await request(app).post(`/api/v1/trips/${tripId}/start`).set(d).send({ ridePin }).expect(409); // not arrived
    await request(app).post(`/api/v1/trips/${tripId}/arrive`).set(d).expect(200);

    const wrongPin = ridePin === "0000" ? "1111" : "0000";
    const bad = await request(app).post(`/api/v1/trips/${tripId}/start`).set(d).send({ ridePin: wrongPin }).expect(422);
    expect(bad.body.error.code).toBe("WRONG_RIDE_PIN");

    await request(app).post(`/api/v1/trips/${tripId}/start`).set(d).send({ ridePin }).expect(200);
    const done = await request(app).post(`/api/v1/trips/${tripId}/complete`).set(d).expect(200);
    expect(done.body.status).toBe("completed");
    expect(done.body.finalFare).toBe(fare);
    expect(done.body.paymentStatus).toBe("paid");
  });

  it("cash trip: 10% commission debited from the driver's deposit", async () => {
    const res = await request(app).get("/api/v1/users/me/wallet").set(bearer(driver.accessToken)).expect(200);
    expect(res.body.balance).toBe(1_000_000 - Math.round(fare * 0.1));
    expect(res.body.transactions[0].kind).toBe("commission");
  });

  it("both sides can rate once; strangers cannot", async () => {
    await request(app).post(`/api/v1/trips/${tripId}/rate`).set(bearer(customer.accessToken))
      .send({ score: 5 }).expect(201);
    const dup = await request(app).post(`/api/v1/trips/${tripId}/rate`).set(bearer(customer.accessToken))
      .send({ score: 1 }).expect(409);
    expect(dup.body.error.code).toBe("ALREADY_EXISTS");
    await request(app).post(`/api/v1/trips/${tripId}/rate`).set(bearer(driver.accessToken))
      .send({ score: 4 }).expect(201);
    const stranger = await register(randomPhone(), "customer");
    await request(app).post(`/api/v1/trips/${tripId}/rate`).set(bearer(stranger.accessToken))
      .send({ score: 1 }).expect(404);
  });
});

describe("phone verification route gating and active trip immunity", () => {
  it("unverified customer cannot create trips (403 PHONE_NOT_VERIFIED), and no trip is created", async () => {
    const unverifiedCustomer = await makeLegacyUser("customer");
    const loginRes = await request(app).post("/api/v1/auth/login")
      .send({ phone: unverifiedCustomer.phone, password: PASSWORD, role: "customer", platform: "android" }).expect(200);
    const token = loginRes.body.accessToken;

    const res = await request(app).post("/api/v1/trips").set(bearer(token)).send({
      clientRequestId: randomUUID(), categoryCode: "economy", paymentMethod: "cash",
      pickup: { ...BOLE, address: "Bole" }, dropoff: { ...PIASSA, address: "Piassa" },
    }).expect(403);
    expect(res.body.error.code).toBe("PHONE_NOT_VERIFIED");

    // Verify no trip was created in database
    await withContext(SYSTEM, async (db) => {
      const { rows } = await db.query("SELECT * FROM trips WHERE customer_id = $1", [unverifiedCustomer.id]);
      expect(rows.length).toBe(0);
    });

    // Safe read operations remain accessible
    await request(app).post("/api/v1/trips/estimate").set(bearer(token)).send({ pickup: BOLE, dropoff: PIASSA }).expect(200);
    await request(app).get("/api/v1/trips").set(bearer(token)).expect(200);
    await request(app).get("/api/v1/users/me/wallet").set(bearer(token)).expect(200);
  });

  it("existing assigned driver with unverified phone can continue GPS tracking and finish an assigned trip", async () => {
    // Verified customer creates a trip
    const rider = await register(randomPhone(), "customer");
    const tripRes = await request(app).post("/api/v1/trips").set(bearer(rider.accessToken)).send({
      clientRequestId: randomUUID(), categoryCode: "economy", paymentMethod: "cash",
      pickup: { ...BOLE, address: "Bole" }, dropoff: { ...PIASSA, address: "Piassa" },
    }).expect(201);
    const assignedTripId = tripRes.body.id;
    const assignedPin = tripRes.body.ridePin;

    // Create an unverified driver
    const unverifiedDriver = await makeLegacyUser("driver");
    await withContext(SYSTEM, async (db) => {
      await db.query("UPDATE driver_profiles SET approval_status = 'approved' WHERE user_id = $1", [unverifiedDriver.id]);
      await db.query(
        `INSERT INTO vehicles (driver_id, category_code, plate_number, make, model, color, status, is_current)
         VALUES ($1, 'economy', $2, 'Toyota', 'Yaris', 'White', 'approved', true)`,
        [unverifiedDriver.id, `T-${randomUUID().slice(0, 8)}`],
      );
      // Directly assign the driver to simulate an in-progress trip that started prior to CP1.4 deployment
      await db.query(
        "UPDATE trips SET status = 'accepted', driver_id = $1 WHERE id = $2",
        [unverifiedDriver.id, assignedTripId],
      );
    });

    const driverLogin = await request(app).post("/api/v1/auth/login")
      .send({ phone: unverifiedDriver.phone, password: PASSWORD, role: "driver", platform: "android" }).expect(200);
    const driverToken = driverLogin.body.accessToken;

    // Driver can continue GPS tracking
    await request(app).post("/api/v1/drivers/me/location")
      .set(bearer(driverToken))
      .send({ lat: BOLE.lat, lng: BOLE.lng, heading: 90 })
      .expect(204);

    // Driver can mark arrive
    await request(app).post(`/api/v1/trips/${assignedTripId}/arrive`)
      .set(bearer(driverToken))
      .expect(200);

    // Driver can start trip with PIN
    await request(app).post(`/api/v1/trips/${assignedTripId}/start`)
      .set(bearer(driverToken))
      .send({ ridePin: assignedPin })
      .expect(200);

    // Driver can complete trip
    const completed = await request(app).post(`/api/v1/trips/${assignedTripId}/complete`)
      .set(bearer(driverToken))
      .expect(200);
    expect(completed.body.status).toBe("completed");
  });
});
