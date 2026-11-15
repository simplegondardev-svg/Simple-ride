import { Router } from "express";
import type { PoolClient } from "pg";
import { z } from "zod";
import { env } from "../config/env.js";
import { SYSTEM, withContext } from "../db/context.js";
import { AppError, notFound } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { normalizeEthiopianPhone } from "../lib/phone.js";
import { rateLimit } from "../lib/rate-limit.js";
import { requireAuth } from "./middleware.js";
import { clearOtp, issueOtp, verifyOtp } from "./otp.js";
import { dummyHash, hashPassword, passwordProblem, verifyPassword } from "./password.js";
import { createSession, revokeSession, rotateSession, signAccessToken, type UserRole } from "./tokens.js";

/**
 * Phone + password authentication for every role.
 *
 *   POST /auth/register         riders and drivers create an account
 *   POST /auth/login            everyone; may answer PASSWORD_CHANGE_REQUIRED
 *   POST /auth/password/change  signed-in user changes their password
 *   POST /auth/refresh, /auth/logout
 *
 * Admin and staff accounts are never self-registered: the seed creates the
 * first admin, admins create staff. SMS codes (otp.ts) are not exposed for
 * now; users.phone_verified_at records that numbers are unverified.
 */
export const authRouter = Router();

const USER_COLS = `id, phone, role, status, full_name AS "fullName", locale, (phone_verified_at IS NOT NULL) AS "phoneVerified", account_number AS "accountNumber"`;
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

const phoneSchema = z.string().transform((v, ctx) => {
  const phone = normalizeEthiopianPhone(v);
  if (!phone) {
    ctx.addIssue({ code: "custom", message: "Not a valid Ethiopian mobile number" });
    return z.NEVER;
  }
  return phone;
});

const device = {
  platform: z.enum(["web", "android", "ios"]),
  deviceId: z.string().max(200).optional(),
};

const sessionHours = (role: UserRole) =>
  role === "admin" || role === "staff" ? env.BACKOFFICE_SESSION_TTL_HOURS : env.REFRESH_TOKEN_TTL_DAYS * 24;

function checkNewPassword(password: string, phone: string) {
  const problem = passwordProblem(password, phone);
  if (problem) throw new AppError(422, "WEAK_PASSWORD", problem);
}

async function issueTokens(
  db: PoolClient, user: { id: string; role: UserRole },
  meta: { platform: "web" | "android" | "ios"; deviceId?: string; userAgent?: string },
) {
  const refreshToken = await createSession(db, user.id, { ...meta, ttlHours: sessionHours(user.role) });
  return { accessToken: signAccessToken({ sub: user.id, role: user.role }), refreshToken };
}

// ───────────────────────── Register ─────────────────────────

// Request schemas (exported: the OpenAPI spec is built from them).
export const registerStartBody = z
  .object({
    phone: phoneSchema,
    role: z.enum(["customer", "driver"]).default("customer"),
  });
export const registerBody = z
  .object({
    phone: phoneSchema,
    code: z.string().trim().regex(/^\d{6}$/, "Must be a 6-digit verification code"),
    password: z.string(),
    fullName: z.string().trim().min(2).max(100).optional(),
    role: z.enum(["customer", "driver"]).default("customer"),
    ...device,
  });
export const loginBody = z
  .object({
    phone: phoneSchema,
    password: z.string().min(1).max(128),
    role: z.enum(["customer", "driver", "admin", "staff"]).default("customer"),
    // Required when the account holds a temporary password.
    newPassword: z.string().optional(),
    ...device,
  });
export const changePasswordBody = z
  .object({ currentPassword: z.string().min(1), newPassword: z.string(), ...device });
export const refreshBody = z.object({ refreshToken: z.string().min(10) });
export const logoutBody = z.object({ refreshToken: z.string() });
export const forgotPasswordBody = z.object({
  phone: phoneSchema,
  role: z.enum(["customer", "driver"]).default("customer"),
});
export const resetPasswordBody = z.object({
  phone: phoneSchema,
  role: z.enum(["customer", "driver"]).default("customer"),
  code: z.string().trim().regex(/^\d{6}$/, "Must be a 6-digit verification code"),
  newPassword: z.string().min(1),
});
export const phoneVerifyConfirmBody = z.object({
  code: z.string().trim().regex(/^\d{6}$/, "Must be a 6-digit verification code"),
});

authRouter.post("/register/start", async (req, res) => {
  const body = registerStartBody.parse(req.body);
  await rateLimit(`register-start:ip:${req.ip}`, 30, 600);
  await rateLimit(`otp:phone:${body.phone}`, 3, 600);

  const existing = await withContext(SYSTEM, async (db) => {
    const { rows } = await db.query(
      "SELECT 1 FROM users WHERE phone = $1 AND role = $2",
      [body.phone, body.role],
    );
    return rows.length > 0;
  });

  if (!existing) {
    await issueOtp({ purpose: "register", phone: body.phone, role: body.role });
  }

  res.json({ ok: true });
});

authRouter.post("/register", async (req, res) => {
  const body = registerBody.parse(req.body);
  // Per-IP limits are loose on purpose: mobile carriers put many subscribers
  // behind one IP. Per-account lockout is the real defence for login.
  await rateLimit(`register:ip:${req.ip}`, 60, 600);
  checkNewPassword(body.password, body.phone);

  const verified = await verifyOtp({ purpose: "register", phone: body.phone, role: body.role }, body.code);
  if (!verified) {
    throw new AppError(400, "INVALID_OTP", "Invalid or expired verification code");
  }

  const hash = await hashPassword(body.password);

  const result = await withContext(SYSTEM, async (db) => {
    let user;
    try {
      const insertSql = body.role === "customer"
        ? `INSERT INTO users (phone, role, full_name, phone_verified_at, account_number)
           VALUES ($1, $2, $3, now(), 'SR-' || nextval('customer_account_number_seq'))
           RETURNING ${USER_COLS}`
        : `INSERT INTO users (phone, role, full_name, phone_verified_at, account_number)
           VALUES ($1, $2, $3, now(), NULL)
           RETURNING ${USER_COLS}`;

      ({ rows: [user] } = await db.query(
        insertSql,
        [body.phone, body.role, body.fullName ?? null],
      ));
    } catch (err: any) {
      if (err.code === "23505") {
        throw new AppError(409, "ACCOUNT_EXISTS", "An account with this phone already exists. Log in instead.");
      }
      throw err;
    }
    await db.query("INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, $2)", [user.id, hash]);
    await db.query("INSERT INTO wallets (user_id) VALUES ($1)", [user.id]);
    if (body.role === "driver") await db.query("INSERT INTO driver_profiles (user_id) VALUES ($1)", [user.id]);
    const tokens = await issueTokens(db, user, {
      platform: body.platform, deviceId: body.deviceId, userAgent: req.get("user-agent"),
    });
    return { ...tokens, user };
  });
  res.status(201).json(result);
});

// ───────────────────────── Login ─────────────────────────

type LoginOutcome =
  | { kind: "ok"; accessToken: string; refreshToken: string; user: any }
  | { kind: "bad" }
  | { kind: "locked"; until: Date }
  | { kind: "suspended" }
  | { kind: "change_required" };

authRouter.post("/login", async (req, res) => {
  const body = loginBody.parse(req.body);
  await rateLimit(`login:ip:${req.ip}`, 120, 600);
  if (body.newPassword !== undefined) checkNewPassword(body.newPassword, body.phone);

  // Returns instead of throwing so the failed-attempt counter is committed.
  const outcome = await withContext(SYSTEM, async (db): Promise<LoginOutcome> => {
    const { rows: [user] } = await db.query(
      `SELECT ${USER_COLS} FROM users WHERE phone = $1 AND role = $2`, [body.phone, body.role],
    );
    const { rows: [cred] } = user
      ? await db.query("SELECT * FROM user_credentials WHERE user_id = $1 FOR UPDATE", [user.id])
      : { rows: [] };

    if (!user || !cred) {
      await verifyPassword(body.password, await dummyHash()); // same timing as a real check
      return { kind: "bad" };
    }
    if (cred.locked_until && cred.locked_until > new Date()) return { kind: "locked", until: cred.locked_until };

    if (!(await verifyPassword(body.password, cred.password_hash))) {
      const failed = cred.failed_attempts + 1;
      await db.query(
        `UPDATE user_credentials
            SET failed_attempts = CASE WHEN $2::int >= $3::int THEN 0 ELSE $2::int END,
                locked_until = CASE WHEN $2::int >= $3::int THEN now() + make_interval(mins => $4::int) END
          WHERE user_id = $1`,
        [user.id, failed, MAX_FAILED, LOCK_MINUTES],
      );
      return { kind: "bad" };
    }
    await db.query(
      "UPDATE user_credentials SET failed_attempts = 0, locked_until = NULL WHERE user_id = $1", [user.id],
    );
    if (user.status !== "active") return { kind: "suspended" };

    if (cred.must_change_password) {
      if (body.newPassword === undefined) return { kind: "change_required" };
      if (await verifyPassword(body.newPassword, cred.password_hash)) {
        throw new AppError(422, "WEAK_PASSWORD", "Choose a password different from the temporary one");
      }
      await db.query(
        `UPDATE user_credentials SET password_hash = $2, must_change_password = false, password_changed_at = now()
          WHERE user_id = $1`,
        [user.id, await hashPassword(body.newPassword)],
      );
    }
    const tokens = await issueTokens(db, user, {
      platform: body.platform, deviceId: body.deviceId, userAgent: req.get("user-agent"),
    });
    return { kind: "ok", ...tokens, user };
  });

  switch (outcome.kind) {
    case "ok": {
      const { kind: _, ...payload } = outcome;
      res.json(payload);
      return;
    }
    case "bad":
      throw new AppError(401, "INVALID_CREDENTIALS", "Wrong phone number or password");
    case "locked":
      throw new AppError(423, "ACCOUNT_LOCKED", "Too many wrong passwords. Try again later.",
        { lockedUntil: outcome.until });
    case "suspended":
      throw new AppError(403, "ACCOUNT_SUSPENDED", "Account is not active");
    case "change_required":
      throw new AppError(409, "PASSWORD_CHANGE_REQUIRED",
        "You're using a temporary password. Choose a new one to continue.");
  }
});

// ───────────────────────── Change password ─────────────────────────

/** Changes the password and signs out every other device. Returns a fresh session. */
authRouter.post("/password/change", requireAuth, async (req, res) => {
  const body = changePasswordBody.parse(req.body);
  const result = await withContext(SYSTEM, async (db) => {
    const { rows: [user] } = await db.query(`SELECT ${USER_COLS} FROM users WHERE id = $1`, [req.ctx.userId]);
    const { rows: [cred] } = await db.query(
      "SELECT password_hash FROM user_credentials WHERE user_id = $1 FOR UPDATE", [req.ctx.userId],
    );
    if (!user || !cred || !(await verifyPassword(body.currentPassword, cred.password_hash))) {
      throw new AppError(401, "INVALID_CREDENTIALS", "Current password is wrong");
    }
    checkNewPassword(body.newPassword, user.phone);
    await db.query(
      `UPDATE user_credentials SET password_hash = $2, must_change_password = false, password_changed_at = now()
        WHERE user_id = $1`,
      [user.id, await hashPassword(body.newPassword)],
    );
    await db.query("UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [user.id]);
    return issueTokens(db, user, { platform: body.platform, deviceId: body.deviceId, userAgent: req.get("user-agent") });
  });
  res.json(result);
});

// ───────────────────────── Password recovery (self-service) ─────────────────────────

authRouter.post("/password/forgot", async (req, res) => {
  const body = forgotPasswordBody.parse(req.body);
  await rateLimit(`password-forgot:ip:${req.ip}`, 30, 600);

  // Consume/check shared per-phone OTP quota unconditionally before user lookup.
  // Suppress SMS on exhaustion, but always return 200 { ok: true } without leaking 429.
  let canSendSms = true;
  try {
    await rateLimit(`otp:phone:${body.phone}`, 3, 600);
  } catch (err) {
    if (err instanceof AppError && err.code === "RATE_LIMITED") {
      canSendSms = false;
    } else {
      throw err;
    }
  }

  const user = await withContext(SYSTEM, async (db) => {
    const { rows: [u] } = await db.query<{ id: string; status: string }>(
      "SELECT id, status FROM users WHERE phone = $1 AND role = $2",
      [body.phone, body.role],
    );
    return u;
  });

  if (canSendSms && user && user.status === "active") {
    try {
      await issueOtp({ purpose: "password_reset", phone: body.phone, userId: user.id });
    } catch (err) {
      logger.error({ err, userId: user.id }, "SMS delivery failed during password recovery");
      await clearOtp({ purpose: "password_reset", phone: body.phone, userId: user.id });
    }
  }

  res.json({ ok: true });
});

authRouter.post("/password/reset", async (req, res) => {
  const body = resetPasswordBody.parse(req.body);
  await rateLimit(`password-reset:ip:${req.ip}`, 60, 600);
  checkNewPassword(body.newPassword, body.phone);

  const user = await withContext(SYSTEM, async (db) => {
    const { rows: [u] } = await db.query<{ id: string; status: string }>(
      "SELECT id, status FROM users WHERE phone = $1 AND role = $2",
      [body.phone, body.role],
    );
    return u;
  });

  if (!user || user.status !== "active") {
    throw new AppError(400, "INVALID_OTP", "Invalid or expired verification code");
  }

  const verified = await verifyOtp(
    { purpose: "password_reset", phone: body.phone, userId: user.id },
    body.code,
  );
  if (!verified) {
    throw new AppError(400, "INVALID_OTP", "Invalid or expired verification code");
  }

  const hash = await hashPassword(body.newPassword);

  await withContext(SYSTEM, async (db) => {
    await db.query(
      `UPDATE user_credentials
          SET password_hash = $2,
              must_change_password = false,
              failed_attempts = 0,
              locked_until = NULL,
              password_changed_at = now()
        WHERE user_id = $1`,
      [user.id, hash],
    );
    await db.query(
      "UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL",
      [user.id],
    );
    await db.query(
      "INSERT INTO audit_logs (actor_id, action, entity, entity_id, data) VALUES ($1, $2, $3, $4, $5)",
      [user.id, "user.password_reset", "user", user.id, JSON.stringify({ role: body.role })],
    );
  });

  res.json({ ok: true });
});

// ───────────────────────── Sessions ─────────────────────────

authRouter.post("/refresh", async (req, res) => {
  const { refreshToken } = refreshBody.parse(req.body);
  const result = await withContext(SYSTEM, (db) => rotateSession(db, refreshToken));
  if (!result.ok) throw new AppError(401, "INVALID_REFRESH_TOKEN", "Session expired, log in again");
  res.json({
    accessToken: signAccessToken({ sub: result.userId, role: result.role }),
    refreshToken: result.refreshToken,
  });
});

authRouter.post("/logout", async (req, res) => {
  const { refreshToken } = logoutBody.parse(req.body);
  await withContext(SYSTEM, (db) => revokeSession(db, refreshToken));
  res.status(204).end();
});

// ───────────────────────── Phone verification (existing accounts) ─────────────────────────

authRouter.post("/phone/verify/start", requireAuth, async (req, res) => {
  await rateLimit(`phone-verify-start:ip:${req.ip}`, 30, 600);

  const user = await withContext(SYSTEM, async (db) => {
    const { rows: [u] } = await db.query<{ id: string; phone: string; phone_verified_at: string | null }>(
      "SELECT id, phone, phone_verified_at FROM users WHERE id = $1",
      [req.ctx.userId],
    );
    return u;
  });
  if (!user) throw notFound("User");

  if (!user.phone_verified_at) {
    await rateLimit(`otp:phone:${user.phone}`, 3, 600);
    await issueOtp({ purpose: "verify_phone", phone: user.phone, userId: user.id });
  }

  res.json({ ok: true });
});

authRouter.post("/phone/verify/confirm", requireAuth, async (req, res) => {
  const body = phoneVerifyConfirmBody.parse(req.body);
  await rateLimit(`phone-verify-confirm:ip:${req.ip}`, 60, 600);

  const user = await withContext(SYSTEM, async (db) => {
    const { rows: [u] } = await db.query<{ id: string; phone: string; phone_verified_at: string | null }>(
      "SELECT id, phone, phone_verified_at FROM users WHERE id = $1",
      [req.ctx.userId],
    );
    return u;
  });
  if (!user) throw notFound("User");

  if (!user.phone_verified_at) {
    const verified = await verifyOtp({ purpose: "verify_phone", phone: user.phone, userId: user.id }, body.code);
    if (!verified) {
      throw new AppError(400, "INVALID_OTP", "Invalid or expired verification code");
    }
    await withContext(SYSTEM, (db) =>
      db.query("UPDATE users SET phone_verified_at = now() WHERE id = $1 AND phone_verified_at IS NULL", [user.id]),
    );
  }

  res.json({ ok: true });
});
