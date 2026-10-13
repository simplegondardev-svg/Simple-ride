# Simple Ride — notes for Claude

Ride hailing for Ethiopia (Addis Ababa first). pnpm monorepo:

- `apps/api` — Express 5 + TypeScript, PostgreSQL 16 + PostGIS, Redis, Socket.IO
- `apps/web` — Next.js 16: rider booking + admin/staff back office (BFF with httpOnly cookies)
- Flutter rider and driver apps are planned; the API is their contract (see `docs/PLAN.md` §5)

Read `docs/ARCHITECTURE.md` (how it works, security model, endpoints) and `docs/PLAN.md`
(research, features, roadmap) before larger changes. **The path to the MVP is `docs/MVP_CHECKPOINTS.md`**:
work in checkpoint order, tick boxes as work lands, and don't call a checkpoint done until its exit criteria pass.

## Commands

```bash
docker compose up -d                       # PostGIS + Redis
pnpm install
pnpm db:migrate && pnpm db:seed            # seed prints the admin's temporary password once
pnpm dev:api / pnpm dev:web
pnpm --filter @simple-ride/api test        # needs Postgres + Redis running and migrations applied
pnpm -r typecheck
pnpm --filter @simple-ride/api reset-password <phone> [role]   # break-glass temporary password
```

In Claude's cloud container, Node's `fetch` ignores the outbound proxy: run the API with
`NODE_USE_ENV_PROXY=1` to reach Gebeta (not needed on normal servers).

Without Docker: the DB needs two roles, `simpleride_owner` (owns schema, runs migrations) and
`simpleride_app` (LOGIN, NOBYPASSRLS) — see `infra/postgres/init.sh` and `.github/workflows/ci.yml`.
Tests use the dev database and Redis DB 15.

## Rules that must not be broken

- **All app queries go through `withContext(ctx, fn)`** (`src/db/context.ts`). It sets the RLS
  context via `app.init_context()`. Never query the pool directly, never connect as the owner from the app.
- **RLS is the source of truth.** Every new table: `ENABLE ROW LEVEL SECURITY`, policies, minimal
  grants to `simpleride_app`, and tests in `test/rls.test.ts` / `test/staff.test.ts` that connect as the
  runtime role and try to break them. Route checks (`requireRole`, `requirePermission`) are the first
  layer, not the only one.
- **`SYSTEM` context only in trusted server paths** (auth, dispatch/accept, settlement, sweeps,
  credentials). It must never be derivable from a token or request input.
- **Migrations on `main` are frozen.** Never edit an applied migration; add `NNNN_name.sql`. A new
  enum value needs its own migration (it can't be used in the transaction that adds it).
- **New staff permission** = add to `PERMISSIONS` in `src/auth/permissions.ts` + `INSERT` in a new
  migration + `requirePermission()` on the route + an RLS policy using `app.can('…')` if it gates data.
  Staff management stays admin-only — there is deliberately no permission for it.
- **Credentials** (`user_credentials`) are readable only in `SYSTEM` context. Never return a hash, never log passwords.
- **API contract (Flutter depends on it):** `/api/v1` (breaking changes → `/api/v2`), camelCase JSON,
  `{ error: { code, message, details } }` with stable codes, money as integer **santim** (1 ETB = 100),
  coordinates as `{ lat, lng }`, ISO-8601 UTC timestamps, `clientRequestId` idempotency on trip creation.
- **Changing the API** = keep request schemas exported from the route file, add/adjust the entry in
  `src/contract/openapi.ts` and the response model in `src/contract/responses.ts`, add new error codes to
  `docs/ERRORS.md`, then run `pnpm --filter @simple-ride/api openapi` to refresh `docs/openapi.json`.
  Tests fail if any of these is missed.
- **Gebeta Maps** routing/geocoding only through `src/modules/geo/gebeta.ts` (server-side key, Redis cache, fallback).
  The live API differs from docs.gebeta.app (no trailing slash on `/onm` and `/matrix`, ONM distance in km,
  search needs `?apiKey` not a header) — see the table in `docs/ARCHITECTURE.md` before changing it.
  Gebeta docs as one file: https://docs.gebeta.app/llms-full.txt
- **Never commit keys.** Gebeta keys live only in `apps/api/.env` and `apps/web/.env.local` (git-ignored).
- Postgres parameters used both as enum/text or in comparisons need explicit casts (`$2::approval_status`,
  `$2::int`) — inference has caused 500s here twice.

## Authentication — current state

Phone + **password** for every role (`/auth/register` for riders/drivers, `/auth/login` for all).
scrypt hashes, 5-strike 15-minute lockout, temporary passwords (shown once, must be changed at next
login) for staff creation and all resets, 12 h back-office sessions, 30 d rider/driver sessions.

**This is a testing-phase setup.** Phone numbers are NOT verified (`users.phone_verified_at` is always
NULL), so anyone can register any number and there is no self-service password reset.

## TODO: SMS OTP verification (agreed, must be added before public launch)

The building blocks already exist: `src/auth/otp.ts` (6-digit codes in Redis, 5-minute TTL, 5 attempts,
`SmsSender` interface with a console implementation), rate-limit helper, `users.phone_verified_at`, and
`OTP_DEV_ECHO` (refused in production by `src/config/env.ts`). Plan:

1. **SMS provider**: implement `SmsSender` for the chosen Ethiopian provider (e.g. AfroMessage or the
   Ethio Telecom gateway — business decision, not yet made); set it via `setSmsSender()` at startup.
   Keep the per-phone (3 per 10 min) and per-IP limits on sending — every SMS costs money.
2. **Verify at sign-up**: `POST /auth/register/start {phone}` sends a code; `POST /auth/register`
   additionally takes `code` and sets `phone_verified_at = now()`. Registration without a valid code fails.
3. **Self-service password reset**: `POST /auth/password/forgot {phone, role}` sends a code (same response
   whether or not the account exists); `POST /auth/password/reset {phone, role, code, newPassword}`
   sets the password, clears lockout, revokes all sessions.
4. **Existing unverified accounts**: on login, if `phone_verified_at IS NULL`, return a flag and have the
   apps run a verify step (`POST /auth/phone/verify/start` + `/confirm`). Decide whether unverified riders
   may book (recommendation: no) and whether drivers may go online (recommendation: no).
5. **Admin/staff**: keep password login; optionally add the SMS code as a second factor for back office.
6. **Tests** (`test/auth.test.ts`): wrong/expired/reused code, attempt limit, send rate limits, no account
   enumeration on forgot-password, reset revokes sessions, unverified accounts gated as decided.
7. Update `docs/ARCHITECTURE.md` (Authentication), `docs/PLAN.md`, the web login/register pages, and the
   Flutter contract notes.

## Other known gaps

- Seeded fares are placeholders until benchmarked. Business rules (10% default commission, prepaid driver
  deposit, low-balance block, refunds after 3 months, +25% overtime cap, no cancellation fees) are decided —
  see the table in `docs/MVP_CHECKPOINTS.md`. Overtime is implemented (CP2); the deposit rules are CP5.
- `pricing.manage`, `zones.manage`, `sos.*` permissions have RLS rules but no endpoints/screens yet.
- telebirr payments, push notifications (FCM), driver document uploads — see `docs/MVP_CHECKPOINTS.md`.
- Dispatch changes: rerun `pnpm --filter @simple-ride/api simulate` against a running API (CP2 exit check).
