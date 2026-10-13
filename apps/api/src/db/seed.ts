import pg from "pg";
import { hashPassword, temporaryPassword } from "../auth/password.js";

/**
 * Development seed (idempotent): vehicle categories with illustrative Addis
 * Ababa fares, an Addis operating zone, and an admin account.
 * Fares are placeholders — set real ones from market research before launch.
 */
const categories = [
  // code, name, seats, base, per_km, per_min, minimum, booking_fee, commission_bps, sort
  ["economy", "Economy", 4, 6000, 2200, 200, 15000, 0, 1000, 1],
  ["comfort", "Comfort", 4, 9000, 3000, 300, 22000, 0, 1200, 2],
  ["minivan", "Minivan", 7, 12000, 3800, 350, 30000, 0, 1200, 3],
] as const;

// Rough bounding polygon around Addis Ababa (replace with ops-drawn zones).
const ADDIS = "MULTIPOLYGON(((38.64 8.83, 38.92 8.83, 38.92 9.10, 38.64 9.10, 38.64 8.83)))";

async function seed() {
  const url = process.env.DATABASE_OWNER_URL;
  if (!url) throw new Error("DATABASE_OWNER_URL is required to seed");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("BEGIN");
    for (const c of categories) {
      await client.query(
        `INSERT INTO vehicle_categories (code, name, seats, base_fare, per_km, per_minute, minimum_fare,
             booking_fee, commission_bps, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (code) DO NOTHING`,
        [...c],
      );
    }
    await client.query(
      `INSERT INTO service_zones (name, kind, area)
       SELECT 'Addis Ababa', 'operating', ST_GeogFromText($1)
        WHERE NOT EXISTS (SELECT 1 FROM service_zones WHERE name = 'Addis Ababa')`,
      [`SRID=4326;${ADDIS}`],
    );
    const phone = process.env.SEED_ADMIN_PHONE ?? "+251900000000";
    const { rows } = await client.query(
      `INSERT INTO users (phone, role, full_name) VALUES ($1, 'admin', 'Admin')
       ON CONFLICT (phone, role) DO UPDATE SET role = 'admin' RETURNING id`,
      [phone],
    );
    await client.query("INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT DO NOTHING", [rows[0].id]);
    // First run only: a temporary password, printed once, changed at first login.
    const temp = temporaryPassword();
    const { rowCount } = await client.query(
      `INSERT INTO user_credentials (user_id, password_hash, must_change_password)
       VALUES ($1, $2, true) ON CONFLICT (user_id) DO NOTHING`,
      [rows[0].id, await hashPassword(temp)],
    );
    await client.query("COMMIT");
    console.log(`seeded categories, Addis zone, admin ${phone}`);
    if (rowCount) console.log(`admin temporary password: ${temp}  (you'll choose your own at first login)`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    await client.end();
  }
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
