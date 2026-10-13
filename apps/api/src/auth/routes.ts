import { Router } from "express";
import type { PoolClient } from "pg";
import { z } from "zod";
import { env } from "../config/env.js";
import { SYSTEM, withContext } from "../db/context.js";
import { AppError } from "../lib/errors.js";
import { normalizeEthiopianPhone } from "../lib/phone.js";
import { rateLimit } from "../lib/rate-limit.js";
import { requireAuth } from "./middleware.js";
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

const USER_COLS = `id, phone, role, status, full_name AS "fullName", locale`;
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

authRouter.post("/register", async (req, res) => {
  const body = z
    .object({
      phone: phoneSchema,
      password: z.string(),
      fullName: z.string().trim().min(2).max(100).optional(),
      role: z.enum(["customer", "driver"]).default("customer"),
      ...device,
    })
    .parse(req.body);
  // Per-IP limits are loose on purpose: mobile carriers put many subscribers
  // behind one IP. Per-account lockout is the real defence for login.
  await rateLimit(`register:ip:${req.ip}`, 60, 600);
  checkNewPassword(body.password, body.phone);
  const hash = await hashPassword(body.password);

  const result = await withContext(SYSTEM, async (db) => {
    let user;
    try {
      ({ rows: [user] } = await db.query(
        `INSERT INTO users (phone, role, full_name) VALUES ($1, $2, $3) RETURNING ${USER_COLS}`,
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
  const body = z
    .object({
      phone: phoneSchema,
      password: z.string().min(1).max(128),
      role: z.enum(["customer", "driver", "admin", "staff"]).default("customer"),
      // Required when the account holds a temporary password.
      newPassword: z.string().optional(),
      ...device,
    })
    .parse(req.body);
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
  const body = z
    .object({ currentPassword: z.string().min(1), newPassword: z.string(), ...device })
    .parse(req.body);
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

// ───────────────────────── Sessions ─────────────────────────

authRouter.post("/refresh", async (req, res) => {
  const { refreshToken } = z.object({ refreshToken: z.string().min(10) }).parse(req.body);
  const result = await withContext(SYSTEM, (db) => rotateSession(db, refreshToken));
  if (!result.ok) throw new AppError(401, "INVALID_REFRESH_TOKEN", "Session expired, log in again");
  res.json({
    accessToken: signAccessToken({ sub: result.userId, role: result.role }),
    refreshToken: result.refreshToken,
  });
});

authRouter.post("/logout", async (req, res) => {
  const { refreshToken } = z.object({ refreshToken: z.string() }).parse(req.body);
  await withContext(SYSTEM, (db) => revokeSession(db, refreshToken));
  res.status(204).end();
});
