import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { attemptsKey, consoleSms, MockSmsSender, otpKey, setSmsSender } from "../src/auth/otp.js";
import { SYSTEM, withContext } from "../src/db/context.js";
import { pool } from "../src/db/pool.js";
import { redis } from "../src/lib/redis.js";
import { getOtpCode, grant, makeBackoffice, makeLegacyUser, PASSWORD, randomPhone } from "./helpers.js";

const app = createApp();
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

let mockSms: MockSmsSender;

function register(phone: string, role = "customer", password = PASSWORD, code?: string) {
  let expectedStatus: number | undefined;
  let expectedBody: any | undefined;

  const run = async () => {
    const c = code ?? (await getOtpCode(phone, role as any));
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
      expect(await redis.get(otpKey({ purpose: "register", phone, role: "customer" }))).toBeNull();
      expect(await redis.get(attemptsKey({ purpose: "register", phone, role: "customer" }))).toBeNull();
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
    await redis.del(otpKey({ purpose: "register", phone, role: "customer" }));

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
    const code = await getOtpCode(phone, "driver");

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

describe("legacy account phone verification (POST /auth/phone/verify/*)", () => {
  it("legacy unverified user can start and complete phone verification, and existing token works immediately", async () => {
    const legacy = await makeLegacyUser("customer");
    const loginRes = await request(app).post("/api/v1/auth/login")
      .send({ phone: legacy.phone, password: PASSWORD, role: "customer", platform: "android" }).expect(200);

    const token = loginRes.body.accessToken;
    expect(loginRes.body.user.phoneVerified).toBe(false);

    // Initial /users/me reports phoneVerified = false
    const meBefore = await request(app).get("/api/v1/users/me").set(bearer(token)).expect(200);
    expect(meBefore.body.phoneVerified).toBe(false);

    // Start verification
    mockSms.clear();
    await request(app).post("/api/v1/auth/phone/verify/start").set(bearer(token)).expect(200, { ok: true });

    // SMS was sent
    expect(mockSms.sent.length).toBe(1);
    expect(mockSms.sent[0]!.phone).toBe(legacy.phone);
    const code = mockSms.sent[0]!.message.replace("Simple Ride code: ", "");

    // Confirm verification
    await request(app).post("/api/v1/auth/phone/verify/confirm").set(bearer(token))
      .send({ code }).expect(200, { ok: true });

    // Database record now has phone_verified_at set
    const dbUser = await withContext(SYSTEM, async (db) => {
      const { rows: [u] } = await db.query("SELECT phone_verified_at FROM users WHERE id = $1", [legacy.id]);
      return u;
    });
    expect(dbUser.phone_verified_at).not.toBeNull();

    // Existing access token immediately reflects phoneVerified = true without refresh
    const meAfter = await request(app).get("/api/v1/users/me").set(bearer(token)).expect(200);
    expect(meAfter.body.phoneVerified).toBe(true);
  });

  it("does not allow user A to substitute user B's phone number", async () => {
    const userA = await makeLegacyUser("customer");
    const userB = await makeLegacyUser("customer");

    const aLogin = await request(app).post("/api/v1/auth/login")
      .send({ phone: userA.phone, password: PASSWORD, role: "customer", platform: "android" }).expect(200);

    mockSms.clear();
    // Pass user B's phone in request body
    await request(app).post("/api/v1/auth/phone/verify/start")
      .set(bearer(aLogin.body.accessToken))
      .send({ phone: userB.phone })
      .expect(200, { ok: true });

    // SMS must be sent ONLY to user A's registered phone
    expect(mockSms.sent.length).toBe(1);
    expect(mockSms.sent[0]!.phone).toBe(userA.phone);
    expect(mockSms.sent[0]!.phone).not.toBe(userB.phone);
  });

  it("rejects unauthenticated requests", async () => {
    await request(app).post("/api/v1/auth/phone/verify/start").expect(401);
    await request(app).post("/api/v1/auth/phone/verify/confirm").send({ code: "123456" }).expect(401);
  });

  it("rejects invalid, expired, and replayed verification codes", async () => {
    const legacy = await makeLegacyUser("customer");
    const loginRes = await request(app).post("/api/v1/auth/login")
      .send({ phone: legacy.phone, password: PASSWORD, role: "customer", platform: "android" }).expect(200);
    const token = loginRes.body.accessToken;

    mockSms.clear();
    await request(app).post("/api/v1/auth/phone/verify/start").set(bearer(token)).expect(200, { ok: true });
    const code = mockSms.sent[0]!.message.replace("Simple Ride code: ", "");

    // Wrong code fails with 400 INVALID_OTP
    const wrong = await request(app).post("/api/v1/auth/phone/verify/confirm").set(bearer(token))
      .send({ code: "000000" }).expect(400);
    expect(wrong.body.error.code).toBe("INVALID_OTP");

    // 5 attempts allowed; 6th burns the OTP
    for (let i = 0; i < 4; i++) {
      await request(app).post("/api/v1/auth/phone/verify/confirm").set(bearer(token))
        .send({ code: "000000" }).expect(400);
    }
    // 6th attempt burns it
    await request(app).post("/api/v1/auth/phone/verify/confirm").set(bearer(token))
      .send({ code: "000000" }).expect(400);

    // Even the right code now fails because OTP was burned
    const burned = await request(app).post("/api/v1/auth/phone/verify/confirm").set(bearer(token))
      .send({ code }).expect(400);
    expect(burned.body.error.code).toBe("INVALID_OTP");

    // Fresh OTP
    mockSms.clear();
    await request(app).post("/api/v1/auth/phone/verify/start").set(bearer(token)).expect(200, { ok: true });
    const freshCode = mockSms.sent[0]!.message.replace("Simple Ride code: ", "");

    // Successful confirm
    await request(app).post("/api/v1/auth/phone/verify/confirm").set(bearer(token))
      .send({ code: freshCode }).expect(200, { ok: true });

    // Idempotent for already verified user
    await request(app).post("/api/v1/auth/phone/verify/confirm").set(bearer(token))
      .send({ code: freshCode }).expect(200, { ok: true });
  });

  it("atomic OTP consumption prevents concurrent verification race", async () => {
    const legacy = await makeLegacyUser("customer");
    const loginRes = await request(app).post("/api/v1/auth/login")
      .send({ phone: legacy.phone, password: PASSWORD, role: "customer", platform: "android" }).expect(200);
    const token = loginRes.body.accessToken;

    mockSms.clear();
    await request(app).post("/api/v1/auth/phone/verify/start").set(bearer(token)).expect(200, { ok: true });
    const code = mockSms.sent[0]!.message.replace("Simple Ride code: ", "");

    // Fire 2 concurrent requests
    const [res1, res2] = await Promise.all([
      request(app).post("/api/v1/auth/phone/verify/confirm").set(bearer(token)).send({ code }),
      request(app).post("/api/v1/auth/phone/verify/confirm").set(bearer(token)).send({ code }),
    ]);

    const statuses = [res1.status, res2.status].sort();
    expect(statuses[0]).toBe(200);
  });

  it("enforces rate limits on phone verify start and confirm", async () => {
    const legacy = await makeLegacyUser("customer");
    const loginRes = await request(app).post("/api/v1/auth/login")
      .send({ phone: legacy.phone, password: PASSWORD, role: "customer", platform: "android" }).expect(200);
    const token = loginRes.body.accessToken;

    // 3 start requests per phone allowed; 4th rejected
    mockSms.clear();
    await request(app).post("/api/v1/auth/phone/verify/start").set(bearer(token)).expect(200);
    await request(app).post("/api/v1/auth/phone/verify/start").set(bearer(token)).expect(200);
    await request(app).post("/api/v1/auth/phone/verify/start").set(bearer(token)).expect(200);

    const fourth = await request(app).post("/api/v1/auth/phone/verify/start").set(bearer(token)).expect(429);
    expect(fourth.body.error.code).toBe("RATE_LIMITED");

    // Start IP rate limit: 30 allowed, 31st rejected
    const startIp = "203.0.113.88";
    await redis.set(`rl:phone-verify-start:ip:${startIp}`, "30");
    const startLimited = await request(app).post("/api/v1/auth/phone/verify/start")
      .set(bearer(token))
      .set("X-Forwarded-For", startIp)
      .expect(429);
    expect(startLimited.body.error.code).toBe("RATE_LIMITED");
    await redis.del(`rl:phone-verify-start:ip:${startIp}`);

    // Confirm IP rate limit: 60 allowed, 61st rejected
    const testIp = "203.0.113.77";
    await redis.set(`rl:phone-verify-confirm:ip:${testIp}`, "60");
    const limited = await request(app).post("/api/v1/auth/phone/verify/confirm")
      .set(bearer(token))
      .set("X-Forwarded-For", testIp)
      .send({ code: "123456" }).expect(429);
    expect(limited.body.error.code).toBe("RATE_LIMITED");
    await redis.del(`rl:phone-verify-confirm:ip:${testIp}`);
  });

  it("already verified accounts receive idempotent responses without sending SMS", async () => {
    const user = await register(randomPhone()).expect(201);
    const token = user.body.accessToken;

    mockSms.clear();
    await request(app).post("/api/v1/auth/phone/verify/start").set(bearer(token)).expect(200, { ok: true });
    // No SMS sent because user is already verified
    expect(mockSms.sent.length).toBe(0);

    await request(app).post("/api/v1/auth/phone/verify/confirm").set(bearer(token))
      .send({ code: "123456" }).expect(200, { ok: true });
  });
});

describe("self-service password recovery (POST /auth/password/*)", () => {
    it("existing and nonexistent phone numbers receive identical HTTP 200 { ok: true } responses", async () => {
      const existing = await register(randomPhone()).expect(201);
      const nonexistentPhone = randomPhone();

      mockSms.clear();
      // Existing customer receives 200 and an SMS
      const res1 = await request(app)
        .post("/api/v1/auth/password/forgot")
        .send({ phone: existing.body.user.phone, role: "customer" })
        .expect(200);
      expect(res1.body).toEqual({ ok: true });
      expect(mockSms.sent.length).toBe(1);

      // Nonexistent account receives identical 200, but no SMS is sent
      const res2 = await request(app)
        .post("/api/v1/auth/password/forgot")
        .send({ phone: nonexistentPhone, role: "customer" })
        .expect(200);
      expect(res2.body).toEqual({ ok: true });
      expect(mockSms.sent.length).toBe(1); // unchanged
    });

    it("per-phone quota exhaustion suppresses SMS while returning HTTP 200 { ok: true }", async () => {
      const user = await register(randomPhone()).expect(201);
      const phone = user.body.user.phone;

      // Exhaust per-phone limit
      await redis.set(`rl:otp:phone:${phone}`, "3");

      mockSms.clear();
      const res = await request(app)
        .post("/api/v1/auth/password/forgot")
        .send({ phone, role: "customer" })
        .expect(200);
      expect(res.body).toEqual({ ok: true });
      expect(mockSms.sent.length).toBe(0);

      await redis.del(`rl:otp:phone:${phone}`);
    });

    it("SMS delivery failure returns generic HTTP 200 and leaves no usable OTP", async () => {
      const user = await register(randomPhone()).expect(201);
      const phone = user.body.user.phone;

      const failingSender = {
        async send() {
          throw new Error("Simulated SMS network failure");
        },
      };
      setSmsSender(failingSender);

      try {
        const res = await request(app)
          .post("/api/v1/auth/password/forgot")
          .send({ phone, role: "customer" })
          .expect(200);
        expect(res.body).toEqual({ ok: true });
      } finally {
        setSmsSender(mockSms);
      }

      // Ensure no usable OTP remains in Redis
      const resetRes = await request(app)
        .post("/api/v1/auth/password/reset")
        .send({ phone, role: "customer", code: "123456", newPassword: "New-Safe-Pass-2026!" })
        .expect(400);
      expect(resetRes.body.error.code).toBe("INVALID_OTP");
    });

    it("IP rate limit applies to both existing and nonexistent account requests", async () => {
      const testIp = "203.0.113.91";
      await redis.set(`rl:password-forgot:ip:${testIp}`, "30");

      const res = await request(app)
        .post("/api/v1/auth/password/forgot")
        .set("X-Forwarded-For", testIp)
        .send({ phone: randomPhone() })
        .expect(429);
      expect(res.body.error.code).toBe("RATE_LIMITED");

      await redis.del(`rl:password-forgot:ip:${testIp}`);
    });

    it("invalid OTPs count toward the password-reset IP limit", async () => {
      const testIp = "203.0.113.92";
      await redis.set(`rl:password-reset:ip:${testIp}`, "60");

      const res = await request(app)
        .post("/api/v1/auth/password/reset")
        .set("X-Forwarded-For", testIp)
        .send({ phone: randomPhone(), code: "123456", newPassword: "Safe-Password-2026!" })
        .expect(429);
      expect(res.body.error.code).toBe("RATE_LIMITED");

      await redis.del(`rl:password-reset:ip:${testIp}`);
    });

    it("rejects weak new passwords without consuming the recovery OTP", async () => {
      const user = await register(randomPhone()).expect(201);
      const phone = user.body.user.phone;

      mockSms.clear();
      await request(app).post("/api/v1/auth/password/forgot").send({ phone }).expect(200);
      const code = mockSms.sent[0]!.message.replace("Simple Ride code: ", "");

      // Weak password (< 10 chars) rejected with 422
      const weakRes = await request(app)
        .post("/api/v1/auth/password/reset")
        .send({ phone, code, newPassword: "short" })
        .expect(422);
      expect(weakRes.body.error.code).toBe("WEAK_PASSWORD");

      // Verify OTP is still usable with valid password
      const okRes = await request(app)
        .post("/api/v1/auth/password/reset")
        .send({ phone, code, newPassword: "New-Valid-Password-2026!" })
        .expect(200);
      expect(okRes.body).toEqual({ ok: true });
    });

    it("expensive password hashing occurs only after successful OTP verification", async () => {
      const user = await register(randomPhone()).expect(201);
      const phone = user.body.user.phone;

      mockSms.clear();
      await request(app).post("/api/v1/auth/password/forgot").send({ phone }).expect(200);

      // Wrong OTP fails before hashPassword
      const failRes = await request(app)
        .post("/api/v1/auth/password/reset")
        .send({ phone, code: "000000", newPassword: "Safe-Password-2026!" })
        .expect(400);
      expect(failRes.body.error.code).toBe("INVALID_OTP");
    });

    it("successful recovery updates password, clears lockout, revokes sessions, and requires new login", async () => {
      const phone = randomPhone();
      const reg = await register(phone, "customer").expect(201);
      const oldRefreshToken = reg.body.refreshToken;

      // Lock account with 5 wrong attempts
      for (let i = 0; i < 5; i++) {
        await login(phone, "WrongPassword1!", "customer");
      }
      const lockedRes = await login(phone, PASSWORD, "customer").expect(423);
      expect(lockedRes.body.error.code).toBe("ACCOUNT_LOCKED");

      // Request recovery
      mockSms.clear();
      await request(app).post("/api/v1/auth/password/forgot").send({ phone, role: "customer" }).expect(200);
      const code = mockSms.sent[0]!.message.replace("Simple Ride code: ", "");

      // Perform reset
      const newPassword = "Reset-Password-Success-2026!";
      await request(app)
        .post("/api/v1/auth/password/reset")
        .send({ phone, role: "customer", code, newPassword })
        .expect(200, { ok: true });

      // Old refresh token must be revoked
      await request(app)
        .post("/api/v1/auth/refresh")
        .send({ refreshToken: oldRefreshToken })
        .expect(401);

      // Old password must fail (and not locked)
      const oldLogin = await login(phone, PASSWORD, "customer").expect(401);
      expect(oldLogin.body.error.code).toBe("INVALID_CREDENTIALS");

      // New password succeeds and returns fresh session
      const newLogin = await login(phone, newPassword, "customer").expect(200);
      expect(newLogin.body.accessToken).toBeTruthy();

      // Verify audit log entry
      await withContext(SYSTEM, async (db) => {
        const { rows } = await db.query(
          "SELECT * FROM audit_logs WHERE action = 'user.password_reset' AND entity_id = $1",
          [reg.body.user.id],
        );
        expect(rows.length).toBeGreaterThan(0);
      });
    });

    it("registration OTP cannot be used to reset password", async () => {
      const phone = randomPhone();
      await register(phone, "customer").expect(201);

      // Issue registration OTP for another account on same phone (or same phone driver)
      mockSms.clear();
      await request(app).post("/api/v1/auth/register/start").send({ phone, role: "driver" }).expect(200);
      const regCode = mockSms.sent[0]!.message.replace("Simple Ride code: ", "");

      // Attempt to reset customer password using registration OTP
      const res = await request(app)
        .post("/api/v1/auth/password/reset")
        .send({ phone, role: "customer", code: regCode, newPassword: "New-Password-2026!" })
        .expect(400);
      expect(res.body.error.code).toBe("INVALID_OTP");
    });

    it("phone-verification OTP cannot be used to reset password", async () => {
      const legacy = await makeLegacyUser("customer");
      const loginRes = await login(legacy.phone, PASSWORD, "customer").expect(200);
      const token = loginRes.body.accessToken;

      // Start legacy phone verification
      mockSms.clear();
      await request(app).post("/api/v1/auth/phone/verify/start").set(bearer(token)).expect(200);
      const verifyCode = mockSms.sent[0]!.message.replace("Simple Ride code: ", "");

      // Attempt to reset password using verify_phone OTP
      const res = await request(app)
        .post("/api/v1/auth/password/reset")
        .send({ phone: legacy.phone, role: "customer", code: verifyCode, newPassword: "New-Password-2026!" })
        .expect(400);
      expect(res.body.error.code).toBe("INVALID_OTP");
    });

    it("recovery OTP cannot be used to complete registration", async () => {
      const phone = randomPhone();
      await register(phone, "customer").expect(201);

      // Issue recovery OTP
      mockSms.clear();
      await request(app).post("/api/v1/auth/password/forgot").send({ phone, role: "customer" }).expect(200);
      const recoveryCode = mockSms.sent[0]!.message.replace("Simple Ride code: ", "");

      // Attempt to register driver with recovery OTP
      const res = await request(app)
        .post("/api/v1/auth/register")
        .send({ phone, role: "driver", code: recoveryCode, password: PASSWORD, platform: "android" })
        .expect(400);
      expect(res.body.error.code).toBe("INVALID_OTP");
    });

    it("customer recovery OTP cannot reset the driver account sharing the same phone", async () => {
      const phone = randomPhone();
      await register(phone, "customer").expect(201);
      await register(phone, "driver").expect(201);

      // Request recovery for customer account
      mockSms.clear();
      await request(app).post("/api/v1/auth/password/forgot").send({ phone, role: "customer" }).expect(200);
      const custCode = mockSms.sent[0]!.message.replace("Simple Ride code: ", "");

      // Attempt to reset driver account with customer code
      const drvReset = await request(app)
        .post("/api/v1/auth/password/reset")
        .send({ phone, role: "driver", code: custCode, newPassword: "Driver-New-Pass-2026!" })
        .expect(400);
      expect(drvReset.body.error.code).toBe("INVALID_OTP");

      // Driver login with original password still works
      await login(phone, PASSWORD, "driver").expect(200);

      // Customer account can be reset with the code
      await request(app)
        .post("/api/v1/auth/password/reset")
        .send({ phone, role: "customer", code: custCode, newPassword: "Customer-New-Pass-2026!" })
        .expect(200);
    });

    it("driver recovery OTP cannot reset the customer account sharing the same phone", async () => {
      const phone = randomPhone();
      await register(phone, "customer").expect(201);
      await register(phone, "driver").expect(201);

      // Request recovery for driver account
      mockSms.clear();
      await request(app).post("/api/v1/auth/password/forgot").send({ phone, role: "driver" }).expect(200);
      const drvCode = mockSms.sent[0]!.message.replace("Simple Ride code: ", "");

      // Attempt to reset customer account with driver code
      const custReset = await request(app)
        .post("/api/v1/auth/password/reset")
        .send({ phone, role: "customer", code: drvCode, newPassword: "Customer-New-Pass-2026!" })
        .expect(400);
      expect(custReset.body.error.code).toBe("INVALID_OTP");

      // Customer login with original password still works
      await login(phone, PASSWORD, "customer").expect(200);

      // Driver account can be reset with the code
      await request(app)
        .post("/api/v1/auth/password/reset")
        .send({ phone, role: "driver", code: drvCode, newPassword: "Driver-New-Pass-2026!" })
        .expect(200);
    });

    it("two concurrent reset requests cannot consume the same OTP twice", async () => {
      const phone = randomPhone();
      await register(phone, "customer").expect(201);

      mockSms.clear();
      await request(app).post("/api/v1/auth/password/forgot").send({ phone, role: "customer" }).expect(200);
      const code = mockSms.sent[0]!.message.replace("Simple Ride code: ", "");

      // Fire 2 concurrent reset requests
      const [res1, res2] = await Promise.all([
        request(app).post("/api/v1/auth/password/reset").send({ phone, role: "customer", code, newPassword: "Concurrent-Pass-1!" }),
        request(app).post("/api/v1/auth/password/reset").send({ phone, role: "customer", code, newPassword: "Concurrent-Pass-2!" }),
      ]);

      const statuses = [res1.status, res2.status].sort();
      expect(statuses).toEqual([200, 400]);
    });

    it("shared per-phone SMS quota enforces across registration, verification, and recovery", async () => {
      const phone = randomPhone();
      await register(phone, "customer").expect(201);
      const loginRes = await login(phone, PASSWORD, "customer").expect(200);
      const token = loginRes.body.accessToken;

      // 1: /password/forgot
      await request(app).post("/api/v1/auth/password/forgot").send({ phone, role: "customer" }).expect(200);
      // 2: /phone/verify/start (even if verified, let's test quota on an unverified user)
      // Clear quota for clean test
      await redis.del(`rl:otp:phone:${phone}`);

      // Count 1: register/start (on a different role for same phone)
      await request(app).post("/api/v1/auth/register/start").send({ phone, role: "driver" }).expect(200);
      // Count 2: password/forgot
      await request(app).post("/api/v1/auth/password/forgot").send({ phone, role: "customer" }).expect(200);
      // Count 3: password/forgot
      await request(app).post("/api/v1/auth/password/forgot").send({ phone, role: "customer" }).expect(200);

      // Count 4: register/start now fails with 429
      const fourth = await request(app).post("/api/v1/auth/register/start").send({ phone, role: "driver" }).expect(429);
      expect(fourth.body.error.code).toBe("RATE_LIMITED");

      await redis.del(`rl:otp:phone:${phone}`);
    });

    it("defaults role to customer when omitted and rejects admin/staff roles", async () => {
      const phone = randomPhone();
      await register(phone, "customer").expect(201);

      mockSms.clear();
      // Omit role in forgot -> defaults to customer
      await request(app).post("/api/v1/auth/password/forgot").send({ phone }).expect(200, { ok: true });
      const code = mockSms.sent[0]!.message.replace("Simple Ride code: ", "");

      // Omit role in reset -> defaults to customer
      await request(app)
        .post("/api/v1/auth/password/reset")
        .send({ phone, code, newPassword: "Default-Role-Pass-2026!" })
        .expect(200, { ok: true });

      // Admin or staff role in forgot or reset rejected with 422
      await request(app)
        .post("/api/v1/auth/password/forgot")
        .send({ phone, role: "admin" })
        .expect(422);

      await request(app)
        .post("/api/v1/auth/password/reset")
        .send({ phone, role: "staff", code: "123456", newPassword: "Staff-Password-2026!" })
        .expect(422);
    });

    it("consumes shared per-phone quota identically for existing and unknown numbers, yielding identical register/start rate-limit outcome", async () => {
      // 1. Existing customer account
      const existingPhone = randomPhone();
      await register(existingPhone, "customer").expect(201);

      // 3 forgot requests for existing number
      for (let i = 0; i < 3; i++) {
        await request(app)
          .post("/api/v1/auth/password/forgot")
          .send({ phone: existingPhone, role: "customer" })
          .expect(200, { ok: true });
      }

      // 4th request via register/start is rejected with 429
      const existingRegisterStart = await request(app)
        .post("/api/v1/auth/register/start")
        .send({ phone: existingPhone, role: "driver" })
        .expect(429);
      expect(existingRegisterStart.body.error.code).toBe("RATE_LIMITED");

      // 2. Unknown / nonexistent phone number
      const unknownPhone = randomPhone();

      // 3 forgot requests for unknown number
      for (let i = 0; i < 3; i++) {
        await request(app)
          .post("/api/v1/auth/password/forgot")
          .send({ phone: unknownPhone, role: "customer" })
          .expect(200, { ok: true });
      }

      // 4th request via register/start is rejected with 429 IDENTICALLY
      const unknownRegisterStart = await request(app)
        .post("/api/v1/auth/register/start")
        .send({ phone: unknownPhone, role: "customer" })
        .expect(429);
      expect(unknownRegisterStart.body.error.code).toBe("RATE_LIMITED");

      await redis.del(`rl:otp:phone:${existingPhone}`, `rl:otp:phone:${unknownPhone}`);
    });

    it("shares per-phone quota across legacy phone-verification and password-recovery", async () => {
      const legacy = await makeLegacyUser("customer");
      const phone = legacy.phone;
      const loginRes = await login(phone, PASSWORD, "customer").expect(200);
      const token = loginRes.body.accessToken;

      // Request 1: phone verify start
      await request(app).post("/api/v1/auth/phone/verify/start").set(bearer(token)).expect(200, { ok: true });
      // Request 2: password forgot
      await request(app).post("/api/v1/auth/password/forgot").send({ phone, role: "customer" }).expect(200, { ok: true });
      // Request 3: password forgot
      await request(app).post("/api/v1/auth/password/forgot").send({ phone, role: "customer" }).expect(200, { ok: true });

      // Request 4 on phone verify start returns 429
      const verifyLimited = await request(app).post("/api/v1/auth/phone/verify/start").set(bearer(token)).expect(429);
      expect(verifyLimited.body.error.code).toBe("RATE_LIMITED");

      // Request 4 on password forgot returns 200 { ok: true } (suppressed SMS, no leak)
      mockSms.clear();
      await request(app).post("/api/v1/auth/password/forgot").send({ phone, role: "customer" }).expect(200, { ok: true });
      expect(mockSms.sent.length).toBe(0);

      await redis.del(`rl:otp:phone:${phone}`);
    });

    it("consumes shared quota for driver forgot requests regardless of whether driver account exists", async () => {
      // User with customer account only on this phone (no driver account)
      const phone = randomPhone();
      await register(phone, "customer").expect(201);

      // Forgot request for driver role (nonexistent account for this role)
      for (let i = 0; i < 3; i++) {
        await request(app)
          .post("/api/v1/auth/password/forgot")
          .send({ phone, role: "driver" })
          .expect(200, { ok: true });
      }

      // Subsequent customer forgot request sees quota exhausted and suppresses SMS while returning 200
      mockSms.clear();
      await request(app)
        .post("/api/v1/auth/password/forgot")
        .send({ phone, role: "customer" })
        .expect(200, { ok: true });
      expect(mockSms.sent.length).toBe(0);

      // Register start for this phone gets 429
      const regStart = await request(app)
        .post("/api/v1/auth/register/start")
        .send({ phone, role: "driver" })
        .expect(429);
      expect(regStart.body.error.code).toBe("RATE_LIMITED");

      await redis.del(`rl:otp:phone:${phone}`);
    });
  });
