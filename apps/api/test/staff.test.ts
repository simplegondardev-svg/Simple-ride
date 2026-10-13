import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { PERMISSIONS } from "../src/auth/permissions.js";
import { SYSTEM, withContext, type DbContext } from "../src/db/context.js";
import { pool } from "../src/db/pool.js";
import { redis } from "../src/lib/redis.js";
import { grant, makeUser, randomPhone } from "./helpers.js";

const app = createApp();
const as = (userId: string, role: DbContext["role"]): DbContext => ({ userId, role });
const q = (ctx: DbContext, sql: string, params: unknown[] = []) =>
  withContext(ctx, (db) => db.query(sql, params));
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function login(phone: string, role: "customer" | "driver" | "admin" | "staff") {
  const otp = await request(app).post("/api/v1/auth/otp/request").send({ phone }).expect(202);
  return request(app)
    .post("/api/v1/auth/otp/verify")
    .send({ phone, code: otp.body.devCode, role, platform: "web" });
}

let admin: string, staff: string, customer: string, driver: string, otherStaff: string;
let trip: string;

beforeAll(async () => {
  [admin, staff, customer, driver, otherStaff] = await Promise.all([
    makeUser("admin"), makeUser("staff"), makeUser("customer"), makeUser("driver"), makeUser("staff"),
  ]);
  const { rows } = await q(
    as(customer, "customer"),
    `INSERT INTO trips (client_request_id, customer_id, category_code, pickup, dropoff, fare_estimate)
     VALUES (gen_random_uuid(), app.uid(), 'economy',
             ST_MakePoint(38.79, 8.99)::geography, ST_MakePoint(38.75, 9.03)::geography, 20000)
     RETURNING id`,
  );
  trip = rows[0].id;
});

afterAll(async () => {
  await withContext(SYSTEM, (db) => db.query("UPDATE trips SET status = 'cancelled' WHERE id = $1", [trip]));
  await pool.end();
  redis.disconnect();
});

describe("permission catalog", () => {
  it("code and database list the same permissions", async () => {
    const { rows } = await q(SYSTEM, "SELECT code FROM permissions ORDER BY code");
    expect(rows.map((r) => r.code)).toEqual([...PERMISSIONS].sort());
  });
});

describe("RLS: staff see only what they were granted", () => {
  it("staff with no permissions see no trips, people or money", async () => {
    await grant(staff, []);
    for (const table of ["trips", "wallets", "wallet_transactions", "driver_profiles", "audit_logs"]) {
      const { rowCount } = await q(as(staff, "staff"), `SELECT 1 FROM ${table}`);
      expect(rowCount, table).toBe(0);
    }
    const { rows } = await q(as(staff, "staff"), "SELECT id FROM users");
    expect(rows.map((r) => r.id)).toEqual([staff]); // only themselves
  });

  it("trips.view reveals trips and riders, but never admin or staff accounts", async () => {
    await grant(staff, ["trips.view"]);
    const t = await q(as(staff, "staff"), "SELECT 1 FROM trips WHERE id = $1", [trip]);
    expect(t.rowCount).toBe(1);
    const people = await q(as(staff, "staff"), "SELECT id FROM users WHERE id = ANY($1)", [[customer, admin, otherStaff]]);
    expect(people.rows.map((r) => r.id)).toEqual([customer]);
  });

  it("revoking takes effect on the next transaction", async () => {
    await grant(staff, []);
    const { rowCount } = await q(as(staff, "staff"), "SELECT 1 FROM trips WHERE id = $1", [trip]);
    expect(rowCount).toBe(0);
  });

  it("staff cannot grant themselves permissions", async () => {
    await expect(
      q(as(staff, "staff"), "INSERT INTO staff_permissions (user_id, permission) VALUES (app.uid(), 'audit.view')"),
    ).rejects.toThrow(/row-level security/);
  });

  it("forging app.permissions mid-transaction is the app's trust boundary, so init_context resets it", async () => {
    await grant(staff, []);
    // A fresh transaction always starts from the database's list, not a leftover value.
    const { rows } = await q(as(staff, "staff"), "SELECT current_setting('app.permissions', true) AS p");
    expect(rows[0].p).toBe("");
  });

  it("users.suspend works on riders, not on admins or other staff", async () => {
    await grant(staff, ["users.suspend"]);
    const ok = await q(as(staff, "staff"), "UPDATE users SET status = 'suspended' WHERE id = $1", [customer]);
    expect(ok.rowCount).toBe(1);
    await q(as(staff, "staff"), "UPDATE users SET status = 'active' WHERE id = $1", [customer]);
    for (const target of [admin, otherStaff]) {
      const { rowCount } = await q(as(staff, "staff"), "UPDATE users SET status = 'suspended' WHERE id = $1", [target]);
      expect(rowCount).toBe(0);
    }
  });

  it("users.suspend still cannot change someone's role", async () => {
    await grant(staff, ["users.suspend"]);
    await expect(
      q(as(staff, "staff"), "UPDATE users SET role = 'admin' WHERE id = $1", [customer]),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("drivers.approve can approve but not touch ratings; without it, no approval", async () => {
    await grant(staff, ["drivers.view"]);
    await expect(
      q(as(staff, "staff"), "UPDATE driver_profiles SET approval_status = 'approved' WHERE user_id = $1", [driver]),
    ).resolves.toMatchObject({ rowCount: 0 }); // visible but not updatable without drivers.approve

    await grant(staff, ["drivers.approve"]);
    const ok = await q(as(staff, "staff"),
      "UPDATE driver_profiles SET approval_status = 'approved' WHERE user_id = $1", [driver]);
    expect(ok.rowCount).toBe(1);
    await expect(
      q(as(staff, "staff"), "UPDATE driver_profiles SET rating_avg = 1.5 WHERE user_id = $1", [driver]),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("finance.wallets.adjust can only write 'adjustment' entries signed by themselves", async () => {
    await grant(staff, ["finance.wallets.adjust"]);
    await expect(
      q(as(staff, "staff"),
        "INSERT INTO wallet_transactions (user_id, amount, balance_after, kind, created_by) VALUES ($1, 100, 100, 'topup', app.uid())",
        [customer]),
    ).rejects.toThrow(/row-level security/);
  });

  it("a suspended account is rejected on its next transaction", async () => {
    await withContext(SYSTEM, (db) => db.query("UPDATE users SET status = 'suspended' WHERE id = $1", [otherStaff]));
    await expect(q(as(otherStaff, "staff"), "SELECT 1")).rejects.toMatchObject({ code: "28000" });
    await withContext(SYSTEM, (db) => db.query("UPDATE users SET status = 'active' WHERE id = $1", [otherStaff]));
  });

  it("a token whose role doesn't match the account is rejected", async () => {
    await expect(q(as(staff, "admin"), "SELECT 1")).rejects.toMatchObject({ code: "28000" });
  });

  it("permissions can only be held by staff accounts", async () => {
    await expect(
      withContext(SYSTEM, (db) =>
        db.query("INSERT INTO staff_permissions (user_id, permission) VALUES ($1, 'audit.view')", [customer])),
    ).rejects.toThrow(/only be granted to staff/);
  });
});

describe("HTTP: admin manages staff, staff use what they're given", () => {
  let adminToken: string;
  let staffToken: string;
  let staffId: string;
  const staffPhone = randomPhone();

  beforeAll(async () => {
    const adminPhone = randomPhone();
    await withContext(SYSTEM, (db) =>
      db.query("INSERT INTO users (phone, role) VALUES ($1, 'admin')", [adminPhone]));
    adminToken = (await login(adminPhone, "admin")).body.accessToken;
  });

  it("staff can't self-register through OTP", async () => {
    const res = await login(randomPhone(), "staff");
    expect(res.status).toBe(403);
  });

  it("admin creates a staff member with only the day book", async () => {
    const res = await request(app).post("/api/v1/admin/staff").set(bearer(adminToken))
      .send({ phone: `0${staffPhone.slice(4)}`, fullName: "Hana Finance", permissions: ["finance.daybook.view"] })
      .expect(201);
    staffId = res.body.id;
    expect(res.body.permissions).toEqual(["finance.daybook.view"]);

    const bad = await request(app).post("/api/v1/admin/staff").set(bearer(adminToken))
      .send({ phone: randomPhone(), fullName: "X Y", permissions: ["everything.please"] });
    expect(bad.status).toBe(422);
  });

  it("staff logs in and sees exactly their permissions", async () => {
    const res = await login(staffPhone, "staff");
    expect(res.status).toBe(200);
    staffToken = res.body.accessToken;
    const me = await request(app).get("/api/v1/admin/me").set(bearer(staffToken)).expect(200);
    expect(me.body).toEqual({ role: "staff", permissions: ["finance.daybook.view"] });
  });

  it("day book allowed; trips and dashboard refused with MISSING_PERMISSION", async () => {
    const book = await request(app).get("/api/v1/admin/finance/daybook").set(bearer(staffToken)).expect(200);
    expect(book.body.timezone).toBe("Africa/Addis_Ababa");
    for (const path of ["/api/v1/admin/trips", "/api/v1/admin/stats", "/api/v1/admin/users"]) {
      const res = await request(app).get(path).set(bearer(staffToken)).expect(403);
      expect(res.body.error.code).toBe("MISSING_PERMISSION");
    }
  });

  it("staff cannot manage staff, even their own permissions", async () => {
    await request(app).get("/api/v1/admin/staff").set(bearer(staffToken)).expect(403);
    await request(app).put(`/api/v1/admin/staff/${staffId}/permissions`).set(bearer(staffToken))
      .send({ permissions: [...PERMISSIONS] }).expect(403);
  });

  it("admin toggles permissions; the same token picks them up immediately", async () => {
    await request(app).put(`/api/v1/admin/staff/${staffId}/permissions`).set(bearer(adminToken))
      .send({ permissions: ["trips.view", "finance.wallets.adjust"] }).expect(200);
    await request(app).get("/api/v1/admin/trips").set(bearer(staffToken)).expect(200);
    await request(app).get("/api/v1/admin/finance/daybook").set(bearer(staffToken)).expect(403);
  });

  it("wallet adjustment shows up in the day book and the audit log", async () => {
    await request(app).post(`/api/v1/admin/wallets/${customer}/adjust`).set(bearer(staffToken))
      .send({ amount: 5000, reason: "Goodwill credit for a late driver" }).expect(200);

    const book = await request(app).get("/api/v1/admin/finance/daybook").set(bearer(adminToken)).expect(200);
    const entry = book.body.entries.find((e: any) => e.reference === "Goodwill credit for a late driver");
    expect(entry).toMatchObject({ kind: "adjustment", amount: 5000 });
    expect(book.body.ledger.find((l: any) => l.kind === "adjustment").credits).toBeGreaterThanOrEqual(5000);

    const log = await request(app).get("/api/v1/admin/audit").set(bearer(adminToken)).expect(200);
    expect(log.body.data.some((a: any) => a.action === "wallet.adjust" && a.actorId === staffId)).toBe(true);
  });

  it("suspending a staff member locks them out at once, before the token expires", async () => {
    await request(app).patch(`/api/v1/admin/users/${staffId}/status`).set(bearer(adminToken))
      .send({ status: "suspended" }).expect(200);
    const res = await request(app).get("/api/v1/admin/trips").set(bearer(staffToken)).expect(401);
    expect(res.body.error.code).toBe("ACCOUNT_INACTIVE");
  });
});
