import type { PoolClient } from "pg";
import { SYSTEM, withContext, type DbContext } from "../../db/context.js";
import { AppError, conflict, notFound } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { redis } from "../../lib/redis.js";
import { emitToUser } from "../../realtime/socket.js";
import { findNearby, getPosition, setAvailable, setUnavailable } from "../drivers/presence.js";
import { getRoute, type LatLng } from "../geo/gebeta.js";
import { calculateFare, type FareRules } from "../pricing/fare.js";
import { TRANSITIONS, type TripAction } from "./state-machine.js";

const OFFER_TTL_S = 20;
const OFFER_BATCH = 5;
const SEARCH_TIMEOUT_S = 180;

/** Columns returned to clients. Coordinates are flattened to {lat,lng}. */
export const TRIP_COLUMNS = `
  t.id, t.status, t.category_code AS "categoryCode",
  t.customer_id AS "customerId", t.driver_id AS "driverId", t.vehicle_id AS "vehicleId",
  json_build_object('lat', ST_Y(t.pickup::geometry), 'lng', ST_X(t.pickup::geometry),
                    'address', t.pickup_address) AS pickup,
  json_build_object('lat', ST_Y(t.dropoff::geometry), 'lng', ST_X(t.dropoff::geometry),
                    'address', t.dropoff_address) AS dropoff,
  t.est_distance_m AS "estDistanceM", t.est_duration_s AS "estDurationS",
  t.fare_estimate AS "fareEstimate", t.final_fare AS "finalFare", t.currency,
  t.payment_method AS "paymentMethod", t.payment_status AS "paymentStatus",
  t.ride_pin AS "ridePin", t.scheduled_for AS "scheduledFor",
  t.requested_at AS "requestedAt", t.accepted_at AS "acceptedAt", t.arrived_at AS "arrivedAt",
  t.started_at AS "startedAt", t.completed_at AS "completedAt", t.cancelled_at AS "cancelledAt",
  t.cancelled_by AS "cancelledBy", t.cancel_reason AS "cancelReason"`;

const point = (p: LatLng) => `ST_SetSRID(ST_MakePoint(${p.lng}, ${p.lat}), 4326)::geography`;

function rulesFrom(row: any): FareRules {
  return {
    baseFare: row.base_fare, perKm: row.per_km, perMinute: row.per_minute,
    minimumFare: row.minimum_fare, bookingFee: row.booking_fee, commissionBps: row.commission_bps,
  };
}

/**
 * Zone rules for a pickup/dropoff pair. If any operating zones exist the
 * pickup must be inside one; restricted zones block both ends. With no zones
 * configured (fresh dev DB) everything is allowed.
 */
async function zoneCheck(db: PoolClient, pickup: LatLng, dropoff: LatLng): Promise<number> {
  const { rows } = await db.query<{ operating: number; inside: boolean; restricted: boolean; multiplier: number }>(
    `SELECT
       count(*) FILTER (WHERE kind = 'operating')::int AS operating,
       coalesce(bool_or(kind = 'operating' AND ST_Covers(area, ${point(pickup)})), false) AS inside,
       coalesce(bool_or(kind = 'restricted' AND (ST_Covers(area, ${point(pickup)})
                                             OR ST_Covers(area, ${point(dropoff)}))), false) AS restricted,
       coalesce(max(fare_multiplier) FILTER (WHERE kind <> 'restricted'
                                             AND ST_Covers(area, ${point(pickup)})), 1) AS multiplier
     FROM service_zones WHERE is_active`,
  );
  const z = rows[0]!;
  if (z.restricted) throw new AppError(422, "RESTRICTED_AREA", "Pickups and drop-offs are not allowed here");
  if (z.operating > 0 && !z.inside) {
    throw new AppError(422, "OUT_OF_SERVICE_AREA", "We don't operate at this pickup location yet");
  }
  return Number(z.multiplier);
}

export async function estimate(ctx: DbContext, pickup: LatLng, dropoff: LatLng) {
  const route = await getRoute(pickup, dropoff);
  return withContext(ctx, async (db) => {
    const multiplier = await zoneCheck(db, pickup, dropoff);
    const { rows } = await db.query(
      "SELECT * FROM vehicle_categories WHERE is_active ORDER BY sort_order",
    );
    const options = await Promise.all(
      rows.map(async (c) => {
        const fare = calculateFare(rulesFrom(c), route.distanceM, route.durationS, multiplier);
        const nearby = await findNearby(c.code, pickup, 5000, 1);
        return {
          categoryCode: c.code, name: c.name, seats: c.seats,
          fare: fare.total, currency: "ETB", driversNearby: nearby.length > 0,
        };
      }),
    );
    return {
      distanceM: route.distanceM, durationS: route.durationS, routeSource: route.source,
      path: route.path, options,
    };
  });
}

export interface CreateTripInput {
  clientRequestId: string;
  categoryCode: string;
  pickup: LatLng & { address?: string };
  dropoff: LatLng & { address?: string };
  paymentMethod: "cash" | "telebirr" | "wallet";
}

export async function createTrip(ctx: DbContext, input: CreateTripInput) {
  // Idempotency: a retried request returns the original trip.
  const existing = await withContext(ctx, async (db) =>
    (await db.query(
      `SELECT ${TRIP_COLUMNS} FROM trips t WHERE t.customer_id = app.uid() AND t.client_request_id = $1`,
      [input.clientRequestId],
    )).rows[0],
  );
  if (existing) return { trip: existing, created: false };

  // Network call outside the transaction.
  const route = await getRoute(input.pickup, input.dropoff);

  const trip = await withContext(ctx, async (db) => {
    const { rows: cats } = await db.query(
      "SELECT * FROM vehicle_categories WHERE code = $1 AND is_active", [input.categoryCode],
    );
    if (!cats[0]) throw new AppError(422, "UNKNOWN_CATEGORY", "Vehicle category not available");
    const multiplier = await zoneCheck(db, input.pickup, input.dropoff);
    const fare = calculateFare(rulesFrom(cats[0]), route.distanceM, route.durationS, multiplier);

    const lineString = route.path.length >= 2
      ? JSON.stringify({ type: "LineString", coordinates: route.path })
      : null;

    try {
      const { rows } = await db.query(
        `INSERT INTO trips AS t (client_request_id, customer_id, category_code, pickup, pickup_address,
             dropoff, dropoff_address, planned_route, est_distance_m, est_duration_s,
             fare_estimate, payment_method)
         VALUES ($1, app.uid(), $2, ${point(input.pickup)}, $3, ${point(input.dropoff)}, $4,
             ST_SetSRID(ST_GeomFromGeoJSON($9), 4326)::geography, $5, $6, $7, $8)
         RETURNING ${TRIP_COLUMNS}`,
        [input.clientRequestId, input.categoryCode, input.pickup.address ?? null,
         input.dropoff.address ?? null, route.distanceM, route.durationS, fare.total,
         input.paymentMethod, lineString],
      );
      await db.query(
        "INSERT INTO trip_events (trip_id, actor_id, event, data) VALUES ($1, app.uid(), 'requested', $2)",
        [rows[0].id, { fare, routeSource: route.source }],
      );
      return rows[0];
    } catch (err: any) {
      if (err.code === "23505" && err.constraint === "trips_one_active_per_customer") {
        throw conflict("ACTIVE_TRIP_EXISTS", "You already have an active trip");
      }
      throw err;
    }
  });

  await dispatch(trip.id).catch((err) => logger.error({ err, tripId: trip.id }, "dispatch failed"));
  return { trip, created: true };
}

/**
 * Offer a searching trip to the nearest available drivers who haven't been
 * offered it yet. First to accept wins (see acceptTrip).
 *
 * v1 is "broadcast to the nearest N by straight-line distance". The roadmap
 * (docs/PLAN.md) upgrades ranking to road ETA via Gebeta's one-to-many API
 * and moves to sequential offers with acceptance-rate weighting.
 */
export async function dispatch(tripId: string): Promise<number> {
  return withContext(SYSTEM, async (db) => {
    const { rows } = await db.query(
      `SELECT id, category_code, fare_estimate, ST_Y(pickup::geometry) AS lat, ST_X(pickup::geometry) AS lng,
              pickup_address, dropoff_address, est_distance_m
         FROM trips WHERE id = $1 AND status = 'searching'`,
      [tripId],
    );
    const trip = rows[0];
    if (!trip) return 0;

    const { rows: offered } = await db.query<{ driver_id: string }>(
      "SELECT driver_id FROM trip_offers WHERE trip_id = $1", [tripId],
    );
    const skip = new Set(offered.map((o) => o.driver_id));
    const candidates = (await findNearby(trip.category_code, { lat: trip.lat, lng: trip.lng }, 5000, OFFER_BATCH * 2))
      .filter((d) => !skip.has(d.driverId))
      .slice(0, OFFER_BATCH);

    for (const c of candidates) {
      const { rows: [offer] } = await db.query(
        `INSERT INTO trip_offers (trip_id, driver_id, distance_m, expires_at)
         VALUES ($1, $2, $3, now() + make_interval(secs => $4))
         ON CONFLICT DO NOTHING RETURNING expires_at`,
        [tripId, c.driverId, c.distanceM, OFFER_TTL_S],
      );
      if (!offer) continue;
      emitToUser(c.driverId, "trip:offer", {
        tripId, distanceToPickupM: c.distanceM, fareEstimate: trip.fare_estimate,
        pickup: { lat: trip.lat, lng: trip.lng, address: trip.pickup_address },
        dropoffAddress: trip.dropoff_address, tripDistanceM: trip.est_distance_m,
        expiresAt: offer.expires_at,
      });
    }
    return candidates.length;
  });
}

async function postLedger(
  db: PoolClient, userId: string, amount: number, kind: string, tripId: string | null,
) {
  const { rows } = await db.query<{ balance: number }>(
    "UPDATE wallets SET balance = balance + $2, updated_at = now() WHERE user_id = $1 RETURNING balance",
    [userId, amount],
  );
  if (!rows[0]) throw new Error(`wallet missing for ${userId}`);
  await db.query(
    `INSERT INTO wallet_transactions (user_id, amount, balance_after, kind, trip_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, amount, rows[0].balance, kind, tripId],
  );
}

/** Driver accepts an offer. Runs in SYSTEM context: drivers can't self-assign. */
export async function acceptTrip(driverId: string, tripId: string) {
  const trip = await withContext(SYSTEM, async (db) => {
    const { rows: [offer] } = await db.query(
      `SELECT id FROM trip_offers
        WHERE trip_id = $1 AND driver_id = $2 AND status = 'pending' AND expires_at > now()
        FOR UPDATE`,
      [tripId, driverId],
    );
    if (!offer) throw conflict("OFFER_NOT_AVAILABLE", "This offer has expired or was withdrawn");

    const { rows: [vehicle] } = await db.query(
      "SELECT id FROM vehicles WHERE driver_id = $1 AND is_current AND status = 'approved'", [driverId],
    );
    if (!vehicle) throw new AppError(422, "NO_ACTIVE_VEHICLE", "No approved vehicle selected");

    let rows;
    try {
      ({ rows } = await db.query(
        `UPDATE trips AS t SET status = 'accepted', driver_id = $2, vehicle_id = $3, accepted_at = now()
          WHERE id = $1 AND status = 'searching' RETURNING ${TRIP_COLUMNS}`,
        [tripId, driverId, vehicle.id],
      ));
    } catch (err: any) {
      if (err.code === "23505") throw conflict("DRIVER_BUSY", "Finish your current trip first");
      throw err;
    }
    if (!rows[0]) throw conflict("TRIP_ALREADY_TAKEN", "Another driver accepted this trip");

    await db.query(
      `UPDATE trip_offers SET status = CASE WHEN id = $2 THEN 'accepted'::offer_status ELSE 'expired'::offer_status END,
              responded_at = now()
        WHERE trip_id = $1 AND status = 'pending'`,
      [tripId, offer.id],
    );
    await db.query("UPDATE driver_profiles SET availability = 'on_trip' WHERE user_id = $1", [driverId]);
    await db.query(
      "INSERT INTO trip_events (trip_id, actor_id, event) VALUES ($1, $2, 'accepted')", [tripId, driverId],
    );
    return rows[0];
  });

  await setUnavailable(driverId);
  // Lets the socket layer forward this driver's pings to the rider.
  await redis.set(`driver:trip:${driverId}`, `${tripId}:${trip.customerId}`, "EX", 6 * 3600);
  emitToUser(trip.customerId, "trip:updated", trip);
  return trip;
}

export async function declineOffer(ctx: DbContext, tripId: string) {
  await withContext(ctx, (db) =>
    db.query(
      `UPDATE trip_offers SET status = 'declined', responded_at = now()
        WHERE trip_id = $1 AND driver_id = app.uid() AND status = 'pending'`,
      [tripId],
    ),
  );
}

/** arrive / start: driver moves their own trip forward (RLS: driver_id = me). */
export async function driverTransition(
  ctx: DbContext, tripId: string, action: "arrive" | "start", ridePin?: string,
) {
  const t = TRANSITIONS[action];
  const trip = await withContext(ctx, async (db) => {
    const { rows } = await db.query(
      `UPDATE trips AS t SET status = $2, ${t.stamp} = now()
        WHERE id = $1 AND driver_id = app.uid() AND status = ANY($3)
          AND ($4::text IS NULL OR ride_pin = $4)
        RETURNING ${TRIP_COLUMNS}`,
      [tripId, t.to, t.from, action === "start" ? (ridePin ?? "") : null],
    );
    if (!rows[0]) {
      const { rows: [cur] } = await db.query("SELECT status FROM trips WHERE id = $1", [tripId]);
      if (!cur) throw notFound("Trip");
      if (action === "start" && t.from.includes(cur.status)) {
        throw new AppError(422, "WRONG_RIDE_PIN", "Ride PIN does not match");
      }
      throw conflict("INVALID_TRANSITION", `Cannot ${action} a trip that is ${cur.status}`);
    }
    await db.query(
      "INSERT INTO trip_events (trip_id, actor_id, event) VALUES ($1, app.uid(), $2)", [tripId, action],
    );
    return rows[0];
  });
  emitToUser(trip.customerId, "trip:updated", trip);
  return trip;
}

/**
 * Complete a trip: lock the fare, settle money, free the driver.
 * Upfront pricing: the final fare is the quoted fare (re-pricing on large
 * route deviations is on the roadmap). For cash trips the driver keeps the
 * cash and the commission is debited from their wallet.
 */
export async function completeTrip(driverId: string, tripId: string) {
  const trip = await withContext(SYSTEM, async (db) => {
    const { rows } = await db.query(
      `UPDATE trips AS t SET status = 'completed', completed_at = now(), final_fare = fare_estimate,
              payment_status = CASE WHEN payment_method = 'cash' THEN 'paid'::payment_status ELSE payment_status END
        WHERE id = $1 AND driver_id = $2 AND status = 'in_progress'
        RETURNING ${TRIP_COLUMNS}`,
      [tripId, driverId],
    );
    const trip = rows[0];
    if (!trip) throw conflict("INVALID_TRANSITION", "Trip is not in progress");

    const { rows: [cat] } = await db.query(
      "SELECT commission_bps FROM vehicle_categories WHERE code = $1", [trip.categoryCode],
    );
    const commission = Math.round((trip.finalFare * cat.commission_bps) / 10_000);
    await db.query("UPDATE trips SET commission_amount = $2 WHERE id = $1", [tripId, commission]);

    if (trip.paymentMethod === "cash") {
      if (commission > 0) await postLedger(db, driverId, -commission, "commission", tripId);
    } else if (trip.paymentMethod === "wallet") {
      await postLedger(db, trip.customerId, -trip.finalFare, "trip_payment", tripId);
      await postLedger(db, driverId, trip.finalFare - commission, "trip_earning", tripId);
      await db.query("UPDATE trips SET payment_status = 'paid' WHERE id = $1", [tripId]);
      trip.paymentStatus = "paid";
    }
    // telebirr: payment is collected through the provider flow (roadmap phase 2).

    await db.query("UPDATE driver_profiles SET availability = 'online' WHERE user_id = $1", [driverId]);
    await db.query(
      "INSERT INTO trip_events (trip_id, actor_id, event, data) VALUES ($1, $2, 'completed', $3)",
      [tripId, driverId, { commission }],
    );
    return trip;
  });

  await afterTripEnded(driverId, trip.categoryCode);
  emitToUser(trip.customerId, "trip:updated", trip);
  return trip;
}

export async function cancelTrip(ctx: DbContext, tripId: string, reason?: string) {
  // Staff act on behalf of the company, recorded as 'admin' in trip_actor.
  const actor = ctx.role === "admin" || ctx.role === "staff" ? "admin" : ctx.role;
  const t = TRANSITIONS.cancel;
  const trip = await withContext(ctx, async (db) => {
    const { rows } = await db.query(
      `UPDATE trips AS t SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2, cancel_reason = $3
        WHERE id = $1 AND status = ANY($4)
          AND (customer_id = app.uid() OR driver_id = app.uid() OR app.can('trips.cancel'))
        RETURNING ${TRIP_COLUMNS}`,
      [tripId, actor, reason ?? null, t.from],
    );
    if (!rows[0]) {
      const { rows: [cur] } = await db.query("SELECT status FROM trips WHERE id = $1", [tripId]);
      if (!cur) throw notFound("Trip");
      throw conflict("INVALID_TRANSITION", `Cannot cancel a trip that is ${cur.status}`);
    }
    await db.query(
      "INSERT INTO trip_events (trip_id, actor_id, event, data) VALUES ($1, app.uid(), 'cancelled', $2)",
      [tripId, { reason: reason ?? null }],
    );
    return rows[0];
  });

  await withContext(SYSTEM, (db) =>
    db.query("UPDATE trip_offers SET status = 'expired' WHERE trip_id = $1 AND status = 'pending'", [tripId]),
  );
  if (trip.driverId) {
    await withContext(SYSTEM, (db) =>
      db.query("UPDATE driver_profiles SET availability = 'online' WHERE user_id = $1", [trip.driverId]),
    );
    await afterTripEnded(trip.driverId, trip.categoryCode);
  }
  for (const userId of [trip.customerId, trip.driverId].filter(Boolean)) {
    emitToUser(userId, "trip:updated", trip);
  }
  return trip;
}

/** Put the driver back into the matching pool at their last known position. */
async function afterTripEnded(driverId: string, category: string) {
  await redis.del(`driver:trip:${driverId}`);
  const pos = await getPosition(driverId);
  if (pos) await setAvailable(driverId, category, pos);
}

/**
 * Periodic sweep (every few seconds): expire trips nobody accepted and
 * re-dispatch searching trips whose offers all lapsed.
 * Single-instance for now; with several API instances wrap it in a Redis
 * lock or move it to a worker (see docs/PLAN.md).
 */
export async function sweepTrips() {
  const { expired, retry } = await withContext(SYSTEM, async (db) => {
    const expired = (await db.query<{ id: string; customer_id: string }>(
      `UPDATE trips SET status = 'expired', cancelled_at = now(), cancelled_by = 'system'
        WHERE status = 'searching' AND requested_at < now() - make_interval(secs => $1)
        RETURNING id, customer_id`,
      [SEARCH_TIMEOUT_S],
    )).rows;
    await db.query(
      "UPDATE trip_offers SET status = 'expired' WHERE status = 'pending' AND expires_at <= now()",
    );
    const retry = (await db.query<{ id: string }>(
      `SELECT t.id FROM trips t
        WHERE t.status = 'searching'
          AND NOT EXISTS (SELECT 1 FROM trip_offers o WHERE o.trip_id = t.id AND o.status = 'pending')`,
    )).rows;
    return { expired, retry };
  });
  for (const t of expired) emitToUser(t.customer_id, "trip:updated", { id: t.id, status: "expired" });
  for (const t of retry) await dispatch(t.id);
}
