import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../../auth/middleware.js";
import { AppError } from "../../lib/errors.js";
import { rateLimit } from "../../lib/rate-limit.js";
import { geocode, reverseGeocode } from "./gebeta.js";

/**
 * Server-side proxy for Gebeta geocoding: keeps the API key off devices,
 * caches results, and rate-limits per user.
 */
export const geoRouter = Router();
geoRouter.use(requireAuth);

const upstream = (err: unknown) => {
  throw new AppError(502, "MAPS_UNAVAILABLE", "Map service unavailable", String(err));
};

geoRouter.get("/search", async (req, res) => {
  const { q } = z.object({ q: z.string().trim().min(2).max(100) }).parse(req.query);
  await rateLimit(`geo:${req.ctx.userId}`, 60, 60);
  res.json({ data: await geocode(q).catch(upstream) });
});

geoRouter.get("/reverse", async (req, res) => {
  const p = z.object({ lat: z.coerce.number(), lng: z.coerce.number() }).parse(req.query);
  await rateLimit(`geo:${req.ctx.userId}`, 60, 60);
  res.json({ data: await reverseGeocode(p).catch(upstream) });
});
