import { z } from "zod";

/** Coordinates in the API are always { lat, lng } objects (never arrays). */
export const latLng = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

export const place = latLng.extend({ address: z.string().max(300).optional() });

export const uuidParam = z.object({ id: z.uuid() });

/** Cursor pagination: ?limit=20&before=<ISO timestamp> */
export const page = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  before: z.iso.datetime({ offset: true }).optional(),
});
