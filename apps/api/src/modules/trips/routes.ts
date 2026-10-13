import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../../auth/middleware.js";
import { withContext } from "../../db/context.js";
import { notFound } from "../../lib/errors.js";
import { latLng, page, place, uuidParam } from "../../lib/schemas.js";
import {
  acceptTrip, cancelTrip, completeTrip, createTrip, declineOffer, driverTransition, estimate,
  TRIP_COLUMNS,
} from "./service.js";

export const tripsRouter = Router();
tripsRouter.use(requireAuth);

tripsRouter.post("/estimate", async (req, res) => {
  const body = z.object({ pickup: latLng, dropoff: latLng }).parse(req.body);
  res.json(await estimate(req.ctx, body.pickup, body.dropoff));
});

tripsRouter.post("/", requireRole("customer"), async (req, res) => {
  const body = z
    .object({
      clientRequestId: z.uuid(),
      categoryCode: z.string(),
      pickup: place,
      dropoff: place,
      paymentMethod: z.enum(["cash", "telebirr", "wallet"]).default("cash"),
    })
    .parse(req.body);
  const { trip, created } = await createTrip(req.ctx, body);
  res.status(created ? 201 : 200).json(trip);
});

tripsRouter.get("/", async (req, res) => {
  const q = page.parse(req.query);
  const rows = await withContext(req.ctx, async (db) =>
    (await db.query(
      `SELECT ${TRIP_COLUMNS} FROM trips t
        WHERE (t.customer_id = app.uid() OR t.driver_id = app.uid())
          AND ($1::timestamptz IS NULL OR t.requested_at < $1)
        ORDER BY t.requested_at DESC LIMIT $2`,
      [q.before ?? null, q.limit],
    )).rows,
  );
  res.json({ data: rows, nextBefore: rows.length === q.limit ? rows.at(-1).requestedAt : null });
});

tripsRouter.get("/:id", async (req, res) => {
  const { id } = uuidParam.parse(req.params);
  const trip = await withContext(req.ctx, async (db) => {
    // RLS decides visibility: rider, driver, offered driver, or staff.
    const { rows } = await db.query(
      `SELECT ${TRIP_COLUMNS},
         CASE WHEN d.id IS NULL THEN NULL ELSE json_build_object(
           'id', d.id, 'fullName', d.full_name, 'phone', d.phone,
           'rating', dp.rating_avg,
           'vehicle', json_build_object('plateNumber', v.plate_number, 'make', v.make,
                                        'model', v.model, 'color', v.color)) END AS driver
       FROM trips t
       LEFT JOIN users d ON d.id = t.driver_id
       LEFT JOIN driver_profiles dp ON dp.user_id = t.driver_id
       LEFT JOIN vehicles v ON v.id = t.vehicle_id
       WHERE t.id = $1`,
      [id],
    );
    return rows[0];
  });
  if (!trip) throw notFound("Trip");
  // The PIN proves to the rider they're in the right car; drivers must ask for it.
  if (trip.customerId !== req.ctx.userId) delete trip.ridePin;
  res.json(trip);
});

tripsRouter.post("/:id/cancel", async (req, res) => {
  const { id } = uuidParam.parse(req.params);
  const { reason } = z.object({ reason: z.string().max(300).optional() }).parse(req.body ?? {});
  res.json(await cancelTrip(req.ctx, id, reason));
});

// ── Driver actions ──
tripsRouter.post("/:id/accept", requireRole("driver"), async (req, res) => {
  const { id } = uuidParam.parse(req.params);
  res.json(await acceptTrip(req.ctx.userId!, id));
});

tripsRouter.post("/:id/decline", requireRole("driver"), async (req, res) => {
  const { id } = uuidParam.parse(req.params);
  await declineOffer(req.ctx, id);
  res.status(204).end();
});

tripsRouter.post("/:id/arrive", requireRole("driver"), async (req, res) => {
  const { id } = uuidParam.parse(req.params);
  res.json(await driverTransition(req.ctx, id, "arrive"));
});

tripsRouter.post("/:id/start", requireRole("driver"), async (req, res) => {
  const { id } = uuidParam.parse(req.params);
  const { ridePin } = z.object({ ridePin: z.string().regex(/^\d{4}$/) }).parse(req.body);
  res.json(await driverTransition(req.ctx, id, "start", ridePin));
});

tripsRouter.post("/:id/complete", requireRole("driver"), async (req, res) => {
  const { id } = uuidParam.parse(req.params);
  res.json(await completeTrip(req.ctx.userId!, id));
});

tripsRouter.post("/:id/rate", async (req, res) => {
  const { id } = uuidParam.parse(req.params);
  const body = z
    .object({ score: z.number().int().min(1).max(5), comment: z.string().max(500).optional() })
    .parse(req.body);
  await withContext(req.ctx, async (db) => {
    const { rows: [t] } = await db.query("SELECT customer_id, driver_id FROM trips WHERE id = $1", [id]);
    if (!t) throw notFound("Trip");
    const ratee = t.customer_id === req.ctx.userId ? t.driver_id : t.customer_id;
    // RLS (app.can_rate) enforces: completed trip, counter-party only.
    await db.query(
      "INSERT INTO ratings (trip_id, rater_id, ratee_id, score, comment) VALUES ($1, app.uid(), $2, $3, $4)",
      [id, ratee, body.score, body.comment ?? null],
    );
  });
  res.status(201).json({ ok: true });
});
