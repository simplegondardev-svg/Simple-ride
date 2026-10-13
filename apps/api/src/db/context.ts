import type { PoolClient } from "pg";
import { pool } from "./pool.js";

export type DbRole = "customer" | "driver" | "admin" | "staff" | "system" | "anonymous";

export interface DbContext {
  userId: string | null;
  role: DbRole;
}

export const SYSTEM: DbContext = { userId: null, role: "system" };
export const ANONYMOUS: DbContext = { userId: null, role: "anonymous" };

/**
 * Run `fn` in a transaction whose RLS context is `ctx`.
 *
 * This is the ONLY way application code should touch the database. It calls
 * app.init_context(), which sets app.user_id / app.role (and, for staff,
 * app.permissions) with set_config(..., is_local = true), so the values
 * vanish at COMMIT/ROLLBACK and can never leak to the next request that
 * reuses this pooled connection. It also re-checks the account on every
 * transaction: suspended users are rejected immediately (SQLSTATE 28000).
 */
export async function withContext<T>(
  ctx: DbContext,
  fn: (db: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT app.init_context($1, $2)", [ctx.userId, ctx.role]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
