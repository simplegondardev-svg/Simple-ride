import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../../auth/middleware.js";
import { withContext } from "../../db/context.js";
import { AppError } from "../../lib/errors.js";
import { latLng } from "../../lib/schemas.js";
import { acceptanceRate } from "../trips/service.js";
import { recordPing, setAvailable, setUnavailable } from "./presence.js";

export const driversRouter = Router();
driversRouter.use(requireRole("driver"));

driversRouter.get("/me", async (req, res) => {
  const data = await withContext(req.ctx, async (db) => {
    const { rows: [profile] } = await db.query(
      `SELECT approval_status AS "approvalStatus", license_number AS "licenseNumber",
              license_expires_on AS "licenseExpiresOn", availability,
              rating_avg AS "ratingAvg", rating_count AS "ratingCount"
         FROM driver_profiles WHERE user_id = app.uid()`,
    );
    const { rows: vehicles } = await db.query(
      `SELECT id, category_code AS "categoryCode", plate_number AS "plateNumber", make, model,
              color, year, status, is_current AS "isCurrent"
         FROM vehicles WHERE driver_id = app.uid() ORDER BY created_at`,
    );
    // Share of recent offers accepted (null until the driver has had offers).
    return { ...profile, acceptanceRate: await acceptanceRate(db, req.ctx.userId!), vehicles };
  });
  res.json(data);
});

driversRouter.put("/me/profile", async (req, res) => {
  const body = z
    .object({
      licenseNumber: z.string().trim().min(3).max(50),
      licenseExpiresOn: z.iso.date(),
      nationalId: z.string().trim().max(50).optional(),
    })
    .parse(req.body);
  await withContext(req.ctx, (db) =>
    db.query(
      `UPDATE driver_profiles SET license_number = $1, license_expires_on = $2, national_id = $3
        WHERE user_id = app.uid()`,
      [body.licenseNumber, body.licenseExpiresOn, body.nationalId ?? null],
    ),
  );
  res.status(204).end();
});

driversRouter.post("/me/vehicles", async (req, res) => {
  const body = z
    .object({
      categoryCode: z.string(),
      plateNumber: z.string().trim().toUpperCase().min(3).max(20),
      make: z.string().trim().max(50),
      model: z.string().trim().max(50),
      color: z.string().trim().max(30),
      year: z.number().int().min(1970).max(2100).optional(),
    })
    .parse(req.body);
  const vehicle = await withContext(req.ctx, async (db) => {
    try {
      const { rows } = await db.query(
        `INSERT INTO vehicles (driver_id, category_code, plate_number, make, model, color, year)
         VALUES (app.uid(), $1, $2, $3, $4, $5, $6) RETURNING id, status`,
        [body.categoryCode, body.plateNumber, body.make, body.model, body.color, body.year ?? null],
      );
      return rows[0];
    } catch (err: any) {
      if (err.code === "23505") throw new AppError(409, "PLATE_TAKEN", "Plate already registered");
      if (err.code === "23503") throw new AppError(422, "UNKNOWN_CATEGORY", "Unknown vehicle category");
      throw err;
    }
  });
  res.status(201).json(vehicle);
});

/** Go online: requires approval and an approved current vehicle. */
driversRouter.post("/me/online", async (req, res) => {
  const { location } = z.object({ location: latLng }).parse(req.body);
  const category = await withContext(req.ctx, async (db) => {
    const { rows: [row] } = await db.query(
      `SELECT dp.approval_status, dp.availability, v.category_code
         FROM driver_profiles dp
         LEFT JOIN vehicles v ON v.driver_id = dp.user_id AND v.is_current AND v.status = 'approved'
        WHERE dp.user_id = app.uid()`,
    );
    if (row?.approval_status !== "approved") {
      throw new AppError(403, "DRIVER_NOT_APPROVED", "Your account is awaiting approval");
    }
    if (!row.category_code) throw new AppError(422, "NO_ACTIVE_VEHICLE", "No approved vehicle selected");
    if (row.availability === "on_trip") throw new AppError(409, "ON_TRIP", "Finish your current trip first");
    await db.query("UPDATE driver_profiles SET availability = 'online' WHERE user_id = app.uid()");
    return row.category_code as string;
  });
  await setAvailable(req.ctx.userId!, category, location);
  res.json({ availability: "online", categoryCode: category });
});

driversRouter.post("/me/offline", async (req, res) => {
  await withContext(req.ctx, (db) =>
    db.query(
      "UPDATE driver_profiles SET availability = 'offline' WHERE user_id = app.uid() AND availability = 'online'",
    ),
  );
  await setUnavailable(req.ctx.userId!);
  res.json({ availability: "offline" });
});

/** HTTP fallback for location pings (the socket is preferred). */
driversRouter.post("/me/location", async (req, res) => {
  const body = latLng.extend({ heading: z.number().min(0).max(360).optional() }).parse(req.body);
  await recordPing(req.ctx.userId!, body);
  res.status(204).end();
});

driversRouter.get("/me/offers", async (req, res) => {
  const rows = await withContext(req.ctx, async (db) =>
    (await db.query(
      `SELECT o.trip_id AS "tripId", o.distance_m AS "distanceToPickupM", o.expires_at AS "expiresAt",
              t.fare_estimate AS "fareEstimate", t.pickup_address AS "pickupAddress",
              t.dropoff_address AS "dropoffAddress", t.est_distance_m AS "tripDistanceM"
         FROM trip_offers o JOIN trips t ON t.id = o.trip_id
        WHERE o.driver_id = app.uid() AND o.status = 'pending' AND o.expires_at > now()
        ORDER BY o.offered_at DESC`,
    )).rows,
  );
  res.json({ data: rows });
});
