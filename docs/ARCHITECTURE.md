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
| `modules/drivers/documents.ts` | Document uploads, review, requirements, hourly expiry (auto-suspend). |
| `modules/drivers/money.ts` | Deposit rules: wallet status, the balance threshold, per-driver commission. |
| `modules/wallet/ledger.ts` | `postLedger()`: the one way money moves; returns the new balance. |
| `lib/storage.ts` | Signed upload/download URLs: S3-compatible storage or the local disk (development). |
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
| `drivers.view` / `drivers.approve` | View driver profiles, vehicles, documents / review documents; approve, reject, suspend |
| `drivers.commission` | Set a driver's custom commission rate (audited) |
| `finance.deposits.record` | Record a deposit received at the office (ledger kind `deposit`) |
| `finance.refunds.manage` | Pay out or reject deposit refund requests |
| `trips.view` / `trips.cancel` | View trips, timelines, ratings / cancel active trips |
| `finance.daybook.view` | The day book: one Addis Ababa day of trips and wallet movements |
| `finance.wallets.view` / `finance.wallets.adjust` | Wallet balances and history / manual credit or debit (with reason) |
| `pricing.manage` / `zones.manage` | Fares and commission / service zones (database rules ready; screens not built yet) |
| `sos.view` / `sos.manage` | SOS alerts / acknowledge and resolve (database rules ready; screens not built yet) |
| `audit.view` | The audit log of every back-office action |

Adding a permission: add it to `PERMISSIONS`, `INSERT` it in a new migration, gate the route with
`requirePermission`, and add an RLS policy if it controls data.

## Driver onboarding, deposits and commission (CP5)

**Documents.** Required for approval: licence and photo per driver; libre, insurance and bolo per vehicle.
The licence, insurance and bolo need an expiry date.
1. The app calls `POST /drivers/me/documents {docType, vehicleId?, contentType, sizeBytes}`.
   It gets a document row and a signed `PUT` URL (10 min; jpeg, png, webp or pdf; at most 10 MB; content type and length are signed).
2. The app uploads the bytes straight to storage. The API never proxies them on its JSON routes.
3. The app calls `POST /drivers/me/documents/:id/submit {expiresOn?}`. The API checks that the object exists (else `409 DOCUMENT_NOT_UPLOADED`).
4. Staff review with `POST /admin/documents/:id/review`. Rejecting needs a reason. Expired documents can't be approved. An approved document retires the older copy (`replaced`).
5. `POST /admin/drivers/:id/review` with `approved` fails with `422 DOCUMENTS_INCOMPLETE` (and `details.missing`) until every required document is approved.
6. Once an hour, the sweeper expires approved documents past their date. It suspends the driver with `suspended_reason = DOCUMENT_EXPIRED:<type>` and takes them offline.

Storage is chosen by `STORAGE_DRIVER`:
- `s3`: any S3-compatible store (`S3_*` env); presigned URLs; CI tests it against moto.
- `local`: development; files under `STORAGE_DIR`, served by `/api/v1/files/*key` with HMAC-signed, expiring URLs.

**Deposits.** Drivers prepay commission:
- Staff record cash received with `POST /admin/drivers/:id/deposits`, at least `min_deposit` (default 10,000 ETB). It is ledger kind `deposit`, written in SYSTEM context with `created_by` set to the staff member.
- Each completed trip deducts commission from the wallet: the driver's `commission_bps`, or `default_commission_bps` (10%).
- Below `low_balance_threshold` the driver:
  - can finish the current trip;
  - is taken offline at completion;
  - is skipped by dispatch;
  - is refused on `online` and `accept` with `402 DEPOSIT_REQUIRED` (wallet status in `details`).
- Below `low_balance_warning` the app is told to top up (`wallet.needsTopUp`, socket `driver:wallet`).

**Refunds.** After `refund_after_days` (default 90) from approval, a driver may request the remaining balance:
- `POST /drivers/me/refunds`, with at most one pending request.
- Staff pay it out as a `payout` (the driver goes offline) or reject it with a reason.

All the thresholds live in `app_settings` and are edited on the back-office Settings page.

## Matching (dispatch v2)

1. Online drivers live in `drivers:geo:<category>` (Redis GEO). Drivers silent for 60 s are taken offline by the sweeper.
2. For a searching trip: the 9 nearest available drivers who haven't declined or ignored it, by straight-line
   distance from Redis (fast, free).
3. Ranked by **driving time to the pickup** with one Gebeta matrix call (driver → pickup; direction matters on
   one-way and divided roads). If Gebeta fails, straight-line order with a road-factor estimate.
4. The best **2** get an offer for 20 s (`trip_offers.eta_s` records the ETA). A decline starts the next round
   immediately; otherwise the sweeper does when the window lapses.
5. First `accept` wins (`UPDATE … WHERE status = 'searching'`). The other offers become `withdrawn`: those drivers
   can be offered the trip again and it doesn't count against their acceptance rate.
6. A driver backing out after accepting puts the trip back to `searching` with a fresh 3-minute window; that
   driver isn't offered it again.
7. The sweeper (every 5 s, one instance at a time via a Redis lock) expires trips searching for 3 minutes,
   expires lapsed offers, starts next rounds, takes silent drivers offline and repairs stale "on trip" states.

Fares at completion: quote + extra minutes beyond the estimate at the per-minute rate, capped at
`overtime_cap_bps` (default 25%) of the quote; commission is charged on the final fare.

Check dispatch end-to-end with `pnpm --filter @simple-ride/api simulate` against a running API.

## Scaling notes
- With more than one API instance, add `@socket.io/redis-adapter` so `emitToUser` reaches sockets on other nodes.
- Driver pings never touch Postgres on the hot path. The 30 s throttle keeps write load at about 2 writes/min per online driver.

## API conventions (for web and Flutter)

The machine-readable contract is [`docs/openapi.json`](openapi.json) (OpenAPI 3.1, also served at
`GET /api/v1/openapi.json`), generated from the same Zod schemas the routes validate with
(`src/contract/`). Error codes and what apps should do about each: [`ERRORS.md`](ERRORS.md).
Dart client: `tools/generate-dart-client.sh`.

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
| GET/PATCH/POST | `/admin/settings` (GET/PATCH, `pricing.manage`) · `/admin/stats` · `/admin/users` · `/admin/users/:id/status` · `/admin/drivers/pending` · `/admin/drivers/:id/review` · `/admin/trips` · `/admin/trips/:id/cancel` · `/admin/finance/daybook?date=` · `/admin/wallets/:id` · `/admin/wallets/:id/adjust` · `/admin/audit` | admin, or staff with the matching permission |
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
