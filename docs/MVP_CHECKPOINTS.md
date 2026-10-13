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

## Start now: business and legal track (runs alongside all checkpoints)

These have lead times that development can't shorten. Each one blocks a specific checkpoint.

| Item | Owner | Blocks |
|---|---|---|
| Fares, commission (or subscription), cancellation fee policy | Business | CP1 |
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

- [ ] Record the business decisions (fares per category, commission, cancellation rules) in the seed and in `docs/PLAN.md`.
- [ ] Generate an **OpenAPI spec** from the existing Zod schemas, served at `/api/v1/openapi.json`. Generate a Dart client from it.
- [x] Confirm CI passes on GitHub — green on `main` since run #2 (Oct 2026).
- [ ] Rotate the Gebeta key; separate keys for the API (server) and tiles (domain-restricted).
- [ ] Error codes catalogue in the docs (every `error.code` the apps must handle).

**Exit:** CI is green on `main`. The OpenAPI spec covers every `/api/v1` route, and a generated Dart client compiles.

## CP2 — Dispatch and trips that hold up in real streets

**Goal:** riders get picked up fast, and stuck or abandoned trips sort themselves out.

- [ ] Rank candidate drivers by **real driving time to the pickup**, using Gebeta's matrix (driver → pickup), not straight-line distance. Fall back to straight-line distance when Gebeta is down.
- [ ] Offer to one or two drivers at a time with a short window, then the next ones. Track acceptance rate per driver.
- [ ] Driver cancels after accepting → the trip goes back to searching instead of ending.
- [ ] Cancellation fee after N minutes (per the CP1 policy), charged to the wallet or added to the next trip.
- [ ] Drivers whose app stops pinging go offline automatically; stale "on trip" states are recovered.
- [ ] Fare re-check at completion if the route was far longer than quoted (policy from CP1).
- [ ] The trip sweeper takes a Redis lock, so several API instances don't double-dispatch.
- [ ] Simulation script: 50 fake drivers moving around Addis and 200 trip requests, reporting acceptance rate and pickup times.

**Exit:** the simulation completes with no stuck trips. Median time to accept is under 30 s. Results are logged in the PR.

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
- [ ] Low wallet balance: warn below a threshold; block going online below the floor (policy from CP1).
- [ ] Wallet top-up at the office: staff record cash received using the existing adjustment flow, and it appears in the day book.

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
- [ ] Security review: run `/security-review`, and an external pen test if the budget allows. Short-lived Gebeta tile tokens via `@gebeta/node`.

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
