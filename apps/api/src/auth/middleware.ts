import type { RequestHandler } from "express";
import { ANONYMOUS, type DbContext } from "../db/context.js";
import { AppError } from "../lib/errors.js";
import { verifyAccessToken, type UserRole } from "./tokens.js";

declare global {
  namespace Express {
    interface Request {
      /** RLS context for this request; pass to withContext(). */
      ctx: DbContext;
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
