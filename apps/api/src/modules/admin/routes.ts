import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../../auth/middleware.js";
import { withContext } from "../../db/context.js";
import { notFound } from "../../lib/errors.js";
import { page, uuidParam } from "../../lib/schemas.js";

/**
 * Back-office API for the Next.js admin dashboard. RLS grants admins full
 * row access, so every mutation here also writes an audit_logs entry.
 */
export const adminRouter = Router();
adminRouter.use(requireRole("admin"));

adminRouter.get("/stats", async (req, res) => {
  const stats = await withContext(req.ctx, async (db) =>
    (await db.query(`SELECT
        (SELECT count(*) FROM users WHERE role = 'customer')::int AS customers,
        (SELECT count(*) FROM users WHERE role = 'driver')::int AS drivers,
        (SELECT count(*) FROM driver_profiles WHERE approval_status = 'pending')::int AS "pendingDrivers",
        (SELECT count(*) FROM driver_profiles WHERE availability <> 'offline')::int AS "driversOnline",
        (SELECT count(*) FROM trips WHERE status IN ('searching','accepted','arrived','in_progress'))::int AS "activeTrips",
        (SELECT count(*) FROM trips WHERE status = 'completed' AND completed_at > now() - interval '1 day')::int AS "tripsToday",
        (SELECT count(*) FROM sos_alerts WHERE status <> 'resolved')::int AS "openSos"`)).rows[0],
  );
  res.json(stats);
});

adminRouter.get("/users", async (req, res) => {
  const q = page
    .extend({ role: z.enum(["customer", "driver", "admin"]).optional(), search: z.string().optional() })
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

adminRouter.patch("/users/:id/status", async (req, res) => {
  const { id } = uuidParam.parse(req.params);
  const { status } = z.object({ status: z.enum(["active", "suspended"]) }).parse(req.body);
  const user = await withContext(req.ctx, async (db) => {
    const { rows: [u] } = await db.query(
      "UPDATE users SET status = $2 WHERE id = $1 RETURNING id, status", [id, status],
    );
    if (!u) throw notFound("User");
    if (status === "suspended") {
      await db.query("UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [id]);
    }
    await db.query(
      "INSERT INTO audit_logs (actor_id, action, entity, entity_id, data) VALUES (app.uid(), 'user.status', 'user', $1, $2)",
      [id, { status }],
    );
    return u;
  });
  res.json(user);
});

/** Driver onboarding queue with submitted documents and vehicles. */
adminRouter.get("/drivers/pending", async (req, res) => {
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
adminRouter.post("/drivers/:id/review", async (req, res) => {
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
    await db.query(
      "INSERT INTO audit_logs (actor_id, action, entity, entity_id, data) VALUES (app.uid(), 'driver.review', 'driver', $1, $2)",
      [id, body],
    );
    return p;
  });
  res.json(result);
});

adminRouter.get("/trips", async (req, res) => {
  const q = page.extend({ status: z.string().optional() }).parse(req.query);
  const rows = await withContext(req.ctx, async (db) =>
    (await db.query(
      `SELECT t.id, t.status, t.category_code AS "categoryCode", t.fare_estimate AS "fareEstimate",
              t.final_fare AS "finalFare", t.payment_method AS "paymentMethod",
              t.pickup_address AS "pickupAddress", t.dropoff_address AS "dropoffAddress",
              t.requested_at AS "requestedAt", c.phone AS "customerPhone", d.phone AS "driverPhone"
         FROM trips t JOIN users c ON c.id = t.customer_id LEFT JOIN users d ON d.id = t.driver_id
        WHERE ($1::text IS NULL OR t.status::text = $1)
          AND ($2::timestamptz IS NULL OR t.requested_at < $2)
        ORDER BY t.requested_at DESC LIMIT $3`,
      [q.status ?? null, q.before ?? null, q.limit],
    )).rows,
  );
  res.json({ data: rows });
});
