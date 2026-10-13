import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createApp } from "../src/app.js";
import * as R from "../src/contract/responses.js";
import { SYSTEM, withContext } from "../src/db/context.js";
import { pool } from "../src/db/pool.js";
import { redis } from "../src/lib/redis.js";
import { BOLE, fundDriver, PASSWORD, PIASSA, randomPhone } from "./helpers.js";

/**
 * Real responses vs the documented response models (what the Dart client is
 * generated from). Fails on a missing/mistyped field AND on fields the
 * models don't document, so the spec can't silently fall behind the SQL.
 */

const app = createApp();
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

/** Parse with the model, and reject undocumented keys at every object level. */
function conforms(schema: z.ZodType, body: unknown, path = "body") {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new Error(`${path} doesn't match the model:\n${z.prettifyError(parsed.error)}`);
  const strict = (s: any): any => {
    const def = s?._zod?.def;
    if (!def) return s;
    switch (def.type) {
      case "object": return z.strictObject(Object.fromEntries(Object.entries(def.shape).map(([k, v]) => [k, strict(v)])));
      case "array": return z.array(strict(def.element));
      case "nullable": return strict(def.innerType).nullable();
      case "optional": return strict(def.innerType).optional();
      default: return s;
    }
  };
  const extra = strict(schema).safeParse(body);
  if (!extra.success) throw new Error(`${path} has fields the model doesn't document:\n${z.prettifyError(extra.error)}`);
}

let rider: any, driver: any;

beforeAll(async () => {
  await redis.flushdb();
  await withContext(SYSTEM, (db) =>
    db.query("UPDATE trips SET status = 'cancelled' WHERE status IN ('searching','accepted','arrived','in_progress')"));
});
afterAll(async () => {
  await pool.end();
  redis.disconnect();
});

describe("responses match the documented models", () => {
  it("auth", async () => {
    const reg = await request(app).post("/api/v1/auth/register")
      .send({ phone: randomPhone(), password: PASSWORD, platform: "android", fullName: "Contract Rider" }).expect(201);
    conforms(R.AuthSession, reg.body, "POST /auth/register");
    rider = reg.body;

    const login = await request(app).post("/api/v1/auth/login")
      .send({ phone: rider.user.phone, password: PASSWORD, platform: "android" }).expect(200);
    conforms(R.AuthSession, login.body, "POST /auth/login");

    const refreshed = await request(app).post("/api/v1/auth/refresh").send({ refreshToken: login.body.refreshToken }).expect(200);
    conforms(R.TokenPair, refreshed.body, "POST /auth/refresh");

    const err = await request(app).post("/api/v1/auth/login")
      .send({ phone: rider.user.phone, password: "wrong-password", platform: "android" }).expect(401);
    conforms(R.ErrorBody, err.body, "error body");
  });

  it("me, wallet, catalog", async () => {
    conforms(R.User, (await request(app).get("/api/v1/users/me").set(bearer(rider.accessToken)).expect(200)).body, "GET /users/me");
    conforms(R.User, (await request(app).patch("/api/v1/users/me").set(bearer(rider.accessToken))
      .send({ locale: "en" }).expect(200)).body, "PATCH /users/me");
    conforms(R.Wallet, (await request(app).get("/api/v1/users/me/wallet").set(bearer(rider.accessToken)).expect(200)).body, "GET /users/me/wallet");
    conforms(z.object({ data: z.array(R.VehicleCategory) }),
      (await request(app).get("/api/v1/catalog/vehicle-categories").expect(200)).body, "GET /catalog/vehicle-categories");
  });

  it("a full ride: driver, estimate, trip, offers, lifecycle", async () => {
    const d = await request(app).post("/api/v1/auth/register")
      .send({ phone: randomPhone(), password: PASSWORD, role: "driver", platform: "android" }).expect(201);
    driver = d.body;
    await request(app).put("/api/v1/drivers/me/profile").set(bearer(driver.accessToken))
      .send({ licenseNumber: "AA-1", licenseExpiresOn: "2030-01-01" }).expect(204);
    const v = await request(app).post("/api/v1/drivers/me/vehicles").set(bearer(driver.accessToken))
      .send({ categoryCode: "economy", plateNumber: `C-${randomUUID().slice(0, 6)}`, make: "Toyota", model: "Vitz", color: "Red" }).expect(201);
    conforms(R.Created, v.body, "POST /drivers/me/vehicles");
    await withContext(SYSTEM, async (db) => {
      await db.query("UPDATE driver_profiles SET approval_status = 'approved' WHERE user_id = $1", [driver.user.id]);
      await db.query("UPDATE vehicles SET status = 'approved', is_current = true WHERE id = $1", [v.body.id]);
    });
    await fundDriver(driver.user.id);

    const me = await request(app).get("/api/v1/drivers/me").set(bearer(driver.accessToken)).expect(200);
    conforms(R.DriverMe, me.body, "GET /drivers/me");
    expect(me.body.licenseExpiresOn).toBe("2030-01-01"); // calendar date, not shifted by time zone

    conforms(R.Availability, (await request(app).post("/api/v1/drivers/me/online").set(bearer(driver.accessToken))
      .send({ location: { lat: BOLE.lat + 0.002, lng: BOLE.lng } }).expect(200)).body, "POST /drivers/me/online");

    const est = await request(app).post("/api/v1/trips/estimate").set(bearer(rider.accessToken))
      .send({ pickup: BOLE, dropoff: PIASSA }).expect(200);
    conforms(R.Estimate, est.body, "POST /trips/estimate");

    const created = await request(app).post("/api/v1/trips").set(bearer(rider.accessToken)).send({
      clientRequestId: randomUUID(), categoryCode: "economy",
      pickup: { ...BOLE, address: "Bole" }, dropoff: PIASSA,
    }).expect(201);
    conforms(R.Trip, created.body, "POST /trips");
    const tripId = created.body.id;

    const offers = await request(app).get("/api/v1/drivers/me/offers").set(bearer(driver.accessToken)).expect(200);
    conforms(z.object({ data: z.array(R.TripOffer) }), offers.body, "GET /drivers/me/offers");
    expect(offers.body.data[0].etaToPickupS).toBeGreaterThan(0);

    const steps: [string, unknown?][] = [["accept"], ["arrive"], ["start", { ridePin: created.body.ridePin }], ["complete"]];
    for (const [step, body] of steps) {
      const res = await request(app).post(`/api/v1/trips/${tripId}/${step}`).set(bearer(driver.accessToken)).send(body ?? {}).expect(200);
      conforms(R.Trip, res.body, `POST /trips/:id/${step}`);
    }

    const detail = await request(app).get(`/api/v1/trips/${tripId}`).set(bearer(rider.accessToken)).expect(200);
    conforms(R.TripDetail, detail.body, "GET /trips/:id");
    expect(detail.body.driver).not.toBeNull();

    conforms(R.TripPage, (await request(app).get("/api/v1/trips").set(bearer(rider.accessToken)).expect(200)).body, "GET /trips");
    conforms(R.Ok, (await request(app).post(`/api/v1/trips/${tripId}/rate`).set(bearer(rider.accessToken))
      .send({ score: 5 }).expect(201)).body, "POST /trips/:id/rate");
    conforms(R.Availability, (await request(app).post("/api/v1/drivers/me/offline").set(bearer(driver.accessToken)).expect(200)).body,
      "POST /drivers/me/offline");
  });
});
