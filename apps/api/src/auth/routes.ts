import { Router } from "express";
import { z } from "zod";
import { SYSTEM, withContext } from "../db/context.js";
import { AppError } from "../lib/errors.js";
import { normalizeEthiopianPhone } from "../lib/phone.js";
import { rateLimit } from "../lib/rate-limit.js";
import { issueOtp, verifyOtp } from "./otp.js";
import { createSession, revokeSession, rotateSession, signAccessToken } from "./tokens.js";

export const authRouter = Router();

const USER_COLS = `id, phone, role, status, full_name AS "fullName", locale`;

const phoneSchema = z.string().transform((v, ctx) => {
  const phone = normalizeEthiopianPhone(v);
  if (!phone) {
    ctx.addIssue({ code: "custom", message: "Not a valid Ethiopian mobile number" });
    return z.NEVER;
  }
  return phone;
});

authRouter.post("/otp/request", async (req, res) => {
  const { phone } = z.object({ phone: phoneSchema }).parse(req.body);
  await rateLimit(`otp:phone:${phone}`, 3, 600);
  await rateLimit(`otp:ip:${req.ip}`, 20, 600);
  const devCode = await issueOtp(phone);
  res.status(202).json({ phone, expiresIn: 300, ...(devCode && { devCode }) });
});

const verifySchema = z.object({
  phone: phoneSchema,
  code: z.string().regex(/^\d{6}$/),
  // Which app is logging in. The driver app sends "driver"; admins use the
  // web dashboard. Admin accounts are never created through this endpoint.
  role: z.enum(["customer", "driver", "admin"]).default("customer"),
  platform: z.enum(["web", "android", "ios"]),
  deviceId: z.string().max(200).optional(),
});

authRouter.post("/otp/verify", async (req, res) => {
  const body = verifySchema.parse(req.body);
  if (!(await verifyOtp(body.phone, body.code))) {
    throw new AppError(401, "INVALID_OTP", "Code is invalid or expired");
  }

  // Login runs in SYSTEM context: there is no user yet to scope RLS to.
  const result = await withContext(SYSTEM, async (db) => {
    let { rows } = await db.query(
      `SELECT ${USER_COLS} FROM users WHERE phone = $1 AND role = $2`,
      [body.phone, body.role],
    );
    let user = rows[0];
    let isNew = false;

    if (!user) {
      if (body.role === "admin") throw new AppError(403, "FORBIDDEN", "No admin account for this phone");
      ({ rows } = await db.query(
        `INSERT INTO users (phone, role) VALUES ($1, $2)
         RETURNING ${USER_COLS}`,
        [body.phone, body.role],
      ));
      user = rows[0]!;
      isNew = true;
      await db.query("INSERT INTO wallets (user_id) VALUES ($1)", [user.id]);
      if (body.role === "driver") {
        await db.query("INSERT INTO driver_profiles (user_id) VALUES ($1)", [user.id]);
      }
    }
    if (user.status !== "active") throw new AppError(403, "ACCOUNT_SUSPENDED", "Account is not active");

    const refreshToken = await createSession(db, user.id, {
      platform: body.platform,
      deviceId: body.deviceId,
      userAgent: req.get("user-agent"),
    });
    return { user, isNew, refreshToken };
  });

  res.json({
    accessToken: signAccessToken({ sub: result.user.id, role: result.user.role }),
    refreshToken: result.refreshToken,
    isNewUser: result.isNew,
    user: result.user,
  });
});

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
