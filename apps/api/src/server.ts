import { createServer } from "node:http";
import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { pool } from "./db/pool.js";
import { logger } from "./lib/logger.js";
import { redis } from "./lib/redis.js";
import { initRealtime } from "./realtime/socket.js";
import { sweepTrips } from "./modules/trips/service.js";

const server = createServer(createApp());
initRealtime(server);

const sweeper = setInterval(() => {
  sweepTrips().catch((err) => logger.error({ err }, "trip sweep failed"));
}, 5000);

server.listen(env.PORT, () => logger.info(`API listening on :${env.PORT}`));

async function shutdown() {
  clearInterval(sweeper);
  server.close();
  await Promise.allSettled([pool.end(), redis.quit()]);
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
