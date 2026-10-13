import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { SYSTEM, withContext } from "../src/db/context.js";
import { pool } from "../src/db/pool.js";
import { redis } from "../src/lib/redis.js";
import { grant, makeBackoffice, PASSWORD, randomPhone } from "./helpers.js";

const app = createApp();
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const register = (phone: string, role = "customer", password = PASSWORD) =>
  request(app).post("/api/v1/auth/register").send({ phone, password, role, platform: "android" });
const login = (phone: string, password = PASSWORD, role = "customer", newPassword?: string) =>
  request(app).post("/api/v1/auth/login").send({ phone, password, role, platform: "android", newPassword });

beforeAll(() => redis.flushdb());
afterAll(async () => {
  await pool.end();
  redis.disconnect();
});

describe("register", () => {
  it("creates a rider with a wallet and returns a session", async () => {
    const res = await register(`0${randomPhone().slice(4)}`).expect(201);
    expect(res.body.user.role).toBe("customer");
    expect(res.body.accessToken).toBeTruthy();
    await request(app).get("/api/v1/users/me/wallet").set(bearer(res.body.accessToken)).expect(200);
  });

  it("creates a driver with a pending profile", async () => {
    const res = await register(randomPhone(), "driver").expect(201);
    const me = await request(app).get("/api/v1/drivers/me").set(bearer(res.body.accessToken)).expect(200);
    expect(me.body.approvalStatus).toBe("pending");
  });

  it("same phone can hold a rider and a driver account, but not two riders", async () => {
    const phone = randomPhone();
    await register(phone, "customer").expect(201);
    await register(phone, "driver").expect(201);
    const dup = await register(phone, "customer").expect(409);
    expect(dup.body.error.code).toBe("ACCOUNT_EXISTS");
  });

  it.each([
    ["short", "Short1!"],
    ["contains phone", "my911223344pass"],
    ["one repeated char", "aaaaaaaaaaaa"],
  ])("rejects weak passwords (%s)", async (_label, password) => {
    const phone = "+251911223344";
    const res = await register(phone, "customer", password).expect(422);
    expect(res.body.error.code).toBe("WEAK_PASSWORD");
  });

  it("admin and staff accounts can't be self-registered", async () => {
    await register(randomPhone(), "admin").expect(422);
    await register(randomPhone(), "staff").expect(422);
  });
});

describe("login", () => {
  const phone = randomPhone();
  beforeAll(async () => { await register(phone).expect(201); });

  it("accepts the right password, in local number format too", async () => {
    await login(`0${phone.slice(4)}`).expect(200);
  });

  it("same error for wrong password and unknown phone (no account enumeration)", async () => {
    const wrong = await login(phone, "Wrong-password-1").expect(401);
    const unknown = await login(randomPhone()).expect(401);
    expect(wrong.body).toEqual(unknown.body);
  });

  it("role must match the account", async () => {
    await login(phone, PASSWORD, "driver").expect(401);
  });

  it("locks the account for 15 minutes after 5 wrong passwords", async () => {
    const victim = randomPhone();
    await register(victim).expect(201);
    for (let i = 0; i < 5; i++) await login(victim, `Wrong-password-${i}`).expect(401);
    const locked = await login(victim).expect(423); // even the right password
    expect(locked.body.error.code).toBe("ACCOUNT_LOCKED");
    expect(new Date(locked.body.error.details.lockedUntil).getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
  });

  it("a successful login resets the failure counter", async () => {
    const p = randomPhone();
    await register(p).expect(201);
    for (let i = 0; i < 4; i++) await login(p, "Wrong-password-x").expect(401);
    await login(p).expect(200);
    for (let i = 0; i < 4; i++) await login(p, "Wrong-password-y").expect(401);
    await login(p).expect(200); // would be locked if the counter had kept going
  });

  it("suspended accounts can't log in", async () => {
    const p = randomPhone();
    const { body } = await register(p).expect(201);
    await withContext(SYSTEM, (db) => db.query("UPDATE users SET status = 'suspended' WHERE id = $1", [body.user.id]));
    const res = await login(p).expect(403);
    expect(res.body.error.code).toBe("ACCOUNT_SUSPENDED");
  });

  it("SMS-code endpoints are gone", async () => {
    await request(app).post("/api/v1/auth/otp/request").send({ phone }).expect(404);
  });
});

describe("password storage", () => {
  it("hashes are salted scrypt, never the password", async () => {
    const p = randomPhone();
    const { body } = await register(p).expect(201);
    const { rows: [c] } = await withContext(SYSTEM, (db) =>
      db.query("SELECT password_hash FROM user_credentials WHERE user_id = $1", [body.user.id]));
    expect(c.password_hash).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(c.password_hash).not.toContain(PASSWORD);
  });

  it("not even an admin can read credentials through the database", async () => {
    const admin = await makeBackoffice("admin");
    const { rowCount } = await withContext({ userId: admin.id, role: "admin" }, (db) =>
      db.query("SELECT 1 FROM user_credentials"));
    expect(rowCount).toBe(0);
  });
});

describe("change and reset", () => {
  it("change password: needs the current one, signs out other devices", async () => {
    const p = randomPhone();
    const first = await register(p).expect(201);
    const second = await login(p).expect(200);

    await request(app).post("/api/v1/auth/password/change").set(bearer(first.body.accessToken))
      .send({ currentPassword: "nope-nope-nope", newPassword: "Brand-New-Pass-9", platform: "android" }).expect(401);

    const changed = await request(app).post("/api/v1/auth/password/change").set(bearer(first.body.accessToken))
      .send({ currentPassword: PASSWORD, newPassword: "Brand-New-Pass-9", platform: "android" }).expect(200);
    expect(changed.body.refreshToken).toBeTruthy();

    await request(app).post("/api/v1/auth/refresh").send({ refreshToken: second.body.refreshToken }).expect(401);
    await login(p).expect(401);
    await login(p, "Brand-New-Pass-9").expect(200);
  });

  it("support with users.reset_password issues a temporary password; rider must replace it", async () => {
    const p = randomPhone();
    const rider = await register(p).expect(201);
    const support = await makeBackoffice("staff");
    await grant(support.id, ["users.reset_password"]);
    const token = (await request(app).post("/api/v1/auth/login")
      .send({ phone: support.phone, password: PASSWORD, role: "staff", platform: "web" }).expect(200)).body.accessToken;

    const reset = await request(app).post(`/api/v1/admin/users/${rider.body.user.id}/reset-password`)
      .set(bearer(token)).expect(200);
    const temp = reset.body.temporaryPassword;

    // Old password and old sessions are dead.
    await login(p).expect(401);
    await request(app).post("/api/v1/auth/refresh").send({ refreshToken: rider.body.refreshToken }).expect(401);

    const needsChange = await login(p, temp).expect(409);
    expect(needsChange.body.error.code).toBe("PASSWORD_CHANGE_REQUIRED");
    await login(p, temp, "customer", "Riders-Own-Pass-7").expect(200);
    await login(p, "Riders-Own-Pass-7").expect(200);
  });

  it("support can't reset admin or staff passwords, and staff without the permission can't reset anyone", async () => {
    const admin = await makeBackoffice("admin");
    const support = await makeBackoffice("staff");
    await grant(support.id, ["users.reset_password"]);
    const token = (await request(app).post("/api/v1/auth/login")
      .send({ phone: support.phone, password: PASSWORD, role: "staff", platform: "web" })).body.accessToken;
    await request(app).post(`/api/v1/admin/users/${admin.id}/reset-password`).set(bearer(token)).expect(404);

    await grant(support.id, []);
    const rider = await register(randomPhone()).expect(201);
    const res = await request(app).post(`/api/v1/admin/users/${rider.body.user.id}/reset-password`)
      .set(bearer(token)).expect(403);
    expect(res.body.error.code).toBe("MISSING_PERMISSION");
  });
});

describe("session length", () => {
  it("back-office sessions last 12 hours, rider sessions 30 days", async () => {
    const admin = await makeBackoffice("admin");
    const a = await request(app).post("/api/v1/auth/login")
      .send({ phone: admin.phone, password: PASSWORD, role: "admin", platform: "web" }).expect(200);
    const r = await register(randomPhone()).expect(201);
    const hours = async (refreshToken: string) => {
      const { rows: [s] } = await withContext(SYSTEM, (db) => db.query(
        "SELECT extract(epoch FROM expires_at - created_at) / 3600 AS h FROM auth_sessions WHERE id = $1",
        [refreshToken.split(".")[0]]));
      return Math.round(Number(s.h));
    };
    expect(await hours(a.body.refreshToken)).toBe(12);
    expect(await hours(r.body.refreshToken)).toBe(720);
  });
});
