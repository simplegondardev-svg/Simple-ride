# Simple Ride — Product & Delivery Plan

This document covers what the market looks like, what we take from it, the complete feature set by
role, and the order we build it in. Confidence tags: **[Certain]** verified fact, **[Likely]** well-sourced
but not independently confirmed, **[Guessing]** assumption that needs validation.

---

## 1. Market research

### Uber (global reference)
- **Hexagonal grid (H3)** for pricing and dispatch: demand, supply and price are computed per hexagon
  cell, not per city. [Certain — Uber engineering blog]
- **ETA-based matching**, not straight-line distance: "nearest" is often not "fastest" in a city with
  one-way streets and congestion. Matching also considers drivers about to finish a trip. [Likely]
- Upfront pricing, a safety toolkit (share trip, emergency button, PIN verification), ratings both ways,
  scheduled rides, and business accounts. [Certain]

### RIDE (Hybrid Designs PLC, Addis Ababa, since 2014)
- Book **by app or by calling 8294**. The call centre is a core channel for people without
  smartphones or data, and also handles lost items and support. [Certain — App Store listing]
- **Says it does not use surge pricing**, and offers pre-booking days ahead plus **corporate accounts
  with monthly billing**. [Certain — App Store listing]
- Sedans (4 seats), minivans (7) and minibuses (12). [Certain]

### Feres (since 2020)
- Won drivers with **zero, then low, commission** and by **letting drivers work on other platforms**.
  [Likely — Shega and Addis Fortune reporting]
- Rider loyalty: **cashback, bonuses, "Feres Miles"**. [Likely]
- Expanded to Kenya, Sudan, Tanzania and Uganda as **Faras**, at about 15% commission in Kenya. [Likely]

### Yango (in Ethiopia since October 2023)
- Runs through a **local franchise partner** (G2G IT Group / ShuuFare), and the app is available in
  Amharic. [Likely — Shega]
- Driver retention programmes ("Yango Cares": fuel vouchers and rewards for top drivers). [Likely —
  Capital Ethiopia]

### Market facts that shape the design
- Typical commission is **8–12% of driver earnings**, with some platforms as low as 5%; at least one
  (Lift) runs a **driver subscription model** instead of commission. [Likely]
- The Addis Ababa Transport Bureau says **over 50 platforms operate but only 17 are recognised**:
  licensing and compliance are a launch requirement, not an afterthought. [Likely — Capital Ethiopia]
- **Drivers compete on what they keep.** Driver satisfaction drives market share, because drivers
  multi-home across apps and pick the best offer. [Likely]
- Many drivers **rent their vehicles** and pay up to half their income to the owner, so fleet owners
  are a real stakeholder. [Likely — Rest of World]

### Ethiopian realities → design decisions

| Reality | Decision |
|---|---|
| Cash is the default | Cash is a first-class payment method. Commission is debited from a **prepaid driver wallet** (done in the scaffold). Drivers top up with telebirr. |
| Mobile money is growing (telebirr, CBE Birr, M-Pesa) | `payments` table is provider-agnostic. telebirr first, aggregator (e.g. Chapa) second. |
| No formal street addresses | Landmark search (Gebeta geocoding), pin drop, **saved places**, and a call-driver button. Addresses are free-text labels next to coordinates. |
| Unreliable mobile data | **Idempotency keys** on trip requests (done), small payloads, SMS fallback for critical events, clients re-sync with `GET /trips/:id` on reconnect. |
| Phone-first identity | **Phone + OTP** login, no passwords (done). Ethiopian number normalisation for 09/07 prefixes (done). |
| Feature-phone users | Phase 2 **dispatcher console**: ops staff book on a caller's behalf (the RIDE 8294 model). |
| Languages | `users.locale` supports `am`, `en`, `om`, `ti` (done). Apps ship Amharic and English first. |
| Ethiopian calendar and time | Apps format dates in the Ethiopian calendar and local 12-hour clock when the user chooses. The API always uses UTC ISO-8601. |
| Government-set fuel prices change | Fares are **admin-editable data** per category and zone, never code. |
| Regulation | Store driver documents (licence, vehicle ownership booklet "libre", insurance, annual inspection "bolo"), with expiry tracking and audit logs (audit table done). |

---

## 2. What the scaffold already does (Phase 0) ✅

- Monorepo: `apps/api` (Express 5 + TypeScript), `apps/web` (Next.js 16), Docker Compose for PostGIS + Redis.
- **Roles: customer, driver, admin**, plus an internal `system` context for trusted server code.
- **Row-level security on every table**, with column-guard triggers for privileged fields. Tested at
  SQL level by connecting as the runtime role.
- Phone OTP auth, short-lived JWT access tokens, rotating refresh tokens with reuse detection, per-device sessions.
- Driver onboarding (profile, vehicle) → admin approval → go online/offline.
- Live driver positions in a Redis GEO index; PostGIS persistence throttled to every 30 s.
- Fare estimate (distance, time, minimum fare, zone multiplier, booking fee), operating and restricted zones in PostGIS.
- Trip lifecycle: request → dispatch (broadcast to the nearest 5) → accept (atomic, first wins) → arrive → start (**ride PIN**) → complete → rate.
  Includes cancellation, expiry, re-dispatch sweeps, and one active trip per rider and per driver.
- Money: wallets plus an immutable ledger. Cash-trip commission is debited from the driver; wallet trips are settled.
- Realtime over Socket.IO: offers to drivers, trip updates, driver location streamed to the rider.
- Gebeta client (routing, geocoding, reverse geocoding) with Redis caching and a straight-line fallback.
- Web: OTP login, rider booking on a map, admin dashboard (stats, driver approvals, trips). Tokens stay in httpOnly cookies.

---

## 3. Feature inventory by role

`P1` is needed to launch, `P2` follows soon after, `P3` is for scale and growth.

### Rider (Flutter app; web booking as a secondary channel)
| Feature | Phase |
|---|---|
| Phone OTP login, profile, language | ✅ |
| Pick pickup/drop-off by landmark search, pin, saved places, recent places | P1 |
| See nearby cars on the map before booking | P1 |
| Upfront fare per category; pay with cash or wallet | ✅ |
| Live driver tracking, ETA to pickup, driver and vehicle details, ride PIN | ✅ API / P1 app |
| Call driver; in-app chat | P1 call / P2 chat |
| Cancel (free within N minutes, then a cancellation fee) | ✅ cancel / P1 fee |
| Share trip with a contact (SMS link), **SOS button** | P1 |
| Trip history and receipts (SMS and e-mail) | P1 |
| Rate driver, tip, report lost item | ✅ rating / P2 rest |
| Scheduled rides | P2 |
| Pay with telebirr / CBE Birr | P2 |
| Promo codes, referrals, loyalty points | P2 |
| Multi-stop trips; book for someone else | P3 |
| Corporate accounts with monthly invoicing | P2 |

### Driver (Flutter app)
| Feature | Phase |
|---|---|
| Onboarding: profile, vehicle, **document upload** with expiry dates | ✅ profile+vehicle / P1 documents |
| Go online/offline; background location (foreground service on Android) | ✅ API / P1 app |
| Trip offers with countdown, accept or decline; navigation (Gebeta, or hand off to an external app) | ✅ API / P1 app |
| Arrive → verify PIN → start → complete; collect cash | ✅ |
| Earnings: daily and weekly summaries, trip breakdown, commission | P1 |
| **Wallet top-up via telebirr**; low-balance warning; auto-offline below a floor | P1 |
| Incentives: quests ("20 trips this week → 500 ETB"), peak-hour bonuses | P2 |
| Heat map of demand | P2 |
| Rate rider, report rider | ✅ rating / P2 report |
| Fleet-owner sub-accounts (owner sees vehicles, drivers and earnings) | P3 |

### Admin / operations (Next.js dashboard)
| Feature | Phase |
|---|---|
| Stats, driver approvals, trip list | ✅ |
| User management: suspend, reactivate, with audit trail | ✅ API / P1 UI |
| Document review with expiry alerts | P1 |
| **Zone editor**: draw operating, airport and restricted polygons on the map | P1 |
| Fare and commission editor per category and zone | P1 |
| **Live ops map**: online drivers, active trips, open SOS alerts | P1 |
| SOS console: acknowledge, call, view live location, resolve | P1 |
| Support: trip timeline (`trip_events`), refunds, adjustments | P1 |
| Dispatcher console: book for phone callers | P2 |
| Promotions, campaigns, push broadcasts | P2 |
| Finance: commission reports, payouts, reconciliation with providers, VAT reports | P2 |
| Fine-grained staff roles (support, ops, finance, super-admin) | P2 |

### Platform
| Capability | Phase |
|---|---|
| Push notifications (FCM) for offers, status changes and promos | P1 |
| SMS provider behind the `SmsSender` interface (AfroMessage or Ethio Telecom gateway) [Guessing on provider] | P1 |
| **Dispatch v2**: rank candidates by road ETA via the Gebeta one-to-many API, sequential offers with a short window, acceptance-rate weighting, matching drivers about to finish a trip | P1 |
| Fraud: GPS-spoofing detection, collusion (same device for rider and driver), cancellation abuse | P2 |
| Dynamic pricing on an **H3 grid** (supply/demand per cell), capped and transparent. RIDE markets itself as having no surge pricing, so treat this as a product decision | P2 |
| Observability: structured logs (done), metrics, tracing, uptime and SLO alerts | P1 |
| Background workers (dispatch, sweeps, notifications) split out of the API process | P2 |
| Analytics warehouse; demand forecasting | P3 |
| New verticals: bajaj and motorbike, parcel delivery | P3 |

---

## 4. Roadmap

**Phase 1: launch-ready MVP (Addis Ababa)**
1. Flutter rider and driver apps against the existing API (see §5).
2. Real SMS provider, FCM push, a Gebeta key with verified endpoints, and a restricted tiles key for the apps.
3. Dispatch v2 (ETA ranking and sequential offers), cancellation fees, driver wallet top-up via telebirr.
4. Driver documents (S3-compatible object storage, signed upload URLs) and admin review with expiry alerts.
5. Admin: zone editor, fare editor, live map, SOS console, user management UI.
6. Receipts, trip sharing, SOS.
7. Production infrastructure: managed Postgres with PostGIS, Redis, a container platform, TLS, backups, staging environment, CI/CD.

**Phase 2: growth.** Rider telebirr payments, promos, referrals and loyalty, scheduled rides, corporate accounts,
dispatcher console, incentives, chat, fraud rules, fine-grained admin roles, finance reports.

**Phase 3: scale.** Workers and an event bus, Redis cluster, read replicas, H3 dynamic pricing, fleet owners,
new cities and verticals, data warehouse.

---

## 5. Flutter readiness (decisions already baked into the API)

- **Versioned REST** at `/api/v1`. Shipped app builds can't be force-updated, so breaking changes go to `/api/v2`.
- **Bearer tokens**, not cookies, for mobile. Store the refresh token in `flutter_secure_storage`. Send `platform`
  (`android`/`ios`) and a stable `deviceId` at login, so sessions are per device and can be revoked.
- **Uniform JSON**: camelCase keys, `{ "error": { "code", "message", "details" } }` with stable `code`s
  for localised error messages, ISO-8601 UTC timestamps, money as integer **santim**, coordinates as `{ lat, lng }`.
- **Idempotency**: `clientRequestId` (UUID generated on the device) on trip requests, so retries are safe.
- **Realtime**: Socket.IO (Dart package `socket_io_client`) with `auth: { token }`. Treat events as hints and
  re-fetch state on reconnect. FCM covers the app when it's in the background.
- **Driver location**: emit `driver:location` every 3–5 s while online. Use a foreground service on Android
  (e.g. `geolocator` with a foreground notification).
- **Maps**: Gebeta tiles in the app (`maplibre_gl`, or Gebeta's Flutter SDK). Routing and geocoding go
  **through our API** so the paid key stays server-side and responses are cached.
- Next step: generate an **OpenAPI spec** from the Zod schemas and run `openapi-generator` (dart-dio)
  to produce typed Flutter clients.

---

## 6. Open questions (decisions the business must make)

1. **Commission vs subscription**: percentage (seeded at 10–12%) or a flat driver subscription (Lift model),
   or a hybrid? This changes the wallet and ledger flows.
2. **Real fares**: the seeded fares (e.g. Economy 60 ETB base, 22 ETB/km, 2 ETB/min, 150 ETB minimum) are
   **placeholders** [Guessing]. They need benchmarking against RIDE, Feres and Yango quotes on common routes.
3. **Surge pricing**: RIDE markets itself as having no surge pricing. Do we use dynamic pricing at all?
4. **Licensing**: Transport Bureau recognition, trade licence, and VAT and e-invoicing obligations.
5. **Payments contracts**: telebirr merchant onboarding (H5 web checkout and in-app SDK), CBE Birr, an aggregator?
6. **SMS provider** and expected OTP volume and cost.
7. **Gebeta plan**: request quotas and pricing for directions, matrix and geocoding at our expected volume.
8. **Driver multi-homing**: Feres won drivers by allowing it. We should too, and compete on what drivers keep.

### Sources
- [Uber Engineering — H3](https://www.uber.com/en-US/blog/h3/)
- [QCon 2015 — Scaling Uber's realtime market platform](https://theburningmonk.com/2015/03/qcon-london-2015takeaways-from-scaling-ubers-realtime-market-platform/)
- [RIDE: Ethiopia & Djibouti — App Store](https://apps.apple.com/us/app/-/id1375514824) · [RIDE Driver ET](https://apps.apple.com/us/app/-/id1375519435)
- [Shega — Ethiopia's ride-hailing battleground](https://mediav3-dev.shega.co/news/ethiopias-ride-hailing-battleground-why-happy-drivers-means-market-share)
- [Shega — Feres expands in East Africa](https://shega.co/news/ethiopias-feres-quietly-expands-in-east-africa-takes-on-bolt-uber-safe-boda)
- [Shega — Lift, subscription-based ride hailing](https://shega.co/news/lift-the-first-subscription-based-ride-hailing-platform-in-ethiopia)
- [Shega — Yango launches in Ethiopia](https://shega.co/news/international-ride-hailing-platform-yango-launches-service-in-ethiopia)
- [Capital Ethiopia — Yango driver engagement](https://capitalethiopia.com/2025/03/03/yango-ethiopia-boosts-driver-engagement-with-rewards-and-community-events/)
- [Capital Ethiopia — Ethiopia's ride-hailing market](https://capitalethiopia.com/2024/03/18/ethiopias-ride-hailing-market/)
- [Rest of World — Ride-hailing drivers in Ethiopia](https://restofworld.org/2021/global-gig-workers-ride-hailing-driver-ethiopia/)
- [Addis Fortune editorial](https://addisfortune.news/?p=14860)
- [Gebeta Maps docs](https://docs.gebeta.app/) · [Direction API](https://docs.gebeta.app/docs/direction) · [ONM API](https://docs.gebeta.app/docs/onm) · [Matrix API](https://docs.gebeta.app/docs/matrix) · [gebetamap Dart package](https://pub.dev/documentation/gebetamap/latest/) · [gebeta-tiles](https://github.com/AfriGebeta/gebeta-tiles)
- Telebirr community SDKs (unofficial): [PyPI telebirr](https://pypi.org/project/telebirr/0.0.6), [telebirrts](https://github.com/kaleabteweld/telebirrts)
