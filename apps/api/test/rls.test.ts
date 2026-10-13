import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SYSTEM, withContext, type DbContext } from "../src/db/context.js";
import { pool } from "../src/db/pool.js";
import { redis } from "../src/lib/redis.js";
import { makeUser } from "./helpers.js";

/**
 * These tests talk to Postgres as the runtime role (simpleride_app) and try
 * to break the policies directly in SQL, i.e. assuming the API layer has a
 * bug. If any of these fail, data is exposed regardless of route checks.
 */

let alice: string, bob: string, driver: string, otherDriver: string, admin: string;
let aliceTrip: string;

const as = (userId: string, role: DbContext["role"]): DbContext => ({ userId, role });
const q = (ctx: DbContext, sql: string, params: unknown[] = []) =>
  withContext(ctx, (db) => db.query(sql, params));

beforeAll(async () => {
  [alice, bob, driver, otherDriver, admin] = await Promise.all([
    makeUser("customer"), makeUser("customer"), makeUser("driver"), makeUser("driver"), makeUser("admin"),
  ]);
  const { rows } = await q(
    as(alice, "customer"),
    `INSERT INTO trips (client_request_id, customer_id, category_code, pickup, dropoff, fare_estimate)
     VALUES (gen_random_uuid(), app.uid(), 'economy',
             ST_MakePoint(38.79, 8.99)::geography, ST_MakePoint(38.75, 9.03)::geography, 20000)
     RETURNING id`,
  );
  aliceTrip = rows[0].id;
});

afterAll(async () => {
  await withContext(SYSTEM, (db) =>
    db.query("UPDATE trips SET status = 'cancelled' WHERE id = $1", [aliceTrip]),
  );
  await pool.end();
  redis.disconnect();
});

describe("connection role", () => {
  it("runtime role cannot bypass RLS", async () => {
    const { rows } = await pool.query(
      "SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user",
    );
    expect(rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });
  });

  it("context does not leak across pooled connections", async () => {
    await q(as(alice, "customer"), "SELECT 1");
    const { rows } = await pool.query("SELECT current_setting('app.user_id', true) AS uid");
    expect(rows[0].uid ?? "").toBe("");
  });
});

describe("users", () => {
  it("anonymous sees no users", async () => {
    const { rowCount } = await q({ userId: null, role: "anonymous" }, "SELECT 1 FROM users");
    expect(rowCount).toBe(0);
  });

  it("customer sees only themselves", async () => {
    const { rows } = await q(as(alice, "customer"), "SELECT id FROM users");
    expect(rows.map((r) => r.id)).toEqual([alice]);
  });

  it("customer cannot promote themselves to admin", async () => {
    await expect(
      q(as(alice, "customer"), "UPDATE users SET role = 'admin' WHERE id = app.uid()"),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("customer cannot update someone else", async () => {
    const { rowCount } = await q(as(alice, "customer"), "UPDATE users SET full_name = 'x' WHERE id = $1", [bob]);
    expect(rowCount).toBe(0);
  });

  it("customer cannot create accounts", async () => {
    await expect(
      q(as(alice, "customer"), "INSERT INTO users (phone, role) VALUES ('+251911000001', 'admin')"),
    ).rejects.toThrow(/row-level security/);
  });

  it("admin sees everyone", async () => {
    const { rows } = await q(as(admin, "admin"), "SELECT id FROM users WHERE id = ANY($1)", [[alice, bob, driver]]);
    expect(rows).toHaveLength(3);
  });
});

describe("trips", () => {
  it("other customers cannot see the trip", async () => {
    const { rowCount } = await q(as(bob, "customer"), "SELECT 1 FROM trips WHERE id = $1", [aliceTrip]);
    expect(rowCount).toBe(0);
  });

  it("a driver cannot see a trip they were not offered", async () => {
    const { rowCount } = await q(as(driver, "driver"), "SELECT 1 FROM trips WHERE id = $1", [aliceTrip]);
    expect(rowCount).toBe(0);
  });

  it("a driver can see a trip once offered it", async () => {
    await withContext(SYSTEM, (db) =>
      db.query(
        "INSERT INTO trip_offers (trip_id, driver_id, expires_at) VALUES ($1, $2, now() + interval '1 min')",
        [aliceTrip, driver],
      ),
    );
    const { rowCount } = await q(as(driver, "driver"), "SELECT 1 FROM trips WHERE id = $1", [aliceTrip]);
    expect(rowCount).toBe(1);
    const other = await q(as(otherDriver, "driver"), "SELECT 1 FROM trips WHERE id = $1", [aliceTrip]);
    expect(other.rowCount).toBe(0);
  });

  it("a driver cannot self-assign a trip", async () => {
    const { rowCount } = await q(
      as(driver, "driver"), "UPDATE trips SET driver_id = app.uid() WHERE id = $1", [aliceTrip],
    );
    expect(rowCount).toBe(0); // not a party yet, so the row is invisible to UPDATE
  });

  it("a driver cannot accept their offer directly", async () => {
    await expect(
      q(as(driver, "driver"), "UPDATE trip_offers SET status = 'accepted' WHERE trip_id = $1", [aliceTrip]),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("the customer cannot change their fare", async () => {
    await expect(
      q(as(alice, "customer"), "UPDATE trips SET fare_estimate = 1 WHERE id = $1", [aliceTrip]),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("a customer cannot book on someone else's behalf", async () => {
    await expect(
      q(
        as(alice, "customer"),
        `INSERT INTO trips (client_request_id, customer_id, category_code, pickup, dropoff, fare_estimate)
         VALUES (gen_random_uuid(), $1, 'economy', ST_MakePoint(38.79, 8.99)::geography,
                 ST_MakePoint(38.75, 9.03)::geography, 100)`,
        [bob],
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("a driver account cannot book trips", async () => {
    await expect(
      q(
        as(driver, "driver"),
        `INSERT INTO trips (client_request_id, customer_id, category_code, pickup, dropoff, fare_estimate)
         VALUES (gen_random_uuid(), app.uid(), 'economy', ST_MakePoint(38.79, 8.99)::geography,
                 ST_MakePoint(38.75, 9.03)::geography, 100)`,
      ),
    ).rejects.toThrow(/row-level security/);
  });
});

describe("money", () => {
  it("users cannot credit their own wallet", async () => {
    const { rowCount } = await q(as(alice, "customer"), "UPDATE wallets SET balance = 1000000 WHERE user_id = app.uid()");
    expect(rowCount).toBe(0);
    await expect(
      q(as(alice, "customer"),
        "INSERT INTO wallet_transactions (user_id, amount, balance_after, kind) VALUES (app.uid(), 100, 100, 'topup')"),
    ).rejects.toThrow(/row-level security/);
  });

  it("users cannot read other wallets", async () => {
    const { rowCount } = await q(as(alice, "customer"), "SELECT 1 FROM wallets WHERE user_id = $1", [bob]);
    expect(rowCount).toBe(0);
  });
});

describe("drivers and fleet", () => {
  it("a driver cannot approve themselves", async () => {
    await expect(
      q(as(driver, "driver"), "UPDATE driver_profiles SET approval_status = 'approved' WHERE user_id = app.uid()"),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("a driver cannot register an already-approved vehicle", async () => {
    await expect(
      q(as(driver, "driver"),
        `INSERT INTO vehicles (driver_id, category_code, plate_number, make, model, color, status)
         VALUES (app.uid(), 'economy', 'RLS-' || floor(random()*1e6), 'Toyota', 'Vitz', 'White', 'approved')`),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("only admins edit fares", async () => {
    const { rowCount } = await q(as(alice, "customer"), "UPDATE vehicle_categories SET base_fare = 0");
    expect(rowCount).toBe(0);
    const { rows } = await q({ userId: null, role: "anonymous" }, "SELECT code FROM vehicle_categories");
    expect(rows.length).toBeGreaterThan(0); // but everyone can read them
  });

  it("audit log is admin-only", async () => {
    const { rowCount } = await q(as(alice, "customer"), "SELECT 1 FROM audit_logs");
    expect(rowCount).toBe(0);
  });
});
