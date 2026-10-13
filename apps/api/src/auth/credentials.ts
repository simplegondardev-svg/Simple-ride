import type { PoolClient } from "pg";
import { hashPassword, temporaryPassword } from "./password.js";

/**
 * Give a user a new temporary password (shown once to whoever issued it)
 * and sign them out everywhere. They must choose their own password at the
 * next login. `db` must be in SYSTEM context: credentials are system-only.
 */
export async function issueTemporaryPassword(db: PoolClient, userId: string): Promise<string> {
  const temp = temporaryPassword();
  await db.query(
    `INSERT INTO user_credentials (user_id, password_hash, must_change_password)
     VALUES ($1, $2, true)
     ON CONFLICT (user_id) DO UPDATE
       SET password_hash = EXCLUDED.password_hash, must_change_password = true,
           password_changed_at = now(), failed_attempts = 0, locked_until = NULL`,
    [userId, await hashPassword(temp)],
  );
  await db.query("UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [userId]);
  return temp;
}
