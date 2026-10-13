import cors from "cors";
import express from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { authenticate } from "./auth/middleware.js";
import { authRouter } from "./auth/routes.js";
import { env } from "./config/env.js";
import { buildOpenApi } from "./contract/openapi.js";
import { pool } from "./db/pool.js";
import { errorHandler, notFoundHandler } from "./lib/errors.js";
import { logger } from "./lib/logger.js";
import { redis } from "./lib/redis.js";
import { adminRouter } from "./modules/admin/routes.js";
import { catalogRouter } from "./modules/catalog/routes.js";
import { driversRouter } from "./modules/drivers/routes.js";
import { filesRouter } from "./modules/files/routes.js";
import { geoRouter } from "./modules/geo/routes.js";
import { tripsRouter } from "./modules/trips/routes.js";
import { usersRouter } from "./modules/users/routes.js";

/** Routers under /api/v1 and where they're mounted (also used by the OpenAPI coverage test). */
export const apiRouters: [string, express.Router][] = [
  ["/auth", authRouter],
  ["/users", usersRouter],
  ["/catalog", catalogRouter],
  ["/geo", geoRouter],
  ["/drivers", driversRouter],
  ["/trips", tripsRouter],
  ["/admin", adminRouter],
  ["/files", filesRouter],
];

export function createApp() {
  const app = express();
  app.set("trust proxy", 1);
  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGINS.split(","), credentials: true }));
  app.use(express.json({ limit: "100kb" }));
  app.use(pinoHttp({ logger }));

  app.get("/health", async (_req, res) => {
    await Promise.all([pool.query("SELECT 1"), redis.ping()]);
    res.json({ status: "ok" });
  });

  // Versioned from day one: shipped mobile apps can't be force-updated, so
  // breaking changes go to /api/v2 while v1 keeps serving older builds.
  const v1 = express.Router();
  // Machine-readable contract for the Flutter apps (generate a Dart client from it).
  let spec: unknown;
  v1.get("/openapi.json", (_req, res) => {
    spec ??= buildOpenApi();
    res.json(spec);
  });
  v1.use(authenticate);
  for (const [mount, router] of apiRouters) v1.use(mount, router);
  app.use("/api/v1", v1);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
