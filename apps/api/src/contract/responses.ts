import { z } from "zod";

/**
 * Response models for the app-facing API (what Flutter and web clients
 * receive). Registered by name so the OpenAPI spec exposes them as reusable
 * components and the generated Dart client gets real classes.
 *
 * Contract tests (test/contract.test.ts) validate live responses against
 * these, so they can't silently drift from the SQL that produces them.
 * Adding a field is safe; renaming or removing one is a breaking change
 * (→ /api/v2).
 */
export const models = z.registry<{ id: string; description?: string }>();
const model = <T extends z.ZodType>(id: string, schema: T, description?: string): T => {
  models.add(schema, { id, description });
  return schema;
};

const isoTime = z.iso.datetime({ offset: true });
const santim = z.number().int().describe("Money in santim (1 ETB = 100 santim)");

export const ErrorBody = model("Error", z.object({
  error: z.object({
    code: z.string().describe("Stable machine-readable code, see docs/ERRORS.md"),
    message: z.string().describe("Developer-facing message; show your own localised text"),
    details: z.unknown().optional(),
  }),
}));

export const Role = model("Role", z.enum(["customer", "driver", "admin", "staff"]));

export const User = model("User", z.object({
  id: z.uuid(),
  phone: z.string().describe("E.164, e.g. +251911223344"),
  role: Role,
  status: z.enum(["active", "suspended", "deleted"]),
  fullName: z.string().nullable(),
  email: z.string().nullable().optional(),
  locale: z.enum(["am", "en", "om", "ti"]),
  createdAt: isoTime.optional(),
}));

export const TokenPair = model("TokenPair", z.object({
  accessToken: z.string().describe("JWT, ~15 minutes. Send as Authorization: Bearer"),
  refreshToken: z.string().describe("Opaque. Store securely; rotated on every refresh"),
}));

export const AuthSession = model("AuthSession", TokenPair.extend({ user: User }));

export const WalletTransaction = model("WalletTransaction", z.object({
  id: z.number().int(),
  amount: santim.describe("Signed: credit > 0, debit < 0 (santim)"),
  balanceAfter: santim,
  kind: z.enum(["topup", "trip_payment", "trip_earning", "commission", "payout", "refund", "bonus", "adjustment"]),
  tripId: z.uuid().nullable(),
  createdAt: isoTime,
}));

export const Wallet = model("Wallet", z.object({
  balance: santim,
  currency: z.string(),
  transactions: z.array(WalletTransaction),
}));

export const VehicleCategory = model("VehicleCategory", z.object({
  code: z.string(),
  name: z.string(),
  seats: z.number().int(),
  baseFare: santim,
  perKm: santim,
  perMinute: santim,
  minimumFare: santim,
  bookingFee: santim,
}));

export const Place = model("Place", z.object({
  id: z.string().optional(),
  name: z.string(),
  displayName: z.string(),
  lat: z.number(),
  lng: z.number(),
  neighborhood: z.string().optional(),
  city: z.string().optional(),
  category: z.string().optional(),
}));

export const FareOption = model("FareOption", z.object({
  categoryCode: z.string(),
  name: z.string(),
  seats: z.number().int(),
  fare: santim,
  currency: z.string(),
  driversNearby: z.boolean(),
}));

export const Estimate = model("Estimate", z.object({
  distanceM: z.number().int(),
  durationS: z.number().int(),
  routeSource: z.enum(["gebeta", "estimate"]),
  path: z.array(z.tuple([z.number(), z.number()])).describe("Route as [lng, lat] pairs (GeoJSON order); empty for estimates"),
  options: z.array(FareOption),
}));

export const TripPlace = model("TripPlace", z.object({
  lat: z.number(),
  lng: z.number(),
  address: z.string().nullable(),
}));

export const TripStatus = model("TripStatus",
  z.enum(["searching", "accepted", "arrived", "in_progress", "completed", "cancelled", "expired"]));

export const Trip = model("Trip", z.object({
  id: z.uuid(),
  status: TripStatus,
  categoryCode: z.string(),
  customerId: z.uuid(),
  driverId: z.uuid().nullable(),
  vehicleId: z.uuid().nullable(),
  pickup: TripPlace,
  dropoff: TripPlace,
  estDistanceM: z.number().int().nullable(),
  estDurationS: z.number().int().nullable(),
  fareEstimate: santim.describe("Upfront quote (santim)"),
  finalFare: santim.nullable().describe("Quote + overtime, set at completion (santim)"),
  overtimeAmount: santim.describe("Extra minutes charged at completion, capped (santim)"),
  currency: z.string(),
  paymentMethod: z.enum(["cash", "telebirr", "wallet"]),
  paymentStatus: z.enum(["pending", "paid", "failed", "refunded"]),
  ridePin: z.string().optional().describe("Only returned to the rider; the driver asks for it at pickup"),
  scheduledFor: isoTime.nullable(),
  requestedAt: isoTime,
  acceptedAt: isoTime.nullable(),
  arrivedAt: isoTime.nullable(),
  startedAt: isoTime.nullable(),
  completedAt: isoTime.nullable(),
  cancelledAt: isoTime.nullable(),
  cancelledBy: z.enum(["customer", "driver", "admin", "system"]).nullable(),
  cancelReason: z.string().nullable(),
}));

export const TripDriver = model("TripDriver", z.object({
  id: z.uuid(),
  fullName: z.string().nullable(),
  phone: z.string(),
  rating: z.number(),
  vehicle: z.object({ plateNumber: z.string(), make: z.string(), model: z.string(), color: z.string() }),
}));

export const TripDetail = model("TripDetail", Trip.extend({ driver: TripDriver.nullable() }));

export const TripPage = model("TripPage", z.object({
  data: z.array(Trip),
  nextBefore: isoTime.nullable().describe("Pass as ?before= to load the next page; null at the end"),
}));

export const Vehicle = model("Vehicle", z.object({
  id: z.uuid(),
  categoryCode: z.string(),
  plateNumber: z.string(),
  make: z.string(),
  model: z.string(),
  color: z.string(),
  year: z.number().int().nullable(),
  status: z.enum(["pending", "approved", "rejected", "suspended"]),
  isCurrent: z.boolean(),
}));

export const DriverMe = model("DriverMe", z.object({
  approvalStatus: z.enum(["pending", "approved", "rejected", "suspended"]),
  licenseNumber: z.string().nullable(),
  licenseExpiresOn: z.iso.date().nullable(),
  availability: z.enum(["offline", "online", "on_trip"]),
  ratingAvg: z.number(),
  ratingCount: z.number().int(),
  acceptanceRate: z.number().nullable().describe("Share of recent offers accepted (0–1); null before any offers"),
  vehicles: z.array(Vehicle),
}));

export const TripOffer = model("TripOffer", z.object({
  tripId: z.uuid(),
  distanceToPickupM: z.number().int().nullable(),
  etaToPickupS: z.number().int().nullable(),
  expiresAt: isoTime,
  fareEstimate: santim,
  pickupAddress: z.string().nullable(),
  dropoffAddress: z.string().nullable(),
  tripDistanceM: z.number().int().nullable(),
}));

export const Availability = model("Availability", z.object({
  availability: z.enum(["offline", "online", "on_trip"]),
  categoryCode: z.string().optional(),
}));

export const Ok = model("Ok", z.object({ ok: z.boolean().describe("Always true") }));
export const Created = model("Created", z.object({ id: z.uuid(), status: z.string() }));
export const Health = model("Health", z.object({ status: z.string().describe('"ok" when the database and Redis respond') }));

/** Back-office responses aren't consumed by the mobile apps; documented loosely. */
export const AdminObject = model("AdminObject", z.record(z.string(), z.unknown()));
