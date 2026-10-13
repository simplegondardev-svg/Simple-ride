import { createHash, randomBytes } from "node:crypto";
import jwt from "jsonwebtoken";
import type { PoolClient } from "pg";
import { env } from "../config/env.js";

export type UserRole = "customer" | "driver" | "admin";
export type Platform = "web" | "android" | "ios";

export interface AccessClaims {
  sub: string;
  role: UserRole;
}

export function signAccessToken(claims: AccessClaims): string {
  return jwt.sign(claims, env.JWT_ACCESS_SECRET, {
    algorithm: "HS256",
    expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
  });
}

export function verifyAccessToken(token: string): AccessClaims {
  const payload = jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ["HS256"] });
  if (typeof payload === "string" || !payload.sub || !payload.role) {
    throw new Error("malformed token");
  }
  return { sub: payload.sub, role: payload.role as UserRole };
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * Refresh tokens are opaque: `<sessionId>.<secret>`. Only sha256(secret) is
 * stored. Each refresh rotates the secret; presenting an old secret for a
 * live session means the token was stolen, so the session is revoked.
 * Mobile clients keep the refresh token in secure storage
 * (flutter_secure_storage); the web client keeps it in an httpOnly cookie.
 */
export async function createSession(
  db: PoolClient,
  userId: string,
  meta: { platform: Platform; deviceId?: string; userAgent?: string },
): Promise<string> {
  const secret = randomBytes(32).toString("base64url");
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO auth_sessions (user_id, refresh_token_hash, platform, device_id, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(days => $6))
     RETURNING id`,
    [userId, sha256(secret), meta.platform, meta.deviceId ?? null, meta.userAgent ?? null,
     env.REFRESH_TOKEN_TTL_DAYS],
  );
  return `${rows[0]!.id}.${secret}`;
}

export type RotateResult =
  | { ok: true; userId: string; role: UserRole; refreshToken: string }
  | { ok: false };

/** Must run in SYSTEM context (the caller is not authenticated yet). */
export async function rotateSession(db: PoolClient, refreshToken: string): Promise<RotateResult> {
  const [sessionId, secret] = refreshToken.split(".");
  if (!sessionId || !secret || !/^[0-9a-f-]{36}$/.test(sessionId)) return { ok: false };

  const { rows } = await db.query<{
    refresh_token_hash: string; user_id: string; role: UserRole; status: string;
  }>(
    `SELECT s.refresh_token_hash, s.user_id, u.role, u.status
       FROM auth_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
      FOR UPDATE OF s`,
    [sessionId],
  );
  const session = rows[0];
  if (!session) return { ok: false };

  if (session.refresh_token_hash !== sha256(secret) || session.status !== "active") {
    await db.query("UPDATE auth_sessions SET revoked_at = now() WHERE id = $1", [sessionId]);
    return { ok: false };
  }

  const next = randomBytes(32).toString("base64url");
  await db.query(
    "UPDATE auth_sessions SET refresh_token_hash = $2, last_used_at = now() WHERE id = $1",
    [sessionId, sha256(next)],
  );
  return { ok: true, userId: session.user_id, role: session.role, refreshToken: `${sessionId}.${next}` };
}

export async function revokeSession(db: PoolClient, refreshToken: string) {
  const [sessionId, secret] = refreshToken.split(".");
  if (sessionId && secret && /^[0-9a-f-]{36}$/.test(sessionId)) {
    await db.query(
      "UPDATE auth_sessions SET revoked_at = now() WHERE id = $1 AND refresh_token_hash = $2",
      [sessionId, sha256(secret)],
    );
  }
}
