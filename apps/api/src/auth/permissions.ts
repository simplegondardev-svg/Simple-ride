import type { RequestHandler } from "express";
import { withContext } from "../db/context.js";
import { AppError } from "../lib/errors.js";

/**
 * Every staff permission. Must match the `permissions` table (seeded in
 * 0005_staff_permissions.sql); test/staff.test.ts fails if they drift.
 * Adding one = add it here + INSERT it in a new migration + use it in
 * requirePermission() and, if it gates data, in an RLS policy.
 */
export const PERMISSIONS = [
  "dashboard.view",
  "users.view",
  "users.suspend",
  "drivers.view",
  "drivers.approve",
  "trips.view",
  "trips.cancel",
  "finance.daybook.view",
  "finance.wallets.view",
  "finance.wallets.adjust",
  "pricing.manage",
  "zones.manage",
  "sos.view",
  "sos.manage",
  "audit.view",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

declare global {
  namespace Express {
    interface Request {
      /** Loaded lazily by requirePermission(); admins get every permission. */
      permissions?: Set<Permission>;
    }
  }
}

export async function loadPermissions(req: Express.Request): Promise<Set<Permission>> {
  if (req.permissions) return req.permissions;
  if (req.ctx.role === "admin") {
    req.permissions = new Set(PERMISSIONS);
  } else if (req.ctx.role === "staff") {
    const rows = await withContext(req.ctx, async (db) =>
      (await db.query<{ permission: Permission }>(
        "SELECT permission FROM staff_permissions WHERE user_id = app.uid()",
      )).rows,
    );
    req.permissions = new Set(rows.map((r) => r.permission));
  } else {
    req.permissions = new Set();
  }
  return req.permissions;
}

/**
 * Route guard for the back office. Passes if the user holds ANY of the
 * listed permissions (admins hold all). The database enforces the same
 * rules through RLS, so this is the first check, not the only one.
 */
export const requirePermission =
  (...needed: Permission[]): RequestHandler =>
  async (req, _res, next) => {
    if (!req.ctx.userId) return next(new AppError(401, "UNAUTHENTICATED", "Login required"));
    const have = await loadPermissions(req);
    if (needed.some((p) => have.has(p))) return next();
    next(new AppError(403, "MISSING_PERMISSION", `Requires permission: ${needed.join(" or ")}`, { needed }));
  };
