import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { consoleSms, MockSmsSender, setSmsSender } from "../src/auth/otp.js";
import { SYSTEM, withContext } from "../src/db/context.js";
import { pool } from "../src/db/pool.js";
import { redis } from "../src/lib/redis.js";
import { getOtpCode, grant, makeBackoffice, PASSWORD, randomPhone } from "./helpers.js";

const app = createApp();
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

let mockSms: MockSmsSender;

function register(phone: string, role = "customer", password = PASSWORD, code?: string) {
  let expectedStatus: number | undefined;
  let expectedBody: any | undefined;

  const run = async () => {
    const c = code ?? (await getOtpCode(phone));
    let req = request(app)
      .post("/api/v1/auth/register")
      .send({ phone, code: c, password, role, platform: "android" });
    if (expectedStatus !== undefined) {
      req = expectedBody !== undefined ? req.expect(expectedStatus, expectedBody) : req.expect(expectedStatus);
    }
    return req;
  };

  const p: any = Promise.resolve().then(run);
  p.expect = (status: number, body?: any) => {
    expectedStatus = status;
    expectedBody = body;
    return p;
  };

  return p as Promise<any> & { expect(status: number, body?: any): Promise<any> };
}

const login = (phone: string, password = PASSWORD, role = "customer", newPassword?: string) =>
  request(app).post("/api/v1/auth/login").send({ phone, password, role, platform: "android", newPassword });

beforeAll(async () => {
  await redis.flushdb();
  mockSms = new MockSmsSender();
  setSmsSender(mockSms);
});
afterAll(async () => {
  setSmsSender(consoleSms);
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

describe("register start (POST /auth/register/start)", () => {
  it("sends an OTP code for an unregistered phone and returns { ok: true }", async () => {
    const phone = randomPhone();
    mockSms.clear();
    const res = await request(app).post("/api/v1/auth/register/start").send({ phone }).expect(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockSms.sent.length).toBe(1);
    expect(mockSms.sent[0]!.phone).toBe(phone);
    expect(mockSms.sent[0]!.message).toMatch(/^Simple Ride code: \d{6}$/);
  });

  it("does not send SMS for an already registered phone (enumeration defence)", async () => {
    const phone = randomPhone();
    await register(phone, "customer").expect(201);
    mockSms.clear();

    const res = await request(app).post("/api/v1/auth/register/start").send({ phone, role: "customer" }).expect(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockSms.sent.length).toBe(0);
  });

  it("rejects invalid Ethiopian phone numbers with 422", async () => {
    const res = await request(app).post("/api/v1/auth/register/start").send({ phone: "0812345678" }).expect(422);
    expect(res.body.error.code).toBe("VALIDATION_FAILED");
  });

  it("rejects non-self-registerable roles with 422", async () => {
    const res = await request(app).post("/api/v1/auth/register/start").send({ phone: randomPhone(), role: "admin" }).expect(422);
    expect(res.body.error.code).toBe("VALIDATION_FAILED");
  });

  it("enforces rate limit of 3 OTP requests per phone per 10 minutes", async () => {
    const phone = randomPhone();
    for (let i = 0; i < 3; i++) {
      await request(app).post("/api/v1/auth/register/start").send({ phone }).expect(200);
    }
    const limited = await request(app).post("/api/v1/auth/register/start").send({ phone }).expect(429);
    expect(limited.body.error.code).toBe("RATE_LIMITED");
  });

  it("enforces rate limit of 30 start requests per IP per 10 minutes", async () => {
    const testIp = "203.0.113.30";
    for (let i = 0; i < 30; i++) {
      await request(app)
        .post("/api/v1/auth/register/start")
        .set("X-Forwarded-For", testIp)
        .send({ phone: randomPhone() })
        .expect(200);
    }
    const limited = await request(app)
      .post("/api/v1/auth/register/start")
      .set("X-Forwarded-For", testIp)
      .send({ phone: randomPhone() })
      .expect(429);
    expect(limited.body.error.code).toBe("RATE_LIMITED");
  });

  it("applies rate limits before duplicate-account database lookups", async () => {
    const existingPhone = randomPhone();
    await register(existingPhone, "customer").expect(201);

    const testIp = "203.0.113.31";
    for (let i = 0; i < 3; i++) {
      await request(app)
        .post("/api/v1/auth/register/start")
        .set("X-Forwarded-For", testIp)
        .send({ phone: existingPhone, role: "customer" })
        .expect(200);
    }
    const limited = await request(app)
      .post("/api/v1/auth/register/start")
      .set("X-Forwarded-For", testIp)
      .send({ phone: existingPhone, role: "customer" })
      .expect(429);
    expect(limited.body.error.code).toBe("RATE_LIMITED");
  });

  it("clears OTP and attempt keys if SMS delivery fails", async () => {
    const phone = randomPhone();
    const failingSender = {
      async send() {
        throw new Error("SMS gateway outage");
      },
    };
    setSmsSender(failingSender);
    try {
      await request(app).post("/api/v1/auth/register/start").send({ phone }).expect(500);
      expect(await redis.get(`otp:${phone}`)).toBeNull();
      expect(await redis.get(`otp:attempts:${phone}`)).toBeNull();
    } finally {
      setSmsSender(mockSms);
    }
  });
});

describe("register verification & completion (POST /auth/register)", () => {
  it("rejects registration when OTP code is missing with 422", async () => {
    const res = await request(app).post("/api/v1/auth/register")
      .send({ phone: randomPhone(), password: PASSWORD, role: "customer", platform: "android" })
      .expect(422);
    expect(res.body.error.code).toBe("VALIDATION_FAILED");
  });

  it("rejects registration when OTP code is malformed (not 6 digits) with 422", async () => {
    const res = await request(app).post("/api/v1/auth/register")
      .send({ phone: randomPhone(), code: "12345", password: PASSWORD, role: "customer", platform: "android" })
      .expect(422);
    expect(res.body.error.code).toBe("VALIDATION_FAILED");
  });

  it("rejects registration with invalid OTP code with 400 INVALID_OTP", async () => {
    const phone = randomPhone();
    await request(app).post("/api/v1/auth/register/start").send({ phone }).expect(200);
    const res = await request(app).post("/api/v1/auth/register")
      .send({ phone, code: "000000", password: PASSWORD, role: "customer", platform: "android" })
      .expect(400);
    expect(res.body.error.code).toBe("INVALID_OTP");
  });

  it("rejects registration with expired OTP with 400 INVALID_OTP", async () => {
    const phone = randomPhone();
    mockSms.clear();
    await request(app).post("/api/v1/auth/register/start").send({ phone }).expect(200);
    const code = mockSms.sent[0]!.message.replace("Simple Ride code: ", "");

    // Simulate OTP TTL expiration
    await redis.del(`otp:${phone}`);

    const res = await request(app).post("/api/v1/auth/register")
      .send({ phone, code, password: PASSWORD, role: "customer", platform: "android" })
      .expect(400);
    expect(res.body.error.code).toBe("INVALID_OTP");
  });

  it("burns the OTP after exceeding maximum allowed attempts (attempt 6)", async () => {
    const phone = randomPhone();
    mockSms.clear();
    await request(app).post("/api/v1/auth/register/start").send({ phone }).expect(200);
    const code = mockSms.sent[0]!.message.replace("Simple Ride code: ", "");

    // 5 wrong attempts
    for (let i = 1; i <= 5; i++) {
      const res = await request(app).post("/api/v1/auth/register")
        .send({ phone, code: `00000${i}`, password: PASSWORD, role: "customer", platform: "android" })
        .expect(400);
      expect(res.body.error.code).toBe("INVALID_OTP");
    }

    // 6th attempt burns the OTP
    const sixth = await request(app).post("/api/v1/auth/register")
      .send({ phone, code: "999999", password: PASSWORD, role: "customer", platform: "android" })
      .expect(400);
    expect(sixth.body.error.code).toBe("INVALID_OTP");

    // Correct code now fails because OTP was burned
    const seventh = await request(app).post("/api/v1/auth/register")
      .send({ phone, code, password: PASSWORD, role: "customer", platform: "android" })
      .expect(400);
    expect(seventh.body.error.code).toBe("INVALID_OTP");
  });

  it("prevents OTP reuse (replay attack)", async () => {
    const phone = randomPhone();
    mockSms.clear();
    await request(app).post("/api/v1/auth/register/start").send({ phone }).expect(200);
    const code = mockSms.sent[0]!.message.replace("Simple Ride code: ", "");

    // First registration succeeds
    await request(app).post("/api/v1/auth/register")
      .send({ phone, code, password: PASSWORD, role: "customer", platform: "android" })
      .expect(201);

    // Second registration with same OTP code must fail
    const replay = await request(app).post("/api/v1/auth/register")
      .send({ phone, code, password: PASSWORD, role: "driver", platform: "android" })
      .expect(400);
    expect(replay.body.error.code).toBe("INVALID_OTP");
  });

  it("atomic OTP consumption prevents concurrent registration race", async () => {
    const phone = randomPhone();
    mockSms.clear();
    await request(app).post("/api/v1/auth/register/start").send({ phone }).expect(200);
    const code = mockSms.sent[0]!.message.replace("Simple Ride code: ", "");

    const [res1, res2] = await Promise.all([
      request(app).post("/api/v1/auth/register").send({ phone, code, password: PASSWORD, role: "customer", platform: "android" }),
      request(app).post("/api/v1/auth/register").send({ phone, code, password: PASSWORD, role: "customer", platform: "android" }),
    ]);

    const statuses = [res1.status, res2.status].sort();
    expect(statuses[0]).toBe(201);
    expect(statuses[1]).toBe(400);
    const errRes = res1.status === 400 ? res1 : res2;
    expect(errRes.body.error.code).toBe("INVALID_OTP");
  });

  it("sets phone_verified_at in the database upon successful registration", async () => {
    const phone = randomPhone();
    const res = await register(phone).expect(201);
    const { rows: [u] } = await withContext(SYSTEM, (db) =>
      db.query("SELECT phone_verified_at FROM users WHERE id = $1", [res.body.user.id])
    );
    expect(u.phone_verified_at).not.toBeNull();
    expect(new Date(u.phone_verified_at).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("enforces rate limit of 60 registration completion requests per IP per 10 minutes", async () => {
    const testIp = "203.0.113.60";
    for (let i = 0; i < 60; i++) {
      await request(app)
        .post("/api/v1/auth/register")
        .set("X-Forwarded-For", testIp)
        .send({ phone: randomPhone(), code: "000000", password: PASSWORD, role: "customer", platform: "android" })
        .expect(400);
    }
    const limited = await request(app)
      .post("/api/v1/auth/register")
      .set("X-Forwarded-For", testIp)
      .send({ phone: randomPhone(), code: "000000", password: PASSWORD, role: "customer", platform: "android" })
      .expect(429);
    expect(limited.body.error.code).toBe("RATE_LIMITED");
  });

  it("rolls back the entire transaction if a failure occurs after inserting user records", async () => {
    const phone = randomPhone();
    const code = await getOtpCode(phone);

    // Intercept pool.connect to inject a failure after users and user_credentials have been inserted
    let capturedClient: any;
    let restoreQuery: (() => void) | undefined;
    const originalConnect = pool.connect.bind(pool);
    const connectSpy = vi.spyOn(pool, "connect").mockImplementation(async () => {
      const client = await originalConnect();
      capturedClient = client;
      const originalQuery = client.query.bind(client);
      client.query = (async (...args: any[]) => {
        const sql = typeof args[0] === "string" ? args[0] : args[0]?.text;
        // Inject failure on wallets insert, AFTER users and credentials have been inserted
        if (sql && sql.includes("INSERT INTO wallets")) {
          throw new Error("Controlled simulation failure on wallet creation");
        }
        return (originalQuery as any)(...args);
      }) as any;
      restoreQuery = () => {
        client.query = originalQuery;
      };
      return client;
    });

    try {
      await request(app)
        .post("/api/v1/auth/register")
        .send({ phone, code, password: PASSWORD, role: "customer", platform: "android" })
        .expect(500);

      // Restore client query before running verification queries
      if (restoreQuery) restoreQuery();
      connectSpy.mockRestore();

      // Verify that NO partial records remain in the test database
      await withContext(SYSTEM, async (db) => {
        const { rows: users } = await db.query("SELECT * FROM users WHERE phone = $1", [phone]);
        expect(users.length).toBe(0);

        const { rows: creds } = await db.query(
          "SELECT * FROM user_credentials WHERE user_id NOT IN (SELECT id FROM users)"
        );
        expect(creds.length).toBe(0);

        const { rows: wallets } = await db.query(
          "SELECT * FROM wallets WHERE user_id NOT IN (SELECT id FROM users)"
        );
        expect(wallets.length).toBe(0);

        const { rows: sessions } = await db.query(
          "SELECT * FROM auth_sessions WHERE user_id NOT IN (SELECT id FROM users)"
        );
        expect(sessions.length).toBe(0);
      });
    } finally {
      if (restoreQuery) restoreQuery();
      connectSpy.mockRestore();
    }
  });

  it("rolls back the entire transaction if COMMIT fails after inserting all driver records", async () => {
    const phone = randomPhone();
    const code = await getOtpCode(phone);

    let capturedClient: any;
    let restoreQuery: (() => void) | undefined;
    const originalConnect = pool.connect.bind(pool);
    const connectSpy = vi.spyOn(pool, "connect").mockImplementation(async () => {
      const client = await originalConnect();
      capturedClient = client;
      const originalQuery = client.query.bind(client);
      client.query = (async (...args: any[]) => {
        const sql = typeof args[0] === "string" ? args[0] : args[0]?.text;
        // Inject failure on COMMIT, after users, credentials, wallets, driver_profiles, and auth_sessions have all been inserted
        if (sql === "COMMIT") {
          throw new Error("Controlled simulation failure on COMMIT");
        }
        return (originalQuery as any)(...args);
      }) as any;
      restoreQuery = () => {
        client.query = originalQuery;
      };
      return client;
    });

    try {
      const res = await request(app)
        .post("/api/v1/auth/register")
        .send({ phone, code, password: PASSWORD, role: "driver", platform: "android" })
        .expect(500);

      // Verify that no access or refresh tokens are returned
      expect(res.body.accessToken).toBeUndefined();
      expect(res.body.refreshToken).toBeUndefined();
      expect(res.body.user).toBeUndefined();

      // Restore client query before running verification queries
      if (restoreQuery) restoreQuery();
      connectSpy.mockRestore();

      // Verify that NO partial records remain for user, credentials, wallet, driver profile, or session
      await withContext(SYSTEM, async (db) => {
        const { rows: users } = await db.query("SELECT * FROM users WHERE phone = $1", [phone]);
        expect(users.length).toBe(0);

        const { rows: creds } = await db.query(
          "SELECT * FROM user_credentials WHERE user_id NOT IN (SELECT id FROM users)"
        );
        expect(creds.length).toBe(0);

        const { rows: wallets } = await db.query(
          "SELECT * FROM wallets WHERE user_id NOT IN (SELECT id FROM users)"
        );
        expect(wallets.length).toBe(0);

        const { rows: profiles } = await db.query(
          "SELECT * FROM driver_profiles WHERE user_id NOT IN (SELECT id FROM users)"
        );
        expect(profiles.length).toBe(0);

        const { rows: sessions } = await db.query(
          "SELECT * FROM auth_sessions WHERE user_id NOT IN (SELECT id FROM users)"
        );
        expect(sessions.length).toBe(0);
      });
    } finally {
      if (restoreQuery) restoreQuery();
      connectSpy.mockRestore();
    }
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
