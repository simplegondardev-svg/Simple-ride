import pg from "pg";
import { env } from "../config/env.js";

// Return bigint (int8) columns, used for money, as JS numbers. Wallet
// balances in santim stay far below Number.MAX_SAFE_INTEGER.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number(v));
// Calendar dates (e.g. licence expiry) stay "YYYY-MM-DD" strings. The default
// parser makes a JS Date at local midnight, which on a UTC+3 server would be
// serialised as the previous day.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

/** Runtime pool. Connects as the RLS-bound app role. */
export const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 20 });
