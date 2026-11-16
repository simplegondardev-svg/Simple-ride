import pg from "pg";
import { env } from "../config/env.js";
import { getVerifiedDatabaseUrl } from "./isolation.js";

// Return bigint (int8) columns, used for money, as JS numbers. Wallet
// balances in santim stay far below Number.MAX_SAFE_INTEGER.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number(v));
// Calendar dates (e.g. licence expiry) stay "YYYY-MM-DD" strings. The default
// parser makes a JS Date at local midnight, which on a UTC+3 server would be
// serialised as the previous day.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

let _pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (!_pool) {
    const connectionString = getVerifiedDatabaseUrl(env.DATABASE_URL);
    _pool = new pg.Pool({ connectionString, max: 20 });
  }
  return _pool;
}

/** Runtime pool. Connects as the RLS-bound app role. */
export const pool = new Proxy({} as pg.Pool, {
  get(_target, prop, receiver) {
    const p = getPool();
    const val = Reflect.get(p, prop, receiver);
    if (typeof val === "function") {
      return val.bind(p);
    }
    return val;
  },
});
