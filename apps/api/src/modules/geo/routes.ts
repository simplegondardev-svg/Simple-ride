import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../../auth/middleware.js";
import { AppError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { rateLimit } from "../../lib/rate-limit.js";
import { geocode, reverseGeocode } from "./gebeta.js";

/**
 * Server-side proxy for Gebeta geocoding: keeps the API key off devices,
 * caches results, and rate-limits per user.
 */
export const geoRouter = Router();
geoRouter.use(requireAuth);

const upstream = (err: unknown): never => {
  logger.warn({ err }, "Gebeta geocoding failed");
  throw new AppError(502, "MAPS_UNAVAILABLE", "Map service unavailable");
};

geoRouter.get("/search", async (req, res) => {
  // lat/lng (optional): the rider's position, so nearby matches rank first.
  const { q, lat, lng } = z
    .object({
      q: z.string().trim().min(2).max(100),
      lat: z.coerce.number().min(-90).max(90).optional(),
      lng: z.coerce.number().min(-180).max(180).optional(),
    })
    .parse(req.query);
  await rateLimit(`geo:${req.ctx.userId}`, 60, 60);
  const near = lat !== undefined && lng !== undefined ? { lat, lng } : undefined;
  res.json({ data: await geocode(q, near).catch(upstream) });
});

geoRouter.get("/reverse", async (req, res) => {
  const p = z.object({
    lat: z.coerce.number().min(-90).max(90),
    lng: z.coerce.number().min(-180).max(180),
  }).parse(req.query);
  await rateLimit(`geo:${req.ctx.userId}`, 60, 60);
  res.json({ data: await reverseGeocode(p).catch(upstream) });
});
