import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import { z } from "zod";
import { verifyAccessToken } from "../auth/tokens.js";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { recordPing } from "../modules/drivers/presence.js";

/**
 * Realtime channel (Socket.IO; Flutter uses the `socket_io_client` package).
 *
 * Auth: pass the access token as `auth: { token }` in the handshake.
 * Every socket joins `user:<id>`; the server pushes trip updates there.
 *
 * Server → client events:
 *   trip:offer     { tripId, pickup, dropoff, fareEstimate, expiresAt }  (drivers)
 *   trip:updated   { tripId, status, ... }                                (both parties)
 *   driver:location{ tripId, lat, lng, heading }                          (rider on trip)
 * Client → server:
 *   driver:location { lat, lng, heading? }  (drivers; same as POST /drivers/me/location)
 *
 * Push (FCM) covers the app being backgrounded; sockets are the foreground
 * fast path. Never rely on a socket event alone for a state change: clients
 * re-fetch GET /trips/:id on reconnect.
 */

let io: Server | null = null;

export function initRealtime(server: HttpServer) {
  io = new Server(server, {
    cors: { origin: env.CORS_ORIGINS.split(","), credentials: true },
  });

  io.use((socket, next) => {
    try {
      const claims = verifyAccessToken(String(socket.handshake.auth?.token ?? ""));
      socket.data.userId = claims.sub;
      socket.data.role = claims.role;
      next();
    } catch {
      next(new Error("UNAUTHENTICATED"));
    }
  });

  const ping = z.object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    heading: z.number().min(0).max(360).optional(),
  });

  io.on("connection", (socket) => {
    socket.join(`user:${socket.data.userId}`);
    if (socket.data.role === "driver") {
      socket.on("driver:location", async (payload) => {
        const p = ping.safeParse(payload);
        if (!p.success) return;
        await recordPing(socket.data.userId, p.data).catch((err) =>
          logger.warn({ err }, "driver ping failed"),
        );
      });
    }
  });
  return io;
}

/** Emit to every connected device of a user. No-op before initRealtime(). */
export function emitToUser(userId: string, event: string, payload: unknown) {
  io?.to(`user:${userId}`).emit(event, payload);
}
