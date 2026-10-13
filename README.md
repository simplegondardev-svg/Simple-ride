# Simple Ride

Ride hailing for Ethiopia: riders, drivers and an operations dashboard. Gebeta Maps provides maps and routing.

| | |
|---|---|
| `apps/api` | Node 22 · Express 5 · TypeScript · PostgreSQL 16 + PostGIS · Redis · Socket.IO |
| `apps/web` | Next.js 16: rider web booking and admin dashboard |
| Mobile | Flutter rider and driver apps (planned; the API is built for them, see [docs/PLAN.md §5](docs/PLAN.md#5-flutter-readiness-decisions-already-baked-into-the-api)) |

- **[docs/PLAN.md](docs/PLAN.md)**: market research (Uber, RIDE, Feres, Yango), the full feature set by role, and the roadmap.
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**: how the system fits together, the security model, and API conventions.

## Quick start

```bash
# 1. Infrastructure (PostGIS + Redis)
docker compose up -d

# 2. Install
corepack enable && pnpm install

# 3. Configure
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local
#    set GEBETA_API_KEY in apps/api/.env (optional: without it routes use a straight-line estimate)

# 4. Database
pnpm db:migrate
pnpm db:seed          # vehicle categories, Addis Ababa zone, admin +251900000000
                      # prints the admin's temporary password ONCE — copy it

# 5. Run (two terminals)
pnpm dev:api          # http://localhost:4000
pnpm dev:web          # http://localhost:3000
```

Everyone logs in with **phone number + password**. Open http://localhost:3000/login, choose **Admin**, enter
`0900000000` and the temporary password from the seed; you'll be asked to choose your own. Riders sign up at
`/register`. Create staff under **Staff**: you get a temporary password to hand over, and they choose their own at
first login.

Admin locked out or forgot the password? On the server:

```bash
pnpm --filter @simple-ride/api reset-password 0900000000 admin   # prints a new temporary password
```

## Tests

```bash
pnpm --filter @simple-ride/api test
```

You need Postgres and Redis running and migrations applied. The suite covers:
- **`rls.test.ts`**: connects as the runtime DB role and attacks the row-level security policies directly
  (reading other riders' trips, self-assigning a trip, editing fares, self-approval, crediting a wallet…).
- **`ride-flow.test.ts`**: a full ride over HTTP: sign-up → driver onboarding → admin approval → estimate →
  book (idempotent) → dispatch → accept → arrive → PIN-checked start → complete → commission debit → ratings.
- **`auth.test.ts`**: registration, login, lockout after 5 wrong passwords, no account enumeration, password
  change and support resets, hashes unreadable even by admins, session lengths.
- **`staff.test.ts`**: staff see and change only what they were granted, can't grant themselves anything, and are
  locked out the moment they're suspended; plus the admin → staff flow over HTTP.
- **`unit.test.ts`**: fare maths, Ethiopian phone normalisation, the trip state machine, Gebeta parsing.

## Roles and security in one paragraph

Each account has one role: `customer`, `driver`, `admin` or `staff`. Admins can do everything and are the only
ones who create staff. Each staff member gets a **personal list of permissions** that an admin switches on and off
(for example "View the day book" or "Approve drivers"); the full list is in `docs/ARCHITECTURE.md`. The same phone can hold a rider account and a driver
account, like the separate apps. The API connects to Postgres as `simpleride_app`, which **does not own the
tables and cannot bypass RLS**. Each request runs in a transaction that sets `app.user_id` and `app.role`, and
the policies in [`0003_rls.sql`](apps/api/src/db/migrations/0003_rls.sql) decide which rows that user can see
or change. Trusted server paths (login, dispatch, settlement) use an explicit `system` context. A token can
never produce that context. Details are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
