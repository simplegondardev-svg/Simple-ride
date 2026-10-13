import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../../auth/middleware.js";
import { loadPermissions, PERMISSIONS, requirePermission } from "../../auth/permissions.js";
import { withContext } from "../../db/context.js";
import { AppError, notFound } from "../../lib/errors.js";
import { normalizeEthiopianPhone } from "../../lib/phone.js";
import { page, uuidParam } from "../../lib/schemas.js";
import { cancelTrip } from "../trips/service.js";

/**
 * Back-office API for the Next.js dashboard, used by admins (everything) and
 * staff (only the permissions an admin switched on for them). Every route
 * names its permission; RLS enforces the same rules in the database. All
 * mutations write an audit_logs entry.
 */
export const adminRouter = Router();
adminRouter.use(requireRole("admin", "staff"));

const audit = (db: any, action: string, entity: string, entityId: string, data: unknown) =>
  db.query(
    "INSERT INTO audit_logs (actor_id, action, entity, entity_id, data) VALUES (app.uid(), $1, $2, $3, $4)",
    [action, entity, entityId, data],
  );

/** Who am I in the back office — the dashboard uses this to show/hide sections. */
adminRouter.get("/me", async (req, res) => {
  res.json({ role: req.ctx.role, permissions: [...(await loadPermissions(req))] });
});

adminRouter.get("/permissions", async (req, res) => {
  const rows = await withContext(req.ctx, async (db) =>
    (await db.query("SELECT code, category, description FROM permissions ORDER BY sort_order")).rows,
  );
  res.json({ data: rows });
});

adminRouter.get("/stats", requirePermission("dashboard.view"), async (req, res) => {
  const stats = await withContext(req.ctx, async (db) =>
    (await db.query("SELECT app.dashboard_stats() AS s")).rows[0].s,
  );
  res.json(stats);
});

// ───────────────────────── Riders & drivers ─────────────────────────

adminRouter.get("/users", requirePermission("users.view", "users.suspend"), async (req, res) => {
  const q = page
    .extend({ role: z.enum(["customer", "driver", "admin", "staff"]).optional(), search: z.string().optional() })
    .parse(req.query);
  const rows = await withContext(req.ctx, async (db) =>
    (await db.query(
      `SELECT u.id, u.phone, u.role, u.status, u.full_name AS "fullName", u.created_at AS "createdAt",
              dp.approval_status AS "approvalStatus", dp.availability
         FROM users u LEFT JOIN driver_profiles dp ON dp.user_id = u.id
        WHERE ($1::user_role IS NULL OR u.role = $1)
          AND ($2::text IS NULL OR u.phone LIKE '%' || $2 || '%' OR u.full_name ILIKE '%' || $2 || '%')
          AND ($3::timestamptz IS NULL OR u.created_at < $3)
        ORDER BY u.created_at DESC LIMIT $4`,
      [q.role ?? null, q.search ?? null, q.before ?? null, q.limit],
    )).rows,
  );
  res.json({ data: rows });
});

adminRouter.patch("/users/:id/status", requirePermission("users.suspend"), async (req, res) => {
  const { id } = uuidParam.parse(req.params);
  const { status } = z.object({ status: z.enum(["active", "suspended"]) }).parse(req.body);
  if (id === req.ctx.userId) throw new AppError(422, "CANNOT_CHANGE_SELF", "You can't change your own status");
  const user = await withContext(req.ctx, async (db) => {
    // RLS: staff only reach riders and drivers; admins reach everyone.
    const { rows: [u] } = await db.query(
      "UPDATE users SET status = $2 WHERE id = $1 RETURNING id, status", [id, status],
    );
    if (!u) throw notFound("User");
    if (status === "suspended") {
      await db.query("UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [id]);
    }
    await audit(db, "user.status", "user", id, { status });
    return u;
  });
  res.json(user);
});

// ───────────────────────── Driver onboarding ─────────────────────────

adminRouter.get("/drivers/pending", requirePermission("drivers.view", "drivers.approve"), async (req, res) => {
  const rows = await withContext(req.ctx, async (db) =>
    (await db.query(
      `SELECT u.id, u.phone, u.full_name AS "fullName", dp.license_number AS "licenseNumber",
              dp.license_expires_on AS "licenseExpiresOn", dp.created_at AS "appliedAt",
              coalesce(json_agg(json_build_object('id', v.id, 'plateNumber', v.plate_number,
                'make', v.make, 'model', v.model, 'color', v.color, 'categoryCode', v.category_code,
                'status', v.status)) FILTER (WHERE v.id IS NOT NULL), '[]') AS vehicles
         FROM driver_profiles dp JOIN users u ON u.id = dp.user_id
         LEFT JOIN vehicles v ON v.driver_id = dp.user_id
        WHERE dp.approval_status = 'pending'
        GROUP BY u.id, dp.user_id ORDER BY dp.created_at`,
    )).rows,
  );
  res.json({ data: rows });
});

/** Approve/reject a driver and (optionally) one of their vehicles. */
adminRouter.post("/drivers/:id/review", requirePermission("drivers.approve"), async (req, res) => {
  const { id } = uuidParam.parse(req.params);
  const body = z
    .object({
      decision: z.enum(["approved", "rejected", "suspended"]),
      vehicleId: z.uuid().optional(),
      note: z.string().max(500).optional(),
    })
    .parse(req.body);
  const result = await withContext(req.ctx, async (db) => {
    const { rows: [p] } = await db.query(
      `UPDATE driver_profiles SET approval_status = $2::approval_status,
              approved_at = CASE WHEN $2::text = 'approved' THEN now() END,
              approved_by = CASE WHEN $2::text = 'approved' THEN app.uid() END
        WHERE user_id = $1 RETURNING approval_status AS "approvalStatus"`,
      [id, body.decision],
    );
    if (!p) throw notFound("Driver");
    if (body.vehicleId) {
      const vehicleStatus = body.decision === "approved" ? "approved" : "rejected";
      // Make the approved vehicle current if the driver has none yet.
      await db.query(
        `UPDATE vehicles SET status = $3::approval_status,
                is_current = ($3::text = 'approved' AND NOT EXISTS (
                  SELECT 1 FROM vehicles v2 WHERE v2.driver_id = $2 AND v2.is_current AND v2.id <> $1))
          WHERE id = $1 AND driver_id = $2`,
        [body.vehicleId, id, vehicleStatus],
      );
    }
    await audit(db, "driver.review", "driver", id, body);
    return p;
  });
  res.json(result);
});

// ───────────────────────── Trips ─────────────────────────

adminRouter.get("/trips", requirePermission("trips.view"), async (req, res) => {
  const q = page.extend({ status: z.string().optional() }).parse(req.query);
  const rows = await withContext(req.ctx, async (db) =>
    (await db.query(
      `SELECT t.id, t.status, t.category_code AS "categoryCode", t.fare_estimate AS "fareEstimate",
              t.final_fare AS "finalFare", t.payment_method AS "paymentMethod",
              t.pickup_address AS "pickupAddress", t.dropoff_address AS "dropoffAddress",
              t.requested_at AS "requestedAt", c.phone AS "customerPhone", d.phone AS "driverPhone"
         FROM trips t LEFT JOIN users c ON c.id = t.customer_id LEFT JOIN users d ON d.id = t.driver_id
        WHERE ($1::text IS NULL OR t.status::text = $1)
          AND ($2::timestamptz IS NULL OR t.requested_at < $2)
        ORDER BY t.requested_at DESC LIMIT $3`,
      [q.status ?? null, q.before ?? null, q.limit],
    )).rows,
  );
  res.json({ data: rows });
});

adminRouter.post("/trips/:id/cancel", requirePermission("trips.cancel"), async (req, res) => {
  const { id } = uuidParam.parse(req.params);
  const { reason } = z.object({ reason: z.string().min(3).max(300) }).parse(req.body);
  const trip = await cancelTrip(req.ctx, id, reason);
  await withContext(req.ctx, (db) => audit(db, "trip.cancel", "trip", id, { reason }));
  res.json(trip);
});

// ───────────────────────── Finance ─────────────────────────

/** Day book: every money movement on one Addis Ababa calendar day (default today). */
adminRouter.get("/finance/daybook", requirePermission("finance.daybook.view"), async (req, res) => {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Addis_Ababa" }).format(new Date());
  const { date } = z.object({ date: z.iso.date().default(today) }).parse(req.query);
  const book = await withContext(req.ctx, async (db) =>
    (await db.query("SELECT app.daybook($1::date) AS b", [date])).rows[0].b,
  );
  res.json(book);
});

adminRouter.get("/wallets/:id", requirePermission("finance.wallets.view", "finance.wallets.adjust"), async (req, res) => {
  const { id } = uuidParam.parse(req.params);
  const wallet = await withContext(req.ctx, async (db) => {
    const { rows: [w] } = await db.query("SELECT user_id AS \"userId\", balance, currency FROM wallets WHERE user_id = $1", [id]);
    if (!w) throw notFound("Wallet");
    const { rows } = await db.query(
      `SELECT id, amount, balance_after AS "balanceAfter", kind, trip_id AS "tripId", reference,
              created_at AS "createdAt"
         FROM wallet_transactions WHERE user_id = $1 ORDER BY id DESC LIMIT 50`,
      [id],
    );
    return { ...w, transactions: rows };
  });
  res.json(wallet);
});

/** Manual credit (+) or debit (−) in santim, with a mandatory reason. */
adminRouter.post("/wallets/:id/adjust", requirePermission("finance.wallets.adjust"), async (req, res) => {
  const { id } = uuidParam.parse(req.params);
  const body = z
    .object({
      amount: z.number().int().refine((v) => v !== 0, "amount must not be zero")
        .refine((v) => Math.abs(v) <= 10_000_000, "amount too large (max 100,000 ETB)"),
      reason: z.string().trim().min(5).max(300),
    })
    .parse(req.body);
  const result = await withContext(req.ctx, async (db) => {
    const { rows: [w] } = await db.query(
      "UPDATE wallets SET balance = balance + $2, updated_at = now() WHERE user_id = $1 RETURNING balance",
      [id, body.amount],
    );
    if (!w) throw notFound("Wallet");
    await db.query(
      `INSERT INTO wallet_transactions (user_id, amount, balance_after, kind, reference, created_by)
       VALUES ($1, $2, $3, 'adjustment', $4, app.uid())`,
      [id, body.amount, w.balance, body.reason],
    );
    await audit(db, "wallet.adjust", "wallet", id, body);
    return { balance: w.balance };
  });
  res.json(result);
});

// ───────────────────────── Audit ─────────────────────────

adminRouter.get("/audit", requirePermission("audit.view"), async (req, res) => {
  const q = page.parse(req.query);
  const rows = await withContext(req.ctx, async (db) =>
    (await db.query(
      `SELECT a.id, a.action, a.entity, a.entity_id AS "entityId", a.data, a.created_at AS "createdAt",
              a.actor_id AS "actorId"
         FROM audit_logs a
        WHERE ($1::timestamptz IS NULL OR a.created_at < $1)
        ORDER BY a.id DESC LIMIT $2`,
      [q.before ?? null, q.limit],
    )).rows,
  );
  res.json({ data: rows });
});

// ───────────────────────── Staff management (admins only) ─────────────────────────

const staffRouter = Router();
staffRouter.use(requireRole("admin"));
adminRouter.use("/staff", staffRouter);

const permissionList = z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length).transform((l) => [...new Set(l)]);

async function replacePermissions(db: any, userId: string, permissions: string[]) {
  await db.query("DELETE FROM staff_permissions WHERE user_id = $1", [userId]);
  if (permissions.length > 0) {
    await db.query(
      `INSERT INTO staff_permissions (user_id, permission, granted_by)
       SELECT $1, p, app.uid() FROM unnest($2::text[]) AS p`,
      [userId, permissions],
    );
  }
}

staffRouter.get("/", async (req, res) => {
  const rows = await withContext(req.ctx, async (db) =>
    (await db.query(
      `SELECT u.id, u.phone, u.full_name AS "fullName", u.status, u.created_at AS "createdAt",
              coalesce(array_agg(sp.permission ORDER BY p.sort_order) FILTER (WHERE sp.permission IS NOT NULL), '{}') AS permissions
         FROM users u
         LEFT JOIN staff_permissions sp ON sp.user_id = u.id
         LEFT JOIN permissions p ON p.code = sp.permission
        WHERE u.role = 'staff'
        GROUP BY u.id ORDER BY u.created_at`,
    )).rows,
  );
  res.json({ data: rows });
});

/** Create a staff account. They log in with OTP on that phone, choosing "Staff". */
staffRouter.post("/", async (req, res) => {
  const body = z
    .object({
      phone: z.string(),
      fullName: z.string().trim().min(2).max(100),
      permissions: permissionList.default([]),
    })
    .parse(req.body);
  const phone = normalizeEthiopianPhone(body.phone);
  if (!phone) throw new AppError(422, "VALIDATION_FAILED", "Not a valid Ethiopian mobile number");

  const staff = await withContext(req.ctx, async (db) => {
    let rows;
    try {
      ({ rows } = await db.query(
        `INSERT INTO users (phone, role, full_name) VALUES ($1, 'staff', $2)
         RETURNING id, phone, full_name AS "fullName", status`,
        [phone, body.fullName],
      ));
    } catch (err: any) {
      if (err.code === "23505") throw new AppError(409, "STAFF_EXISTS", "A staff account already uses this phone");
      throw err;
    }
    await replacePermissions(db, rows[0].id, body.permissions);
    await audit(db, "staff.create", "user", rows[0].id, { phone, permissions: body.permissions });
    return { ...rows[0], permissions: body.permissions };
  });
  res.status(201).json(staff);
});

/** Replace a staff member's permission list (the toggles). Effective on their next request. */
staffRouter.put("/:id/permissions", async (req, res) => {
  const { id } = uuidParam.parse(req.params);
  const { permissions } = z.object({ permissions: permissionList }).parse(req.body);
  await withContext(req.ctx, async (db) => {
    const { rowCount } = await db.query("SELECT 1 FROM users WHERE id = $1 AND role = 'staff'", [id]);
    if (!rowCount) throw notFound("Staff member");
    await replacePermissions(db, id, permissions);
    await audit(db, "staff.permissions", "user", id, { permissions });
  });
  res.json({ id, permissions });
});
