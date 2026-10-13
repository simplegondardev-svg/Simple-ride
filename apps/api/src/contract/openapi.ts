import { z } from "zod";
import * as adm from "../modules/admin/routes.js";
import * as auth from "../auth/routes.js";
import * as drv from "../modules/drivers/routes.js";
import * as geo from "../modules/geo/routes.js";
import * as trips from "../modules/trips/routes.js";
import * as users from "../modules/users/routes.js";
import { page, uuidParam } from "../lib/schemas.js";
import * as R from "./responses.js";

/**
 * OpenAPI 3.1 description of /api/v1, served at GET /api/v1/openapi.json.
 *
 * Request schemas are the exact Zod objects the routes validate with, so the
 * spec can't drift from validation. test/openapi.test.ts fails if a route
 * exists without an entry here (or the other way round), and contract tests
 * check real responses against the response models.
 */

type Access = "public" | "user" | "customer" | "driver" | "backoffice" | "admin";

interface Operation {
  method: "get" | "post" | "put" | "patch" | "delete";
  /** Express-style path under /api/v1, e.g. /trips/:id */
  path: string;
  tag: string;
  summary: string;
  access: Access;
  /** Staff permission(s), any of which grants access (admins always pass). */
  permission?: string[];
  params?: z.ZodType;
  query?: z.ZodType;
  body?: z.ZodType;
  /** Success status → response model (null = no body). */
  ok: [number, z.ZodType | null];
  description?: string;
}

const id = uuidParam;

export const operations: Operation[] = [
  // ── Auth
  { method: "post", path: "/auth/register", tag: "Auth", access: "public", summary: "Create a rider or driver account",
    body: auth.registerBody, ok: [201, R.AuthSession],
    description: "Phone numbers are not verified yet (testing phase). Errors: ACCOUNT_EXISTS, WEAK_PASSWORD, RATE_LIMITED." },
  { method: "post", path: "/auth/login", tag: "Auth", access: "public", summary: "Log in with phone and password (all roles)",
    body: auth.loginBody, ok: [200, R.AuthSession],
    description: "On 409 PASSWORD_CHANGE_REQUIRED (temporary password), repeat the call with `newPassword`. Other errors: INVALID_CREDENTIALS, ACCOUNT_LOCKED (details.lockedUntil), ACCOUNT_SUSPENDED." },
  { method: "post", path: "/auth/password/change", tag: "Auth", access: "user", summary: "Change password; signs out other devices",
    body: auth.changePasswordBody, ok: [200, R.TokenPair] },
  { method: "post", path: "/auth/refresh", tag: "Auth", access: "public", summary: "Exchange a refresh token for a new pair",
    body: auth.refreshBody, ok: [200, R.TokenPair],
    description: "Refresh tokens rotate: always store the new one. Reusing an old one ends the session (INVALID_REFRESH_TOKEN)." },
  { method: "post", path: "/auth/logout", tag: "Auth", access: "public", summary: "End this device's session",
    body: auth.logoutBody, ok: [204, null] },

  // ── Me
  { method: "get", path: "/users/me", tag: "Me", access: "user", summary: "Current user", ok: [200, R.User] },
  { method: "patch", path: "/users/me", tag: "Me", access: "user", summary: "Update name, email or language",
    body: users.updateMeBody, ok: [200, R.User] },
  { method: "put", path: "/users/me/push-token", tag: "Me", access: "user", summary: "Register this device's FCM token",
    body: users.pushTokenBody, ok: [204, null] },
  { method: "get", path: "/users/me/wallet", tag: "Me", access: "user", summary: "Wallet balance and the last 20 movements",
    ok: [200, R.Wallet] },

  // ── Catalog & maps
  { method: "get", path: "/catalog/vehicle-categories", tag: "Catalog", access: "public", summary: "Ride products and fare rules",
    ok: [200, z.object({ data: z.array(R.VehicleCategory) })] },
  { method: "get", path: "/geo/search", tag: "Maps", access: "user", summary: "Search places in Ethiopia (nearby first)",
    query: geo.placeSearchQuery, ok: [200, z.object({ data: z.array(R.Place) })],
    description: "Pass the rider's lat/lng so nearby matches rank first. 502 MAPS_UNAVAILABLE if Gebeta is down." },
  { method: "get", path: "/geo/reverse", tag: "Maps", access: "user", summary: "Places at a coordinate",
    query: geo.reverseGeocodeQuery, ok: [200, z.object({ data: z.array(R.Place) })] },

  // ── Trips (rider)
  { method: "post", path: "/trips/estimate", tag: "Trips", access: "user", summary: "Route and fare for each vehicle type",
    body: trips.estimateBody, ok: [200, R.Estimate],
    description: "Errors: OUT_OF_SERVICE_AREA, RESTRICTED_AREA." },
  { method: "post", path: "/trips", tag: "Trips", access: "customer", summary: "Request a ride",
    body: trips.createTripBody, ok: [201, R.Trip],
    description: "Idempotent on clientRequestId: a retry returns the original trip with 200. Errors: ACTIVE_TRIP_EXISTS, UNKNOWN_CATEGORY, OUT_OF_SERVICE_AREA." },
  { method: "get", path: "/trips", tag: "Trips", access: "user", summary: "My trips, newest first", query: page, ok: [200, R.TripPage] },
  { method: "get", path: "/trips/:id", tag: "Trips", access: "user", summary: "Trip with driver and vehicle details",
    params: id, ok: [200, R.TripDetail],
    description: "Re-fetch this after reconnecting: socket events are hints, this is the truth." },
  { method: "post", path: "/trips/:id/cancel", tag: "Trips", access: "user", summary: "Cancel (rider) or back out (driver)",
    params: id, body: trips.cancelTripBody, ok: [200, R.Trip],
    description: "A driver backing out of an accepted trip returns it to searching for the rider. Not possible once started (INVALID_TRANSITION)." },
  { method: "post", path: "/trips/:id/rate", tag: "Trips", access: "user", summary: "Rate the other party of a completed trip",
    params: id, body: trips.rateTripBody, ok: [201, R.Ok] },

  // ── Trips (driver)
  { method: "post", path: "/trips/:id/accept", tag: "Driver trips", access: "driver", summary: "Accept an offer",
    params: id, ok: [200, R.Trip], description: "Errors: OFFER_NOT_AVAILABLE, TRIP_ALREADY_TAKEN, DRIVER_BUSY, NO_ACTIVE_VEHICLE." },
  { method: "post", path: "/trips/:id/decline", tag: "Driver trips", access: "driver", summary: "Decline an offer",
    params: id, ok: [204, null] },
  { method: "post", path: "/trips/:id/arrive", tag: "Driver trips", access: "driver", summary: "At the pickup",
    params: id, ok: [200, R.Trip] },
  { method: "post", path: "/trips/:id/start", tag: "Driver trips", access: "driver", summary: "Start the ride (rider's PIN)",
    params: id, body: trips.startTripBody, ok: [200, R.Trip], description: "Errors: WRONG_RIDE_PIN, INVALID_TRANSITION." },
  { method: "post", path: "/trips/:id/complete", tag: "Driver trips", access: "driver", summary: "Complete; final fare includes overtime",
    params: id, ok: [200, R.Trip] },

  // ── Driver
  { method: "get", path: "/drivers/me", tag: "Driver", access: "driver", summary: "Profile, approval, vehicles, acceptance rate",
    ok: [200, R.DriverMe] },
  { method: "put", path: "/drivers/me/profile", tag: "Driver", access: "driver", summary: "Licence details",
    body: drv.driverProfileBody, ok: [204, null] },
  { method: "post", path: "/drivers/me/vehicles", tag: "Driver", access: "driver", summary: "Register a vehicle (pending review)",
    body: drv.addVehicleBody, ok: [201, R.Created], description: "Errors: PLATE_TAKEN, UNKNOWN_CATEGORY." },
  { method: "post", path: "/drivers/me/online", tag: "Driver", access: "driver", summary: "Go online at a location",
    body: drv.goOnlineBody, ok: [200, R.Availability],
    description: "Errors: DRIVER_NOT_APPROVED, NO_ACTIVE_VEHICLE, ON_TRIP. Then send driver:location over the socket every 3–5 s; drivers silent for 60 s are taken offline." },
  { method: "post", path: "/drivers/me/offline", tag: "Driver", access: "driver", summary: "Go offline", ok: [200, R.Availability] },
  { method: "post", path: "/drivers/me/location", tag: "Driver", access: "driver", summary: "Location ping (HTTP fallback for the socket)",
    body: drv.locationBody, ok: [204, null] },
  { method: "get", path: "/drivers/me/offers", tag: "Driver", access: "driver", summary: "Open offers",
    ok: [200, z.object({ data: z.array(R.TripOffer) })] },

  // ── Back office (web dashboard)
  { method: "get", path: "/admin/me", tag: "Back office", access: "backoffice", summary: "Role and permissions of the signed-in staff member", ok: [200, R.AdminObject] },
  { method: "get", path: "/admin/permissions", tag: "Back office", access: "backoffice", summary: "Permission catalogue", ok: [200, R.AdminObject] },
  { method: "get", path: "/admin/stats", tag: "Back office", access: "backoffice", permission: ["dashboard.view"], summary: "Dashboard counts", ok: [200, R.AdminObject] },
  { method: "get", path: "/admin/users", tag: "Back office", access: "backoffice", permission: ["users.view", "users.suspend", "users.reset_password"], summary: "Search riders and drivers", query: adm.adminUsersQuery, ok: [200, R.AdminObject] },
  { method: "patch", path: "/admin/users/:id/status", tag: "Back office", access: "backoffice", permission: ["users.suspend"], summary: "Suspend or reactivate", params: id, body: adm.userStatusBody, ok: [200, R.AdminObject] },
  { method: "post", path: "/admin/users/:id/reset-password", tag: "Back office", access: "backoffice", permission: ["users.reset_password"], summary: "Issue a temporary password", params: id, ok: [200, R.AdminObject] },
  { method: "get", path: "/admin/drivers/pending", tag: "Back office", access: "backoffice", permission: ["drivers.view", "drivers.approve"], summary: "Driver onboarding queue", ok: [200, R.AdminObject] },
  { method: "post", path: "/admin/drivers/:id/review", tag: "Back office", access: "backoffice", permission: ["drivers.approve"], summary: "Approve or reject a driver and vehicle", params: id, body: adm.driverReviewBody, ok: [200, R.AdminObject] },
  { method: "get", path: "/admin/trips", tag: "Back office", access: "backoffice", permission: ["trips.view"], summary: "Recent trips", query: adm.adminTripsQuery, ok: [200, R.AdminObject] },
  { method: "post", path: "/admin/trips/:id/cancel", tag: "Back office", access: "backoffice", permission: ["trips.cancel"], summary: "Cancel a trip", params: id, body: adm.adminCancelTripBody, ok: [200, R.AdminObject] },
  { method: "get", path: "/admin/finance/daybook", tag: "Back office", access: "backoffice", permission: ["finance.daybook.view"], summary: "Day book for one Addis Ababa day", query: adm.daybookQuery, ok: [200, R.AdminObject] },
  { method: "get", path: "/admin/wallets/:id", tag: "Back office", access: "backoffice", permission: ["finance.wallets.view", "finance.wallets.adjust"], summary: "A user's wallet", params: id, ok: [200, R.AdminObject] },
  { method: "post", path: "/admin/wallets/:id/adjust", tag: "Back office", access: "backoffice", permission: ["finance.wallets.adjust"], summary: "Manual credit or debit", params: id, body: adm.walletAdjustBody, ok: [200, R.AdminObject] },
  { method: "get", path: "/admin/settings", tag: "Back office", access: "backoffice", permission: ["pricing.manage"], summary: "Business settings", ok: [200, R.AdminObject] },
  { method: "patch", path: "/admin/settings", tag: "Back office", access: "backoffice", permission: ["pricing.manage"], summary: "Change business settings", body: adm.settingsBody, ok: [200, R.AdminObject] },
  { method: "get", path: "/admin/audit", tag: "Back office", access: "backoffice", permission: ["audit.view"], summary: "Audit log", query: page, ok: [200, R.AdminObject] },
  { method: "get", path: "/admin/staff", tag: "Back office", access: "admin", summary: "Staff and their permissions", ok: [200, R.AdminObject] },
  { method: "post", path: "/admin/staff", tag: "Back office", access: "admin", summary: "Create a staff member (returns a temporary password once)", body: adm.createStaffBody, ok: [201, R.AdminObject] },
  { method: "put", path: "/admin/staff/:id/permissions", tag: "Back office", access: "admin", summary: "Replace a staff member's permissions", params: id, body: adm.staffPermissionsBody, ok: [200, R.AdminObject] },
  { method: "post", path: "/admin/staff/:id/reset-password", tag: "Back office", access: "admin", summary: "Reset a staff password", params: id, ok: [200, R.AdminObject] },
];

// ───────────────────────── Builder ─────────────────────────

const REF = (id: string) => `#/components/schemas/${id}`;

/** Tidy Zod's JSON Schema for OpenAPI: components refs, no noise. */
function tidy(node: any, io: "input" | "output"): any {
  if (Array.isArray(node)) return node.map((n) => tidy(n, io));
  if (!node || typeof node !== "object") return node;
  const out: any = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "$schema" || k === "$id" || k === "$defs") continue;
    // Formats (uuid, date, date-time) say enough; Zod's long regexes don't help clients.
    if (k === "pattern" && node.format) continue;
    // Responses may gain fields over time; clients must ignore unknown ones.
    if (k === "additionalProperties" && v === false && io === "output") continue;
    if (k === "maximum" && v === Number.MAX_SAFE_INTEGER) continue;
    if (k === "minimum" && v === Number.MIN_SAFE_INTEGER) continue;
    out[k] = k === "$ref" && typeof v === "string" ? v.replace("#/$defs/", "#/components/schemas/") : tidy(v, io);
  }
  // Dart generators emit invalid code for enums with defaults; the API applies
  // the default anyway, so state it in the description instead.
  if (Array.isArray(out.enum) && "default" in out) {
    out.description = [out.description, `Default: ${out.default}`].filter(Boolean).join(". ");
    delete out.default;
  }
  return out;
}

// `metadata` makes registered models come out as $refs; Zod's typings omit it for single schemas.
const jsonSchemaOptions = (io: "input" | "output") =>
  ({ io, metadata: R.models, unrepresentable: "any", uri: REF }) as unknown as Parameters<typeof z.toJSONSchema>[1];
const toSchema = (s: z.ZodType, io: "input" | "output") => tidy(z.toJSONSchema(s, jsonSchemaOptions(io)), io);

const ERRORS: Record<number, string> = {
  401: "Not logged in or session expired (UNAUTHENTICATED, INVALID_TOKEN, ACCOUNT_INACTIVE)",
  403: "Not allowed (FORBIDDEN, MISSING_PERMISSION)",
  404: "Not found",
  409: "Conflict with the current state",
  422: "Invalid input (VALIDATION_FAILED with details) or a business rule",
  429: "Too many requests (RATE_LIMITED)",
};

export function buildOpenApi() {
  const paths: Record<string, any> = {};
  for (const op of operations) {
    const path = op.path.replace(/:(\w+)/g, "{$1}");
    const parameters: any[] = [];
    for (const [where, schema] of [["path", op.params], ["query", op.query]] as const) {
      if (!schema) continue;
      const js = toSchema(schema, "input");
      for (const [name, prop] of Object.entries<any>(js.properties ?? {})) {
        parameters.push({
          name, in: where, required: where === "path" || (js.required ?? []).includes(name),
          schema: prop, ...(prop.description && { description: prop.description }),
        });
      }
    }
    const security = op.access === "public" ? [] : [{ bearer: [] }];
    const who = {
      public: "Anyone.", user: "Any signed-in user.", customer: "Riders.", driver: "Drivers.",
      backoffice: op.permission ? `Admins, or staff with: ${op.permission.join(" or ")}.` : "Admins and staff.",
      admin: "Admins only.",
    }[op.access];
    const [status, model] = op.ok;
    const responses: Record<string, any> = {
      [status]: model
        ? { description: "OK", content: { "application/json": { schema: toSchema(model, "output") } } }
        : { description: "No content" },
    };
    const errorCodes = op.access === "public" ? [409, 422, 429] : [401, 403, 404, 409, 422];
    for (const code of errorCodes) {
      responses[code] = { description: ERRORS[code], content: { "application/json": { schema: { $ref: REF("Error") } } } };
    }
    paths[path] ??= {};
    paths[path][op.method] = {
      operationId: operationId(op),
      tags: [op.tag],
      summary: op.summary,
      description: [who, op.description].filter(Boolean).join("\n\n"),
      security,
      ...(parameters.length && { parameters }),
      ...(op.body && {
        requestBody: { required: true, content: { "application/json": { schema: toSchema(op.body, "input") } } },
      }),
      responses,
    };
  }

  const registry = z.toJSONSchema(R.models, { io: "output", unrepresentable: "any", uri: REF }) as { schemas: Record<string, any> };
  const schemas = Object.fromEntries(
    Object.entries(registry.schemas).map(([name, s]) => [name, tidy(s, "output")]),
  );

  return {
    openapi: "3.1.0",
    info: {
      title: "Simple Ride API",
      version: "1.0.0",
      description: [
        "Ride hailing for Ethiopia. Conventions: camelCase JSON; money in integer **santim** (1 ETB = 100);",
        "coordinates as `{ lat, lng }`; timestamps ISO-8601 UTC; errors as `{ error: { code, message, details } }`",
        "with stable codes (docs/ERRORS.md). Breaking changes go to /api/v2.",
        "",
        "**Realtime (Socket.IO, `auth: { token }`):** server → driver `trip:offer`; server → both parties",
        "`trip:updated` (the Trip); server → rider `driver:location` `{ tripId, lat, lng, heading }`;",
        "server → driver `driver:availability`; driver → server `driver:location` `{ lat, lng, heading? }`.",
        "Treat events as hints and re-fetch GET /trips/{id} after reconnecting.",
      ].join("\n"),
    },
    servers: [{ url: "/api/v1" }],
    tags: [...new Set(operations.map((o) => o.tag))].map((name) => ({ name })),
    components: {
      securitySchemes: { bearer: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
      schemas,
    },
    paths,
  };
}

function operationId(op: Operation) {
  const words = `${op.method} ${op.path}`
    .replace(/:(\w+)/g, "by $1")
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean);
  return words.map((w, i) => (i === 0 ? w.toLowerCase() : w[0]!.toUpperCase() + w.slice(1))).join("");
}
