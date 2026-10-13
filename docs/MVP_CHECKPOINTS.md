# MVP checkpoints

From the current scaffold to a working pilot. Each checkpoint has a goal, the work, and **exit criteria**:
concrete checks that must pass before the checkpoint counts as done. Tick boxes as work lands.

## What "MVP" means here

A **closed pilot in Addis Ababa**:
- 30–50 vetted drivers and a few hundred invited riders.
- **Android** rider and driver apps (Flutter). iOS comes after the pilot.
- Payment by **cash** or **in-app wallet**. Drivers top up their commission wallet in person; staff record
  it with the existing wallet-adjustment tool. telebirr comes after the pilot.
- A small ops/support team working in the back office.
- Phone numbers verified by SMS.

The MVP is reached when a stranger can install the app, sign up, book, get picked up, pay and rate,
without anyone from the team stepping in, and the team can see and resolve problems when they happen.

## Where we are (checkpoint 0) ✅

API with RLS-enforced roles (rider, driver, admin, staff with per-person permissions), password auth,
trip lifecycle with dispatch, cash commission and wallet settlement, Gebeta routing, geocoding and tiles
verified live, web rider booking and back office (staff, day book), 108 tests, CI workflow.
See `docs/ARCHITECTURE.md`.

## Business decisions (agreed Oct 2026)

| Topic | Decision |
|---|---|
| Revenue | Percentage commission, **10% default for every driver**, adjustable per driver by admin. |
| How commission is collected | **Prepaid deposit**: drivers deposit (default minimum 10,000 ETB, admin-set) and commission is deducted per trip. They re-deposit when it runs low. |
| Low balance | Below an admin-set threshold: can finish the current trip, can't go online or get offers until they deposit. |
| Deposit refunds | Refundable on request after **3 months** with us (admin-adjustable). |
| Fares | Placeholder rates for now; benchmark against RIDE, Feres and Yango on 5–10 common routes before the pilot. |
| Cancellation fees | **None for now**: most riders pay cash at the destination, so a fee can't be enforced. Revisit when riders prepay. |
| Longer trips | Quote + extra minutes at the per-minute rate, capped at **+25%** of the quote (admin-adjustable). |
| Gebeta key | Keep the current key for testing; rotate and split server and tiles keys before the pilot (CP9). |

## Start now: business and legal track (runs alongside all checkpoints)

These have lead times that development can't shorten. Each one blocks a specific checkpoint.

| Item | Owner | Blocks |
|---|---|---|
| Fare benchmark: real RIDE, Feres and Yango quotes on 5–10 common routes | Business | CP10 |
| SMS provider contract (e.g. AfroMessage, Ethio Telecom bulk SMS), sender ID approval | Business | CP3 |
| Gebeta plan and quota for the expected trip volume; rotate the key shared during testing | Business | CP2, CP9 |
| Transport Bureau recognition, trade licence, tax and VAT and receipt (e-invoicing) rules | Legal | CP10 |
| Terms of service and privacy policy (Ethiopian personal data protection law) | Legal | CP10 |
| Google Play developer account, app name, icon, store listing in Amharic and English | Business | CP10 |
| Hosting choice: data location, provider, budget | Business + tech | CP9 |
| Driver recruitment, document checks, training session, pilot driver agreement | Ops | CP10 |
| Support phone line and on-call rota | Ops | CP10 |

---

## CP1 — Foundations for parallel work

**Goal:** lock decisions and publish an API contract, so the Flutter apps can start while the backend continues.

- [x] Record the business decisions — see "Business decisions" below and `docs/PLAN.md` §6 (Oct 2026).
- [x] Generate an **OpenAPI spec** from the existing Zod schemas, served at `/api/v1/openapi.json` and committed as `docs/openapi.json`. Generate a Dart client from it (`tools/generate-dart-client.sh`).
- [x] Confirm CI passes on GitHub — green on `main` since run #2 (Oct 2026).
- [x] Gebeta key: decided to keep the current key for testing; rotation moved to CP9.
- [x] Error codes catalogue in the docs (every `error.code` the apps must handle): `docs/ERRORS.md`.

**Exit:** CI is green on `main`. The OpenAPI spec covers every `/api/v1` route, and a generated Dart client compiles.

✅ **CP1 done (Oct 2026).** All 50 routes are in the spec (enforced by a test that compares it with the router).
Real responses are checked against the response models by contract tests. The generated Dart client (dart-dio)
compiles with no errors, and a test program using it registered a rider, got a live Gebeta estimate and decoded an
error code. CI regenerates and analyzes the Dart client on every push.

## CP2 — Dispatch and trips that hold up in real streets

**Goal:** riders get picked up fast, and stuck or abandoned trips sort themselves out.

- [x] Rank candidate drivers by **real driving time to the pickup**, using Gebeta's matrix (driver → pickup), not straight-line distance. Fall back to straight-line distance when Gebeta is down.
- [x] Offer to one or two drivers at a time with a short window, then the next ones. Track acceptance rate per driver.
- [x] Driver cancels after accepting → the trip goes back to searching instead of ending.
- [x] Drivers whose app stops pinging go offline automatically; stale "on trip" states are recovered.
- [x] Overtime at completion: quote + (actual minutes − estimated minutes) × the category's per-minute rate,
      capped at **+25%** of the quote (admin-adjustable). Never below the quote. Shown to rider and driver.
- [x] The trip sweeper takes a Redis lock, so several API instances don't double-dispatch.
- [x] Simulation script (`pnpm --filter @simple-ride/api simulate`): 50 fake drivers moving around Addis and 200 trip requests, reporting acceptance rate and pickup times.

**Exit:** the simulation completes with no stuck trips. Median time to accept is under 30 s. Results are logged in the PR.

✅ **CP2 done (Oct 2026).** Simulation results:

| Run | Trips | Stuck | Median accept | p90 accept | Median driver ETA |
|---|---|---|---|---|---|
| 50 drivers, 200 trips, straight-line fallback | 200 completed | 0 | 4.2 s | 25.9 s | 4.1 min |
| 10 drivers, 30 trips, live Gebeta ranking | 28 completed, 2 expired (more requests than drivers) | 0 | 6.2 s | 35.0 s | 12.0 min |

Offering to 2 drivers at once means the slower one sometimes gets "already taken" (86 of 200 trips). That's
the trade-off for short waits; revisit if drivers complain.

## CP3 — SMS verification and self-service password reset

**Goal:** phone numbers are real, and riders recover their own accounts. (Plan in `CLAUDE.md`.)

- [ ] `SmsSender` for the chosen provider. Delivery failures logged; send limits per phone and per IP.
- [ ] Sign-up requires an SMS code; `phone_verified_at` is set.
- [ ] Forgot password with an SMS code: resets the password, clears lockout, signs out everywhere.
- [ ] Existing unverified accounts verify at their next login. Unverified riders can't book and unverified drivers can't go online.
- [ ] Tests for wrong, expired and reused codes, limits, and no account enumeration.

**Exit:** a real phone receives the code in under 30 s. All auth tests pass. SMS cost per sign-up is measured.

## CP4 — Notifications and realtime reliability

**Goal:** nobody misses an offer or a status change because the app was in the background.

- [ ] FCM push: trip offers to drivers; accepted, arrived, started, completed and cancelled to riders.
- [ ] Socket.IO Redis adapter, so events reach users connected to any API instance.
- [ ] On reconnect, the apps re-sync from `GET /trips/:id`. Documented and tested.
- [ ] SMS fallback for "driver arrived" when push isn't delivered (optional; check SMS cost).

**Exit:** with the app backgrounded on a real Android phone, a driver receives an offer and a rider sees "driver arrived" within 5 s.

## CP5 — Driver onboarding and earnings

**Goal:** drivers sign up and get approved properly, and can see what they've earned.

- [ ] Document uploads (licence, vehicle ownership booklet "libre", insurance, annual inspection "bolo", photo) to S3-compatible storage with signed URLs. Expiry dates stored.
- [ ] Back office: document review screen, approve or reject with a reason, expiry alerts, auto-suspend on expiry.
- [ ] Driver earnings API: today, this week, per trip, commission, wallet balance.
- [ ] **Prepaid commission deposit:** a new driver can't go online until they deposit at least the admin-set
      minimum (default 10,000 ETB). Commission is deducted from it trip by trip.
- [ ] **Low balance:** warn early; below the admin-set threshold the driver can finish the current trip but
      can't go online or receive offers until they deposit again (at least the minimum deposit).
- [ ] **Custom commission per driver** set by admin (overrides the 10% default), recorded in the audit log.
- [ ] **Deposit refund:** remaining balance refundable on request once the driver has been with us for the
      admin-set period (default 3 months from approval); recorded as a `payout` in the ledger and day book.
- [ ] Deposits and top-ups at the office: staff record cash received with a dedicated "deposit" entry
      (not a manual adjustment), and it appears in the day book.
- [ ] Admin settings screen for: minimum deposit, low-balance threshold, refund period, overtime cap, default commission.

**Exit:** a new driver goes from sign-up to approved and online using only the app and back office, and their earnings match the day book.

## CP6 — Flutter rider app (Android)

**Goal:** riders can do everything from their phone.

- [ ] Sign up and log in (with SMS verification), Amharic and English.
- [ ] Gebeta map. Pickup by GPS, pin drop, or place search (with "near me" ranking); saved places.
- [ ] Fare options, payment choice (cash or wallet), request ride, cancel.
- [ ] Live driver on the map, ETA, driver and vehicle details, ride PIN, call driver.
- [ ] Trip history and receipts, rating, SOS button, share trip.
- [ ] Handles flaky networks: retries with `clientRequestId`, offline banner, resume an active trip after restart.

**Exit:** five non-team testers each complete a ride on their own phones on mobile data, without help.

## CP7 — Flutter driver app (Android)

**Goal:** drivers can work a full shift from the app.

- [ ] Sign up, document upload, approval status.
- [ ] Go online and offline; background location via a foreground service; battery-conscious ping interval.
- [ ] Offer screen with countdown and sound; accept and decline.
- [ ] Navigate to pickup and drop-off (in-app Gebeta route, or hand off to an external navigation app); arrive; enter ride PIN; start; complete; collect cash.
- [ ] Earnings and wallet screens; low-balance warning.

**Exit:** a test driver completes a 4-hour shift with real trips, and the phone keeps sending its location with the screen off.

## CP8 — Back office for operations

**Goal:** the ops team can run the pilot and handle incidents.

- [ ] Live map: online drivers, active trips, open SOS alerts.
- [ ] SOS console: alert sound, rider and driver details, live location, call buttons, resolve with notes.
- [ ] Trip detail with the full timeline (`trip_events`), cancel, refund or adjust.
- [ ] Rider and driver search, suspend, password reset (API exists; screens needed).
- [ ] Fare and commission editor, and zone editor (draw polygons on the Gebeta map). The permissions already exist.
- [ ] Daily report: trips, completion rate, cancellations, revenue and commission (extends the day book).

**Exit:** in a rehearsal, staff handle a mock SOS, a lost item, a disputed fare and a driver document expiry, using only the back office.

## CP9 — Production infrastructure and security

**Goal:** the system runs safely without anyone watching the terminal.

- [ ] Staging and production environments; deploy from CI; database migrations run as a deploy step.
- [ ] Managed PostgreSQL with PostGIS, and Redis, with automatic **backups and a tested restore**.
- [ ] TLS, secrets in a secrets manager, no keys in images or logs. The seed admin password is not printed into deploy logs.
- [ ] Monitoring: error tracking, uptime checks, alerts (API down, error spike, sweeper stalled, Gebeta failing, SMS failing).
- [ ] Load test: 200 concurrent drivers pinging location, 50 trip requests per minute.
- [ ] Security review: run `/security-review`, and an external pen test if the budget allows.
- [ ] **Rotate the Gebeta key** shared during testing. Separate keys: server key for the API, and a domain-restricted
      key or short-lived tokens via `@gebeta/node` for map tiles.

**Exit:** a restore drill brings the database back from a backup in staging. Alerts fire in a simulated outage. The load test passes with p95 API latency under 500 ms.

## CP10 — Pilot launch

**Goal:** real rides with real people, closely watched.

- [ ] Legal items from the business track done (licence, terms, privacy policy).
- [ ] Rider and driver apps on Google Play: closed testing track, then the pilot release.
- [ ] Drivers onboarded and trained; support line live; runbooks for common incidents.
- [ ] Pilot dashboard tracks the success metrics below, reviewed weekly.

**Pilot success metrics (targets to agree with the business):**
completed trips per day · driver acceptance rate · median pickup time · rider cancellation rate ·
SOS response time · crash-free sessions · driver earnings per online hour.

**Exit:** 2 weeks of pilot with the metrics tracked, no data-loss or safety incidents left unresolved,
and a go or no-go decision for a wider launch.

---

## Order and parallel work

```
CP1 ──┬── CP2 ── CP4 ───────────────┐
      ├── CP3 ──────────────────────┤
      ├── CP5 ──────────────────────┼── CP8 ── CP9 ── CP10
      └── CP6 (rider app) ──────────┤
          CP7 (driver app) ─────────┘
```

- **CP1 first:** it unblocks everything else, and the OpenAPI contract lets app development start right away.
- **Backend** (CP2–CP5) and **apps** (CP6–CP7) run in parallel; the apps plug into each backend checkpoint as it lands.
- **CP9 can start early.** Setting up staging during CP2 means every later checkpoint is tested in a real environment.
- The **business and legal track** starts now; CP3 (SMS provider) and CP10 (licensing) are most likely to wait on it.

## After the pilot (not MVP)

telebirr payments for riders and driver top-ups · iOS apps · promos and referrals · scheduled rides ·
corporate accounts · charging by distance actually driven (Gebeta Map Matching) · dispatcher console for
phone bookings · dynamic pricing (a business decision) · fleet owners.
