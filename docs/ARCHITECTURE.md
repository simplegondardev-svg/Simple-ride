# Architecture

```
 Flutter rider app ─┐                         ┌─────────────── PostgreSQL 16 + PostGIS
 Flutter driver app ┼─ HTTPS /api/v1 ─┐       │  source of truth, RLS on every table
                    └─ Socket.IO ─────┤       │
                                      ▼       │
 Browser ─▶ Next.js (BFF, httpOnly ─▶ Express API ──┤
            cookies) /api/proxy      │  + Socket.IO │
                                      │       └─────────────── Redis
                                      │          OTP · rate limits · live driver GEO index
                                      ▼          · Gebeta response cache · (Socket.IO adapter)
                                Gebeta Maps API
                          (routing, geocoding; key stays server-side)
```

## API layout (`apps/api/src`)

| Path | Responsibility |
|---|---|
| `db/context.ts` | `withContext(ctx, fn)` is the **only** way to query. It opens a transaction and sets the RLS context. |
| `db/migrations/` | Plain SQL, forward-only. `0003_rls.sql` holds every policy and guard. |
| `auth/` | OTP (Redis), JWT access tokens, rotating refresh sessions, role middleware. |
| `modules/trips/state-machine.ts` | The single definition of the trip lifecycle. |
| `modules/trips/service.ts` | Request, dispatch, accept, transitions, settlement, sweeps. |
| `modules/drivers/presence.ts` | Live positions in Redis; throttled persistence to PostGIS. |
| `modules/geo/gebeta.ts` | Every Gebeta call: caching, defensive parsing, fallback estimate. |
| `modules/pricing/fare.ts` | Pure fare function, in integer santim. |
| `realtime/socket.ts` | Socket.IO auth, rooms (`user:<id>`), driver pings. |

## Security model

1. **Two database roles.** `simpleride_owner` owns the schema and runs migrations. `simpleride_app` is what the API
   logs in as: `NOBYPASSRLS`, not the owner, with only the grants it needs (no `DELETE` on most tables).
2. **Request context.** `withContext` runs `set_config('app.user_id', …, true)` and `set_config('app.role', …, true)`.
   Because of `is_local = true`, the values die with the transaction, so a pooled connection can't leak one user's
   identity to the next request. A test checks this.
3. **Policies** use `app.uid()`, `app.role()`, `app.is_admin()` and `app.is_staff()`. Cross-table checks (for example,
   "has this driver been offered this trip?") are `SECURITY DEFINER` helpers, which avoid recursive policy evaluation.
4. **Column guards.** Policies select rows; `BEFORE UPDATE` triggers stop non-staff from changing privileged
   columns on rows they can otherwise update: role and status on users, approval and rating on drivers,
   parties, fare and route on trips, and accepting offers.
5. **`system` context** is only constructed in server code (`SYSTEM` in `db/context.ts`): login and signup, dispatch
   and accept (so drivers can't self-assign), completion and settlement (so nobody can set their own fare), and sweeps.
6. **Defence in depth**: route-level `requireRole` is the first check and RLS is the backstop. A bug in a route
   should not expose data. If an SQL-injection bug let an attacker call `set_config`, RLS would no longer protect
   anything, so all SQL stays parameterised.

## Matching (v1)

1. Online drivers live in `drivers:geo:<category>` (Redis GEO). Pings older than 60 s are ignored.
2. A new trip is offered to the 5 nearest drivers by straight-line distance, each with a 20 s window.
3. The first `accept` wins through `UPDATE trips … WHERE status = 'searching'`. The others get `TRIP_ALREADY_TAKEN`.
4. A 5 s sweep expires lapsed offers, re-dispatches to drivers not yet offered, and expires trips after 3 minutes.

v2 (see PLAN.md) ranks candidates by **road ETA** using Gebeta's one-to-many endpoint and offers sequentially.

## Scaling notes
- The sweeper runs in the API process. With more than one API instance, move it to a worker or guard it with a Redis lock.
- With more than one API instance, add `@socket.io/redis-adapter` so `emitToUser` reaches sockets on other nodes.
- Driver pings never touch Postgres on the hot path. The 30 s throttle keeps write load at about 2 writes/min per online driver.

## API conventions (for web and Flutter)
- Base path `/api/v1`; `Authorization: Bearer <accessToken>`.
- JSON keys are camelCase; timestamps are ISO-8601 UTC; money is integer santim with `currency: "ETB"`.
- Coordinates are always `{ "lat": 9.03, "lng": 38.75 }`. (PostGIS stores lng/lat; the API hides that.)
- Errors are `{ "error": { "code": "TRIP_ALREADY_TAKEN", "message": "...", "details": ... } }`. Clients switch on `code`.
- Lists are `{ "data": [...], "nextBefore": "<timestamp>" | null }` (cursor pagination).
- Trip creation requires a client-generated `clientRequestId` (UUID). Repeating it returns the original trip.

### Endpoints (v1)
| Method | Path | Who |
|---|---|---|
| POST | `/auth/otp/request` · `/auth/otp/verify` · `/auth/refresh` · `/auth/logout` | public |
| GET/PATCH | `/users/me` · PUT `/users/me/push-token` · GET `/users/me/wallet` | any user |
| GET | `/catalog/vehicle-categories` | public |
| GET | `/geo/search?q=` · `/geo/reverse?lat=&lng=` | any user |
| POST | `/trips/estimate` | any user |
| POST | `/trips` | customer |
| GET | `/trips` · `/trips/:id` | parties, staff |
| POST | `/trips/:id/cancel` · `/trips/:id/rate` | parties |
| POST | `/trips/:id/accept` · `decline` · `arrive` · `start` · `complete` | driver |
| GET/PUT/POST | `/drivers/me` · `/drivers/me/profile` · `/drivers/me/vehicles` · `/drivers/me/online` · `/drivers/me/offline` · `/drivers/me/location` · `/drivers/me/offers` | driver |
| GET/PATCH/POST | `/admin/stats` · `/admin/users` · `/admin/users/:id/status` · `/admin/drivers/pending` · `/admin/drivers/:id/review` · `/admin/trips` | admin |

### Socket.IO events
| Direction | Event | Payload |
|---|---|---|
| server → driver | `trip:offer` | `{ tripId, pickup, dropoffAddress, fareEstimate, distanceToPickupM, tripDistanceM, expiresAt }` |
| server → parties | `trip:updated` | the trip object |
| server → rider | `driver:location` | `{ tripId, lat, lng, heading }` |
| driver → server | `driver:location` | `{ lat, lng, heading? }` |

## Gebeta Maps integration status
The endpoint paths in `gebeta.ts` follow Gebeta's public docs (`/api/route/direction/`, `/api/v1/route/geocoding`,
`/api/v1/route/revgeocoding`). The **response field names are parsed defensively but were not verified against a live
call**, because the build environment could not reach Gebeta. Before launch, make one real call with your key and adjust
`getRoute` / `toPlaces` if needed. If routing fails, it falls back to a straight-line estimate and logs a warning.
