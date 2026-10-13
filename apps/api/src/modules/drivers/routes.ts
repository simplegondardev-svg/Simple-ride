import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../../auth/middleware.js";
import { withContext } from "../../db/context.js";
import { AppError } from "../../lib/errors.js";
import { latLng, uuidParam } from "../../lib/schemas.js";
import { notFound } from "../../lib/errors.js";
import { acceptanceRate, requireFunded } from "../trips/service.js";
import {
  ALL_DOC_TYPES, ALLOWED_CONTENT_TYPES, DOC_COLUMNS, MAX_DOC_BYTES, requirements, startUpload, submitDocument,
} from "./documents.js";
import { balances, moneySettings, walletStatus } from "./money.js";
import { recordPing, setAvailable, setUnavailable } from "./presence.js";

export const driversRouter = Router();
driversRouter.use(requireRole("driver"));


// ───────────────────────── Documents ─────────────────────────

driversRouter.get("/me/documents", async (req, res) => {
  const data = await withContext(req.ctx, async (db) => {
    const { rows: documents } = await db.query(
      `SELECT ${DOC_COLUMNS} FROM driver_documents d
        WHERE d.driver_id = app.uid() AND d.status <> 'replaced' ORDER BY d.uploaded_at DESC`,
    );
    const { rows: [v] } = await db.query(
      "SELECT id FROM vehicles WHERE driver_id = app.uid() ORDER BY is_current DESC, created_at DESC LIMIT 1",
    );
    // What still blocks approval: personal documents + those for the driver's (current or newest) vehicle.
    return { documents, required: await requirements(db, req.ctx.userId!, v?.id ?? null) };
  });
  res.json(data);
});

/** Step 1: get a signed URL to upload the file to (valid 10 minutes). */
driversRouter.post("/me/documents", async (req, res) => {
  const body = startDocumentBody.parse(req.body);
  res.status(201).json(await startUpload(req.ctx, body));
});

/** Step 3: after uploading, submit for review (with the expiry date printed on it). */
driversRouter.post("/me/documents/:id/submit", async (req, res) => {
  const { id } = uuidParam.parse(req.params);
  const { expiresOn } = submitDocumentBody.parse(req.body ?? {});
  res.json(await submitDocument(req.ctx, id, expiresOn));
});

// ───────────────────────── Earnings ─────────────────────────

/** Completed trips, fares and commission for today, this week (Mon–Sun) or this month, Addis Ababa time. */
driversRouter.get("/me/earnings", async (req, res) => {
  const { period } = earningsQuery.parse(req.query);
  const data = await withContext(req.ctx, async (db) => {
    const { rows: [range] } = await db.query(
      `SELECT date_trunc($1, now() AT TIME ZONE 'Africa/Addis_Ababa') AT TIME ZONE 'Africa/Addis_Ababa' AS "from",
              now() AS "to"`,
      [period === "today" ? "day" : period],
    );
    const { rows: [t] } = await db.query(
      `SELECT count(*)::int AS trips,
              coalesce(sum(final_fare), 0)::bigint AS gross,
              coalesce(sum(commission_amount), 0)::bigint AS commission,
              coalesce(sum(overtime_amount), 0)::bigint AS overtime,
              coalesce(sum(final_fare) FILTER (WHERE payment_method = 'cash'), 0)::bigint AS "cashCollected",
              coalesce(sum(final_fare - commission_amount) FILTER (WHERE payment_method <> 'cash'), 0)::bigint AS "paidToWallet"
         FROM trips WHERE driver_id = app.uid() AND status = 'completed' AND completed_at >= $1`,
      [range.from],
    );
    const { rows: items } = await db.query(
      `SELECT id AS "tripId", completed_at AS "completedAt", final_fare AS fare, commission_amount AS commission,
              final_fare - commission_amount AS net, overtime_amount AS overtime, payment_method AS "paymentMethod",
              pickup_address AS "pickupAddress", dropoff_address AS "dropoffAddress"
         FROM trips WHERE driver_id = app.uid() AND status = 'completed' AND completed_at >= $1
        ORDER BY completed_at DESC LIMIT 100`,
      [range.from],
    );
    const settings = await moneySettings(db);
    const balance = (await balances(db, [req.ctx.userId!])).get(req.ctx.userId!) ?? 0;
    return {
      period, from: range.from, to: range.to,
      ...t, net: t.gross - t.commission,
      wallet: walletStatus(balance, settings),
      items,
    };
  });
  res.json(data);
});

// ───────────────────────── Deposit refunds ─────────────────────────

const REFUND_COLUMNS = `id, status, requested_at AS "requestedAt", note, amount, reference,
  reject_reason AS "rejectReason", decided_at AS "decidedAt"`;

driversRouter.get("/me/refunds", async (req, res) => {
  const rows = await withContext(req.ctx, async (db) =>
    (await db.query(`SELECT ${REFUND_COLUMNS} FROM deposit_refunds WHERE driver_id = app.uid() ORDER BY requested_at DESC`)).rows,
  );
  res.json({ data: rows });
});

/** Ask for the remaining deposit back. Allowed once the driver has been approved for the refund period (default 90 days). */
driversRouter.post("/me/refunds", async (req, res) => {
  const { note } = refundRequestBody.parse(req.body ?? {});
  const refund = await withContext(req.ctx, async (db) => {
    const settings = await moneySettings(db);
    const { rows: [p] } = await db.query(
      `SELECT approved_at, approved_at + make_interval(days => $1) AS eligible_from,
              approved_at + make_interval(days => $1) <= now() AS eligible
         FROM driver_profiles WHERE user_id = app.uid()`,
      [settings.refundAfterDays],
    );
    if (!p?.approved_at || !p.eligible) {
      throw new AppError(422, "REFUND_NOT_ELIGIBLE",
        `Deposits are refundable ${settings.refundAfterDays} days after approval`,
        { eligibleFrom: p?.eligible_from ?? null, refundAfterDays: settings.refundAfterDays });
    }
    const balance = (await balances(db, [req.ctx.userId!])).get(req.ctx.userId!) ?? 0;
    if (balance <= 0) throw new AppError(422, "NOTHING_TO_REFUND", "Your deposit balance is zero", { balance });
    try {
      const { rows: [r] } = await db.query(
        `INSERT INTO deposit_refunds (driver_id, note) VALUES (app.uid(), $1) RETURNING ${REFUND_COLUMNS}`,
        [note ?? null],
      );
      return r;
    } catch (err: any) {
      if (err.code === "23505") throw new AppError(409, "REFUND_ALREADY_REQUESTED", "You already have a pending refund request");
      throw err;
    }
  });
  res.status(201).json(refund);
});

driversRouter.post("/me/refunds/:id/cancel", async (req, res) => {
  const { id } = uuidParam.parse(req.params);
  const refund = await withContext(req.ctx, async (db) => {
    const { rows: [r] } = await db.query(
      `UPDATE deposit_refunds SET status = 'cancelled' WHERE id = $1 AND driver_id = app.uid() AND status = 'pending'
       RETURNING ${REFUND_COLUMNS}`,
      [id],
    );
    if (!r) throw notFound("Pending refund request");
    return r;
  });
  res.json(refund);
});

// Request schemas (exported: the OpenAPI spec is built from them).
export const driverProfileBody = z
  .object({
    licenseNumber: z.string().trim().min(3).max(50),
    licenseExpiresOn: z.iso.date(),
    nationalId: z.string().trim().max(50).optional(),
  });
export const addVehicleBody = z
  .object({
    categoryCode: z.string(),
    plateNumber: z.string().trim().toUpperCase().min(3).max(20),
    make: z.string().trim().max(50),
    model: z.string().trim().max(50),
    color: z.string().trim().max(30),
    year: z.number().int().min(1970).max(2100).optional(),
  });
export const goOnlineBody = z.object({ location: latLng });
export const startDocumentBody = z.object({
  docType: z.enum(ALL_DOC_TYPES),
  vehicleId: z.uuid().optional().describe("Required for vehicle_* documents"),
  contentType: z.enum(ALLOWED_CONTENT_TYPES),
  sizeBytes: z.number().int().min(1).max(MAX_DOC_BYTES).describe("Exact file size; the upload must match"),
});
export const submitDocumentBody = z.object({
  expiresOn: z.iso.date().optional().describe("Required for license, vehicle_insurance and vehicle_bolo"),
});
export const earningsQuery = z.object({ period: z.enum(["today", "week", "month"]).default("today") });
export const refundRequestBody = z.object({
  note: z.string().trim().max(300).optional().describe("e.g. where to send the money"),
});
export const locationBody = latLng.extend({ heading: z.number().min(0).max(360).optional() });

driversRouter.get("/me", async (req, res) => {
  const data = await withContext(req.ctx, async (db) => {
    const { rows: [profile] } = await db.query(
      `SELECT approval_status AS "approvalStatus", suspended_reason AS "suspendedReason",
              commission_bps AS "customCommissionBps", license_number AS "licenseNumber",
              license_expires_on AS "licenseExpiresOn", availability,
              rating_avg AS "ratingAvg", rating_count AS "ratingCount"
         FROM driver_profiles WHERE user_id = app.uid()`,
    );
    const { rows: vehicles } = await db.query(
      `SELECT id, category_code AS "categoryCode", plate_number AS "plateNumber", make, model,
              color, year, status, is_current AS "isCurrent"
         FROM vehicles WHERE driver_id = app.uid() ORDER BY created_at`,
    );
    const settings = await moneySettings(db);
    const balance = (await balances(db, [req.ctx.userId!])).get(req.ctx.userId!) ?? 0;
    return {
      ...profile,
      // Share of recent offers accepted (null until the driver has had offers).
      acceptanceRate: await acceptanceRate(db, req.ctx.userId!),
      wallet: walletStatus(balance, settings),
      vehicles,
    };
  });
  res.json(data);
});

driversRouter.put("/me/profile", async (req, res) => {
  const body = driverProfileBody.parse(req.body);
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
  const body = addVehicleBody.parse(req.body);
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
  const { location } = goOnlineBody.parse(req.body);
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
    await requireFunded(db, req.ctx.userId!);
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
  const body = locationBody.parse(req.body);
  await recordPing(req.ctx.userId!, body);
  res.status(204).end();
});

driversRouter.get("/me/offers", async (req, res) => {
  const rows = await withContext(req.ctx, async (db) =>
    (await db.query(
      `SELECT o.trip_id AS "tripId", o.distance_m AS "distanceToPickupM", o.eta_s AS "etaToPickupS",
              o.expires_at AS "expiresAt",
              t.fare_estimate AS "fareEstimate", t.pickup_address AS "pickupAddress",
              t.dropoff_address AS "dropoffAddress", t.est_distance_m AS "tripDistanceM"
         FROM trip_offers o JOIN trips t ON t.id = o.trip_id
        WHERE o.driver_id = app.uid() AND o.status = 'pending' AND o.expires_at > now()
        ORDER BY o.offered_at DESC`,
    )).rows,
  );
  res.json({ data: rows });
});
