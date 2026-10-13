# Architecture

```
 Flutter rider app ─┐                         ┌─────────────── PostgreSQL 16 + PostGIS
 Flutter driver app ┼─ HTTPS /api/v1 ─┐       │  source of truth, RLS on every table
                    └─ Socket.IO ─────┤       │
                                      ▼       │
 Browser ─▶ Next.js (BFF, httpOnly ─▶ Express API ──┤
            cookies) /api/proxy      │  + Socket.IO │
                                      │       └─────────────── Redis
                                      │          rate limits · live driver GEO index
                                      ▼          · Gebeta response cache · (Socket.IO adapter)
                                Gebeta Maps API
                          (routing, geocoding; key stays server-side)
```

## API layout (`apps/api/src`)

| Path | Responsibility |
|---|---|
| `db/context.ts` | `withContext(ctx, fn)` is the **only** way to query. It opens a transaction and sets the RLS context. |
| `db/migrations/` | Plain SQL, forward-only. `0003_rls.sql` holds every policy and guard. |
| `auth/` | Password login (scrypt), JWT access tokens, rotating refresh sessions, role and permission middleware. |
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

## Authentication

Every role logs in with **phone number + password** (`POST /auth/login`). Riders and drivers sign up with
`POST /auth/register`; admin and staff accounts can't be self-registered.

- **Storage:** scrypt hashes (salted, parameters stored per hash) in `user_credentials`, a table only the
  `system` context can read. Not even an admin's database queries can return a hash.
- **Temporary passwords:** issued when an admin creates staff, when an admin resets staff, when support
  (`users.reset_password`) resets a rider or driver, and by the seed or `pnpm reset-password` CLI. They are
  shown once, sign the user out everywhere, and must be replaced at the next login (`409
  PASSWORD_CHANGE_REQUIRED`, then repeat the login with `newPassword`).
- **Guessing:** 5 wrong passwords lock the account for 15 minutes (`423 ACCOUNT_LOCKED`). Per-IP limits are
  deliberately loose, because mobile carriers share IPs between many subscribers. Wrong password and unknown
  phone return the identical `401 INVALID_CREDENTIALS`, with the same timing.
- **Sessions:** riders and drivers 30 days; admin and staff 12 hours, absolute. Changing a password signs
  out every other device.
- **Password rules:** 10–128 characters, must not contain the phone number, not one repeated character.
- **Known gap:** phone numbers are not verified (`users.phone_verified_at` stays NULL), so anyone can register
  any number and there is no self-service "forgot password". The SMS code module (`src/auth/otp.ts`) is kept
  for when verification is switched on.

## Staff permissions

- `admin`: full access, and the only role that creates staff and changes their permissions. There is no "manage
  staff" permission, so a staff member can never escalate their own access.
- `staff`: exactly the permissions in `staff_permissions` for that person. The catalog lives in the
  `permissions` table and in `PERMISSIONS` (`src/auth/permissions.ts`); a test fails if the two differ.
- **Enforced twice.** Routes declare `requirePermission("trips.view")`, and RLS policies check `app.can('trips.view')`.
  `app.init_context()` loads the person's permissions into the transaction once, so the per-row check is cheap.
- **Changes apply on the next request**, because permissions are read per transaction, not stored in the token.
- **Every request re-checks the account.** A suspended or deleted user, or a token whose role no longer
  matches, gets `401 ACCOUNT_INACTIVE` at once instead of when the access token expires.
- Staff never see admin or other staff accounts. They act on riders and drivers only.
- Dashboard totals and the day book are `SECURITY DEFINER` functions that check the permission themselves,
  because totals must count every row, not only the ones the viewer may read row by row.

| Permission | Allows |
|---|---|
| `dashboard.view` | Dashboard statistics |
| `users.view` / `users.suspend` | View riders and drivers / suspend or reactivate them |
| `users.reset_password` | Issue a temporary password to a rider or driver who forgot theirs |
| `drivers.view` / `drivers.approve` | View driver profiles and vehicles / approve, reject, suspend |
| `trips.view` / `trips.cancel` | View trips, timelines, ratings / cancel active trips |
| `finance.daybook.view` | The day book: one Addis Ababa day of trips and wallet movements |
| `finance.wallets.view` / `finance.wallets.adjust` | Wallet balances and history / manual credit or debit (with reason) |
| `pricing.manage` / `zones.manage` | Fares and commission / service zones (database rules ready; screens not built yet) |
| `sos.view` / `sos.manage` | SOS alerts / acknowledge and resolve (database rules ready; screens not built yet) |
| `audit.view` | The audit log of every back-office action |

Adding a permission: add it to `PERMISSIONS`, `INSERT` it in a new migration, gate the route with
`requirePermission`, and add an RLS policy if it controls data.

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
| POST | `/auth/register` · `/auth/login` · `/auth/refresh` · `/auth/logout` | public |
| POST | `/auth/password/change` | any signed-in user |
| GET/PATCH | `/users/me` · PUT `/users/me/push-token` · GET `/users/me/wallet` | any user |
| GET | `/catalog/vehicle-categories` | public |
| GET | `/geo/search?q=` · `/geo/reverse?lat=&lng=` | any user |
| POST | `/trips/estimate` | any user |
| POST | `/trips` | customer |
| GET | `/trips` · `/trips/:id` | parties, staff |
| POST | `/trips/:id/cancel` · `/trips/:id/rate` | parties |
| POST | `/trips/:id/accept` · `decline` · `arrive` · `start` · `complete` | driver |
| GET/PUT/POST | `/drivers/me` · `/drivers/me/profile` · `/drivers/me/vehicles` · `/drivers/me/online` · `/drivers/me/offline` · `/drivers/me/location` · `/drivers/me/offers` | driver |
| GET | `/admin/me` · `/admin/permissions` | admin, staff |
| GET/PATCH/POST | `/admin/stats` · `/admin/users` · `/admin/users/:id/status` · `/admin/drivers/pending` · `/admin/drivers/:id/review` · `/admin/trips` · `/admin/trips/:id/cancel` · `/admin/finance/daybook?date=` · `/admin/wallets/:id` · `/admin/wallets/:id/adjust` · `/admin/audit` | admin, or staff with the matching permission |
| POST | `/admin/users/:id/reset-password` | admin, or staff with `users.reset_password` |
| GET/POST/PUT | `/admin/staff` · `/admin/staff/:id/permissions` · `/admin/staff/:id/reset-password` | admin only |

### Socket.IO events
| Direction | Event | Payload |
|---|---|---|
| server → driver | `trip:offer` | `{ tripId, pickup, dropoffAddress, fareEstimate, distanceToPickupM, tripDistanceM, expiresAt }` |
| server → parties | `trip:updated` | the trip object |
| server → rider | `driver:location` | `{ tripId, lat, lng, heading }` |
| driver → server | `driver:location` | `{ lat, lng, heading? }` |

## Gebeta Maps integration (verified live, Oct 2026)

All map services go through `apps/api/src/modules/geo/gebeta.ts` (routing, geocoding) and
`apps/web/src/components/Map.tsx` (tiles). The live API differs from docs.gebeta.app in several places;
the code follows the live behaviour:

| Service | Live behaviour | Docs say |
|---|---|---|
| Directions | `GET /api/route/direction/?origin=lat,lng&destination=lat,lng&apiKey=` → `totalDistance` **metres**, `timetaken` **seconds**, `direction` = `[[lat,lng],…]` | braces around coordinates (both forms work) |
| One-to-many (ONM) | `GET /api/route/onm?origin=lat,lng&json=[{lat,lng},{lat,lng}]&apiKey=` (**no trailing slash**; max 5 targets) → `origin_to_destination[{to, distance (**km**), time (s)}]` | `/onm/` (returns 502) and a `directions[]` response |
| Matrix | `GET /api/route/matrix?json=[{lat,lng},…]&apiKey=` (no trailing slash) | — |
| Geocode | `GET /v2/search/geocode?query=&country=et&proximity=lng,lat&limit=&apiKey=` | key may be a Bearer header (it's rejected: "missing api key") |
| Reverse | `GET /v2/search/reverse-geocoding?lat=&lon=&size=&apiKey=`; results include `neighborhood` | — |
| Tiles | `https://tiles.gebeta.app/styles/standard/style.json`; tiles, sprites and fonts need `Authorization: Bearer <key>` | — |

Quirks handled in code:
- Place names sometimes contain a tab separator ("Branch\tCommercial Bank Of Ethiopia - …"); the descriptive
  part is kept.
- The proximity bias is weak ("Piassa" from Bole ranked Mekelle and Hawassa first), so results within 60 km
  of the rider are re-ranked to the top.
- Gebeta's style references "Open Sans" fonts the tile server doesn't host (404), hiding square and office
  labels; `Map.tsx` swaps them for the hosted `JakartaSans`.
- MapLibre v6 loads its worker from a separate module that bundlers rename; `scripts/copy-maplibre-worker.mjs`
  copies it to `public/maplibre/` before dev/build and `Map.tsx` calls `setWorkerUrl`.
- `legsFrom()` (ONM) is implemented and tested for dispatch v2: rank the 5 nearest drivers by real driving
  time to the pickup. Dispatch still uses straight-line distance until that is switched on.

Keys: `GEBETA_API_KEY` (API, server-side only) and `NEXT_PUBLIC_GEBETA_TILES_KEY` (web, visible to visitors —
restrict it to your domain in the Gebeta dashboard). Gebeta's `@gebeta/node` SDK can mint short-lived client
tokens so the browser never holds a long-lived key; worth adopting before launch.
