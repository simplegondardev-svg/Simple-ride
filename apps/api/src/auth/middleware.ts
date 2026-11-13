import type { RequestHandler } from "express";
import { ANONYMOUS, withContext, type DbContext } from "../db/context.js";
import { AppError } from "../lib/errors.js";
import { verifyAccessToken, type UserRole } from "./tokens.js";

declare global {
  namespace Express {
    interface Request {
      /** RLS context for this request; pass to withContext(). */
      ctx: DbContext;
      phoneVerified?: boolean;
    }
  }
}

/** Reads an optional Bearer token. Invalid tokens are a 401, not anonymous. */
export const authenticate: RequestHandler = (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    req.ctx = ANONYMOUS;
    return next();
  }
  try {
    const claims = verifyAccessToken(header.slice(7));
    req.ctx = { userId: claims.sub, role: claims.role };
    next();
  } catch {
    next(new AppError(401, "INVALID_TOKEN", "Access token is invalid or expired"));
  }
};

export const requireAuth: RequestHandler = (req, _res, next) => {
  if (!req.ctx.userId) return next(new AppError(401, "UNAUTHENTICATED", "Login required"));
  next();
};

export const requireRole =
  (...roles: UserRole[]): RequestHandler =>
  (req, _res, next) => {
    if (!req.ctx.userId) return next(new AppError(401, "UNAUTHENTICATED", "Login required"));
    if (!roles.includes(req.ctx.role as UserRole)) {
      return next(new AppError(403, "FORBIDDEN", `Requires role: ${roles.join(" or ")}`));
    }
    next();
  };

export const requireVerifiedPhone: RequestHandler = async (req, _res, next) => {
  if (!req.ctx.userId) return next(new AppError(401, "UNAUTHENTICATED", "Login required"));
  if (req.ctx.role === "admin" || req.ctx.role === "staff") return next();

  try {
    const row = await withContext(req.ctx, async (db) => {
      const { rows } = await db.query<{ phone_verified_at: string | null }>(
        "SELECT phone_verified_at FROM users WHERE id = app.uid()",
      );
      return rows[0];
    });
    if (!row || row.phone_verified_at == null) {
      return next(new AppError(403, "PHONE_NOT_VERIFIED", "Phone verification required"));
    }
    req.phoneVerified = true;
    next();
  } catch (err) {
    next(err);
  }
};
