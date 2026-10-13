import pg from "pg";
import { env } from "../config/env.js";

// Return bigint (int8) columns, used for money, as JS numbers. Wallet
// balances in santim stay far below Number.MAX_SAFE_INTEGER.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number(v));

/** Runtime pool. Connects as the RLS-bound app role. */
export const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 20 });
