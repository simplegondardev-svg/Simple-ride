import type { PoolClient } from "pg";
import { SYSTEM, withContext, type DbContext } from "../../db/context.js";
import { AppError, conflict, notFound } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { redis } from "../../lib/redis.js";
import { emitToUser } from "../../realtime/socket.js";
import { findNearby, getPosition, setAvailable, setUnavailable, staleDrivers, type NearbyDriver } from "../drivers/presence.js";
import { drivingTimesTo, getRoute, type Leg, type LatLng } from "../geo/gebeta.js";
import { calculateFare, overtimeCharge, type FareRules } from "../pricing/fare.js";
import { balances, commissionBps, moneySettings, walletStatus } from "../drivers/money.js";
import { postLedger } from "../wallet/ledger.js";
import { expireDocuments } from "../drivers/documents.js";
import { TRANSITIONS, type TripAction } from "./state-machine.js";

const OFFER_TTL_S = 20;
/** Drivers offered at once; the next ones get it when these decline or time out. */
const OFFER_BATCH = 2;
/** Drivers considered per round (Gebeta matrix: 9 origins + the pickup). */
const CANDIDATES = 9;
const SEARCH_RADIUS_M = 5000;
const SEARCH_TIMEOUT_S = 180;
const SWEEP_LOCK_MS = 4000;

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
  t.cancelled_by AS "cancelledBy", t.cancel_reason AS "cancelReason",
  t.overtime_amount AS "overtimeAmount"`;

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

export interface RankedDriver extends NearbyDriver {
  /** Estimated driving time to the pickup, seconds. */
  etaS: number;
  etaSource: "gebeta" | "estimate";
}

/**
 * Order candidates by driving time to the pickup. Where Gebeta had no answer
 * for a driver, estimate from straight-line distance (× 1.35 road factor at
 * 22 km/h), the same fallback the fare estimate uses.
 */
export function rankByEta(candidates: NearbyDriver[], legs: (Leg | null)[] | null): RankedDriver[] {
  return candidates
    .map((c, i) => {
      const leg = legs?.[i];
      return leg
        ? { ...c, etaS: leg.durationS, etaSource: "gebeta" as const }
        : { ...c, etaS: Math.round((c.distanceM * 1.35) / (22 / 3.6)), etaSource: "estimate" as const };
    })
    .sort((a, b) => a.etaS - b.etaS || a.distanceM - b.distanceM);
}

/**
 * Offer a searching trip to the next round of drivers.
 *
 * 1. Up to 9 nearby available drivers who haven't been offered this trip
 *    (straight-line, from Redis — fast and free).
 * 2. Rank them by real driving time TO the pickup (Gebeta matrix; one call).
 *    If Gebeta fails, fall back to straight-line order.
 * 3. Offer to the best 2 for 20 s. When they decline or time out, the next
 *    round goes to the next best (declineOffer and the sweeper call this again).
 * First to accept wins (acceptTrip). Network calls happen outside transactions.
 */
export async function dispatch(tripId: string): Promise<number> {
  const trip = await withContext(SYSTEM, async (db) => {
    const { rows: [t] } = await db.query(
      `SELECT id, category_code, fare_estimate, ST_Y(pickup::geometry) AS lat, ST_X(pickup::geometry) AS lng,
              pickup_address, dropoff_address, est_distance_m,
              ARRAY(SELECT driver_id FROM trip_offers
                     WHERE trip_id = trips.id AND status <> 'withdrawn') AS offered
         FROM trips WHERE id = $1 AND status = 'searching'`,
      [tripId],
    );
    return t;
  });
  if (!trip) return 0;

  const pickup = { lat: trip.lat, lng: trip.lng };
  const skip = new Set<string>(trip.offered);
  const near = (await findNearby(trip.category_code, pickup, SEARCH_RADIUS_M, CANDIDATES + skip.size))
    .filter((d) => !skip.has(d.driverId));
  // Drivers whose prepaid commission balance is below the threshold get no offers.
  const funded = await withContext(SYSTEM, async (db) => {
    const [s, bal] = await Promise.all([moneySettings(db), balances(db, near.map((d) => d.driverId))]);
    return new Set(near.filter((d) => (bal.get(d.driverId) ?? 0) >= s.lowBalanceThreshold).map((d) => d.driverId));
  });
  const nearby = near.filter((d) => funded.has(d.driverId)).slice(0, CANDIDATES);
  if (nearby.length === 0) return 0;

  const legs = await drivingTimesTo(nearby, pickup).catch((err) => {
    logger.warn({ err, tripId }, "driving-time ranking unavailable, using straight-line order");
    return null;
  });
  const chosen = rankByEta(nearby, legs).slice(0, OFFER_BATCH);

  const offers = await withContext(SYSTEM, async (db) => {
    const made: { driver: RankedDriver; expiresAt: string }[] = [];
    for (const d of chosen) {
      const { rows: [o] } = await db.query(
        `INSERT INTO trip_offers (trip_id, driver_id, distance_m, eta_s, expires_at)
         SELECT $1, $2, $3, $4, now() + make_interval(secs => $5)
          WHERE EXISTS (SELECT 1 FROM trips WHERE id = $1 AND status = 'searching')
         ON CONFLICT (trip_id, driver_id) DO UPDATE
           SET status = 'pending', distance_m = EXCLUDED.distance_m, eta_s = EXCLUDED.eta_s,
               offered_at = now(), expires_at = EXCLUDED.expires_at, responded_at = NULL
           WHERE trip_offers.status = 'withdrawn'
         RETURNING expires_at`,
        [tripId, d.driverId, d.distanceM, d.etaS, OFFER_TTL_S],
      );
      if (o) made.push({ driver: d, expiresAt: o.expires_at });
    }
    return made;
  });

  for (const { driver, expiresAt } of offers) {
    emitToUser(driver.driverId, "trip:offer", {
      tripId, distanceToPickupM: driver.distanceM, etaToPickupS: driver.etaS,
      fareEstimate: trip.fare_estimate,
      pickup: { ...pickup, address: trip.pickup_address },
      dropoffAddress: trip.dropoff_address, tripDistanceM: trip.est_distance_m,
      expiresAt,
    });
  }
  return offers.length;
}

/**
 * Share of offers a driver accepted among those they declined or let time
 * out (last 100). Withdrawn offers (trip went elsewhere) don't count.
 */
export async function acceptanceRate(db: PoolClient, driverId: string): Promise<number | null> {
  const { rows: [r] } = await db.query(
    `SELECT count(*) FILTER (WHERE status = 'accepted')::int AS accepted, count(*)::int AS total
       FROM (SELECT status FROM trip_offers
              WHERE driver_id = $1 AND status IN ('accepted', 'declined', 'expired')
              ORDER BY offered_at DESC LIMIT 100) o`,
    [driverId],
  );
  return r.total === 0 ? null : r.accepted / r.total;
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
    await requireFunded(db, driverId);

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
      `UPDATE trip_offers SET status = CASE WHEN id = $2 THEN 'accepted'::offer_status ELSE 'withdrawn'::offer_status END,
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
  const declined = await withContext(ctx, async (db) =>
    (await db.query(
      `UPDATE trip_offers SET status = 'declined', responded_at = now()
        WHERE trip_id = $1 AND driver_id = app.uid() AND status = 'pending'`,
      [tripId],
    )).rowCount,
  );
  // Don't wait for the sweeper: if nobody else holds an offer, start the next round now.
  if (declined) await redispatchIfIdle(tripId);
}

async function redispatchIfIdle(tripId: string) {
  const idle = await withContext(SYSTEM, async (db) =>
    (await db.query(
      `SELECT 1 FROM trips t WHERE t.id = $1 AND t.status = 'searching'
          AND NOT EXISTS (SELECT 1 FROM trip_offers o WHERE o.trip_id = t.id
                            AND o.status = 'pending' AND o.expires_at > now())`,
      [tripId],
    )).rowCount,
  );
  if (idle) await dispatch(tripId).catch((err) => logger.error({ err, tripId }, "re-dispatch failed"));
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

async function getSetting<T>(db: PoolClient, key: string, fallback: T): Promise<T> {
  const { rows: [r] } = await db.query("SELECT value FROM app_settings WHERE key = $1", [key]);
  return r ? (r.value as T) : fallback;
}

/**
 * Complete a trip: fix the final fare, settle money, free the driver.
 * Final fare = the upfront quote + overtime (extra minutes beyond the
 * estimate at the per-minute rate, capped at the admin-set share of the
 * quote; business decision Oct 2026). For cash trips the driver collects the
 * fare and the commission is debited from their prepaid wallet.
 */
export async function completeTrip(driverId: string, tripId: string) {
  const trip = await withContext(SYSTEM, async (db) => {
    const { rows: [cur] } = await db.query(
      `SELECT t.fare_estimate, t.est_duration_s, extract(epoch FROM now() - t.started_at)::int AS actual_s,
              c.per_minute
         FROM trips t JOIN vehicle_categories c ON c.code = t.category_code
        WHERE t.id = $1 AND t.driver_id = $2 AND t.status = 'in_progress'
        FOR UPDATE OF t`,
      [tripId, driverId],
    );
    if (!cur) throw conflict("INVALID_TRANSITION", "Trip is not in progress");

    const overtime = overtimeCharge({
      quote: cur.fare_estimate, estimatedS: cur.est_duration_s ?? 0, actualS: cur.actual_s,
      perMinute: cur.per_minute, capBps: Number(await getSetting(db, "overtime_cap_bps", 2500)),
    });
    const finalFare = cur.fare_estimate + overtime;
    const settings = await moneySettings(db);
    const rateBps = await commissionBps(db, driverId, settings);
    const commission = Math.round((finalFare * rateBps) / 10_000);

    const { rows: [trip] } = await db.query(
      `UPDATE trips AS t SET status = 'completed', completed_at = now(), final_fare = $3,
              overtime_amount = $4, commission_amount = $5,
              payment_status = CASE WHEN payment_method = 'cash' THEN 'paid'::payment_status ELSE payment_status END
        WHERE id = $1 AND driver_id = $2
        RETURNING ${TRIP_COLUMNS}`,
      [tripId, driverId, finalFare, overtime, commission],
    );

    let balance = (await balances(db, [driverId])).get(driverId) ?? 0;
    if (trip.paymentMethod === "cash") {
      // The driver collected the fare in cash; our share comes out of their deposit.
      if (commission > 0) balance = await postLedger(db, { userId: driverId, amount: -commission, kind: "commission", tripId });
    } else if (trip.paymentMethod === "wallet") {
      await postLedger(db, { userId: trip.customerId, amount: -finalFare, kind: "trip_payment", tripId });
      balance = await postLedger(db, { userId: driverId, amount: finalFare - commission, kind: "trip_earning", tripId });
      await db.query("UPDATE trips SET payment_status = 'paid' WHERE id = $1", [tripId]);
      trip.paymentStatus = "paid";
    }
    // telebirr: payment is collected through the provider flow (after the pilot).

    // Below the threshold the driver may not take more trips until they deposit.
    const wallet = walletStatus(balance, settings);
    await db.query("UPDATE driver_profiles SET availability = $2 WHERE user_id = $1",
      [driverId, wallet.canReceiveTrips ? "online" : "offline"]);
    await db.query(
      "INSERT INTO trip_events (trip_id, actor_id, event, data) VALUES ($1, $2, 'completed', $3)",
      [tripId, driverId, { quote: cur.fare_estimate, overtime, finalFare, commission, commissionBps: rateBps,
        estimatedS: cur.est_duration_s, actualS: cur.actual_s }],
    );
    return { trip, wallet };
  });

  if (trip.wallet.canReceiveTrips) {
    await afterTripEnded(driverId, trip.trip.categoryCode);
  } else {
    await redis.del(`driver:trip:${driverId}`);
    await setUnavailable(driverId);
    emitToUser(driverId, "driver:availability", { availability: "offline", reason: "LOW_BALANCE", wallet: trip.wallet });
  }
  if (trip.wallet.needsTopUp) emitToUser(driverId, "driver:wallet", trip.wallet);
  emitToUser(trip.trip.customerId, "trip:updated", trip.trip);
  return trip.trip;
}

/** Refuse when the driver's prepaid balance is below the threshold. */
export async function requireFunded(db: PoolClient, driverId: string) {
  const s = await moneySettings(db);
  const w = walletStatus((await balances(db, [driverId])).get(driverId) ?? 0, s);
  if (!w.canReceiveTrips) {
    throw new AppError(402, "DEPOSIT_REQUIRED", "Deposit needed before taking trips", w);
  }
}

/**
 * A driver backs out of a trip they accepted: the rider shouldn't lose their
 * ride, so the trip goes back to searching (fresh search window) and the
 * next drivers get it. The driver isn't offered this trip again.
 */
async function releaseByDriver(driverId: string, tripId: string, reason?: string) {
  const trip = await withContext(SYSTEM, async (db) => {
    const { rows: [t] } = await db.query(
      `UPDATE trips AS t SET status = 'searching', driver_id = NULL, vehicle_id = NULL,
              accepted_at = NULL, arrived_at = NULL, searching_since = now()
        WHERE id = $1 AND driver_id = $2 AND status IN ('accepted', 'arrived')
        RETURNING ${TRIP_COLUMNS}`,
      [tripId, driverId],
    );
    if (!t) return null;
    await db.query(
      "UPDATE trip_offers SET status = 'declined', responded_at = now() WHERE trip_id = $1 AND driver_id = $2",
      [tripId, driverId],
    );
    await db.query("UPDATE driver_profiles SET availability = 'online' WHERE user_id = $1", [driverId]);
    await db.query(
      "INSERT INTO trip_events (trip_id, actor_id, event, data) VALUES ($1, $2, 'driver_cancelled', $3)",
      [tripId, driverId, { reason: reason ?? null }],
    );
    return t;
  });
  if (!trip) return null;
  await afterTripEnded(driverId, trip.categoryCode);
  emitToUser(trip.customerId, "trip:updated", trip);
  emitToUser(driverId, "trip:updated", { id: tripId, status: "cancelled", cancelledBy: "driver" });
  await dispatch(tripId).catch((err) => logger.error({ err, tripId }, "re-dispatch after driver cancel failed"));
  return trip;
}

export async function cancelTrip(ctx: DbContext, tripId: string, reason?: string) {
  if (ctx.role === "driver" && ctx.userId) {
    const released = await releaseByDriver(ctx.userId, tripId, reason);
    if (released) return { ...released, ridePin: undefined };
  }
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
    db.query("UPDATE trip_offers SET status = 'withdrawn' WHERE trip_id = $1 AND status = 'pending'", [tripId]),
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
 * Periodic sweep (every few seconds), on one API instance at a time:
 *  - expire trips nobody accepted within the search window
 *  - start the next offer round for searching trips with no live offers
 *  - take drivers whose app stopped pinging out of matching
 *  - repair drivers marked "on trip" without an active trip
 *  - hourly: expire documents past their date and suspend those drivers
 */
export async function sweepTrips() {
  // Several API instances may run the sweeper; only one per interval works.
  const lock = await redis.set("sweep:lock", process.pid.toString(), "PX", SWEEP_LOCK_MS, "NX");
  if (!lock) return;

  // At most hourly (own Redis key): expire documents and suspend affected drivers.
  await expireDocuments().catch((err) => logger.error({ err }, "document expiry check failed"));

  const stale = await staleDrivers();
  for (const id of stale) await setUnavailable(id);

  const { expired, retry, wentOffline } = await withContext(SYSTEM, async (db) => {
    const expired = (await db.query<{ id: string; customer_id: string }>(
      `UPDATE trips SET status = 'expired', cancelled_at = now(), cancelled_by = 'system'
        WHERE status = 'searching' AND searching_since < now() - make_interval(secs => $1)
        RETURNING id, customer_id`,
      [SEARCH_TIMEOUT_S],
    )).rows;
    await db.query(
      `UPDATE trip_offers SET status = 'withdrawn'
        WHERE status = 'pending' AND trip_id IN (SELECT id FROM trips WHERE status <> 'searching')`,
    );
    await db.query("UPDATE trip_offers SET status = 'expired' WHERE status = 'pending' AND expires_at <= now()");
    const retry = (await db.query<{ id: string }>(
      `SELECT t.id FROM trips t
        WHERE t.status = 'searching'
          AND NOT EXISTS (SELECT 1 FROM trip_offers o WHERE o.trip_id = t.id AND o.status = 'pending')`,
    )).rows;
    const wentOffline = stale.length === 0 ? [] : (await db.query<{ user_id: string }>(
      `UPDATE driver_profiles SET availability = 'offline'
        WHERE user_id = ANY($1) AND availability = 'online' RETURNING user_id`,
      [stale],
    )).rows;
    await db.query(
      `UPDATE driver_profiles dp SET availability = 'online'
        WHERE availability = 'on_trip' AND NOT EXISTS (
          SELECT 1 FROM trips t WHERE t.driver_id = dp.user_id
             AND t.status IN ('accepted', 'arrived', 'in_progress'))`,
    );
    return { expired, retry, wentOffline };
  });
  for (const t of expired) emitToUser(t.customer_id, "trip:updated", { id: t.id, status: "expired" });
  for (const d of wentOffline) {
    emitToUser(d.user_id, "driver:availability", { availability: "offline", reason: "NO_LOCATION_UPDATES" });
  }
  for (const t of retry) await dispatch(t.id).catch((err) => logger.error({ err, tripId: t.id }, "dispatch failed"));
}
