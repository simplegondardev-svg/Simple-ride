import { Router } from "express";
import { withContext } from "../../db/context.js";

export const catalogRouter = Router();

/** Public: the ride products shown in the booking screen. */
catalogRouter.get("/vehicle-categories", async (req, res) => {
  const rows = await withContext(req.ctx, async (db) =>
    (await db.query(
      `SELECT code, name, seats, base_fare AS "baseFare", per_km AS "perKm",
              per_minute AS "perMinute", minimum_fare AS "minimumFare", booking_fee AS "bookingFee"
         FROM vehicle_categories WHERE is_active ORDER BY sort_order`,
    )).rows,
  );
  res.json({ data: rows });
});
