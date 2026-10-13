import pg from "pg";
import { hashPassword, temporaryPassword } from "../auth/password.js";
import { normalizeEthiopianPhone } from "../lib/phone.js";

/**
 * Break-glass: issue a temporary password for any account from the server.
 * Use when the only admin is locked out or forgot their password.
 *
 *   pnpm --filter @simple-ride/api reset-password 0911223344 admin
 */
const [rawPhone, role = "admin"] = process.argv.slice(2);
const phone = rawPhone && normalizeEthiopianPhone(rawPhone);
if (!phone || !["customer", "driver", "admin", "staff"].includes(role)) {
  console.error("usage: reset-password <phone> [customer|driver|admin|staff]");
  process.exit(1);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_OWNER_URL });
await client.connect();
try {
  const { rows: [user] } = await client.query("SELECT id FROM users WHERE phone = $1 AND role = $2", [phone, role]);
  if (!user) throw new Error(`no ${role} account for ${phone}`);
  const temp = temporaryPassword();
  await client.query("BEGIN");
  await client.query(
    `INSERT INTO user_credentials (user_id, password_hash, must_change_password) VALUES ($1, $2, true)
     ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, must_change_password = true,
       password_changed_at = now(), failed_attempts = 0, locked_until = NULL`,
    [user.id, await hashPassword(temp)],
  );
  await client.query("UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [user.id]);
  await client.query(
    "INSERT INTO audit_logs (action, entity, entity_id, data) VALUES ('cli.reset_password', 'user', $1, $2)",
    [user.id, { role }],
  );
  await client.query("COMMIT");
  console.log(`Temporary password for ${role} ${phone}: ${temp}\n(must be changed at next login)`);
} catch (err) {
  await client.query("ROLLBACK").catch(() => {});
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await client.end();
}
