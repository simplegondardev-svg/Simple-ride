/**
 * Writes the OpenAPI spec to docs/openapi.json (committed, for the Flutter
 * team to generate the Dart client from). test/openapi.test.ts fails if the
 * committed file is out of date — rerun:
 *
 *   pnpm --filter @simple-ride/api openapi
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { buildOpenApi } from "../src/contract/openapi.js";

const out = path.join(import.meta.dirname, "..", "..", "..", "docs", "openapi.json");
writeFileSync(out, JSON.stringify(buildOpenApi(), null, 2) + "\n");
console.log(`wrote ${path.relative(process.cwd(), out)}`);
// Importing the routes opens Redis/Postgres pools; nothing else to do.
process.exit(0);
