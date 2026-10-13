import { validate } from "@readme/openapi-parser";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { apiRouters, createApp } from "../src/app.js";
import { buildOpenApi, operations } from "../src/contract/openapi.js";
import { STAFF_MOUNT, staffRouter } from "../src/modules/admin/routes.js";
import { pool } from "../src/db/pool.js";
import { redis } from "../src/lib/redis.js";

afterAll(async () => {
  await pool.end();
  redis.disconnect();
});

/** Every "METHOD /path" registered on the Express routers. */
function registeredRoutes(): string[] {
  const out: string[] = [];
  const walk = (router: any, prefix: string) => {
    for (const layer of router.stack) {
      if (!layer.route) continue;
      for (const m of Object.keys(layer.route.methods)) {
        out.push(`${m.toUpperCase()} ${(prefix + layer.route.path).replace(/\/$/, "") || "/"}`);
      }
    }
  };
  for (const [mount, router] of apiRouters) walk(router, mount);
  walk(staffRouter, `/admin${STAFF_MOUNT}`);
  return out.sort();
}

describe("OpenAPI spec", () => {
  it("documents every route, and only routes that exist", () => {
    const documented = operations.map((o) => `${o.method.toUpperCase()} ${o.path}`).sort();
    expect(documented).toEqual(registeredRoutes());
  });

  it("is a valid OpenAPI 3.1 document", async () => {
    const result = await validate(structuredClone(buildOpenApi()) as any);
    expect("errors" in result ? result.errors : []).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("is served publicly at /api/v1/openapi.json", async () => {
    const res = await request(createApp()).get("/api/v1/openapi.json").expect(200);
    expect(res.body.openapi).toBe("3.1.0");
    expect(res.body.paths["/trips/{id}"].get.responses["200"].content["application/json"].schema)
      .toEqual({ $ref: "#/components/schemas/TripDetail" });
  });

  it("uses the same validation as the routes (request schema = route schema)", () => {
    const spec = buildOpenApi() as any;
    const body = spec.paths["/trips"].post.requestBody.content["application/json"].schema;
    expect(body.required).toEqual(expect.arrayContaining(["clientRequestId", "categoryCode", "pickup", "dropoff"]));
    expect(body.required).not.toContain("paymentMethod"); // has a default
  });
});

describe("committed spec (docs/openapi.json)", () => {
  it("is up to date — run `pnpm --filter @simple-ride/api openapi` after changing the API", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const committed = JSON.parse(readFileSync(path.join(import.meta.dirname, "..", "..", "..", "docs", "openapi.json"), "utf8"));
    expect(committed).toEqual(JSON.parse(JSON.stringify(buildOpenApi())));
  });
});
