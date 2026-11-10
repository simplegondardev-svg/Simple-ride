import { createHash } from "node:crypto";
import jwt from "jsonwebtoken";
import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { env } from "../src/config/env.js";
import {
  createSession,
  revokeSession,
  rotateSession,
  signAccessToken,
  verifyAccessToken,
  type UserRole,
} from "../src/auth/tokens.js";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

describe("JWT Access Tokens (offline unit tests)", () => {
  it("signs and verifies access tokens successfully", () => {
    const claims = { sub: "user-uuid-1234", role: "customer" as UserRole };
    const token = signAccessToken(claims);
    expect(typeof token).toBe("string");

    const decoded = verifyAccessToken(token);
    expect(decoded.sub).toBe(claims.sub);
    expect(decoded.role).toBe(claims.role);
  });

  it("rejects expired access tokens", () => {
    const expiredToken = jwt.sign(
      { sub: "user-123", role: "driver" },
      env.JWT_ACCESS_SECRET,
      { algorithm: "HS256", expiresIn: -10 },
    );
    expect(() => verifyAccessToken(expiredToken)).toThrow();
  });

  it("rejects tokens signed with an invalid secret", () => {
    const forgedToken = jwt.sign(
      { sub: "user-123", role: "admin" },
      "wrong-secret-key-that-does-not-match-env",
      { algorithm: "HS256" },
    );
    expect(() => verifyAccessToken(forgedToken)).toThrow();
  });

  it("rejects tokens signed with the 'none' algorithm", () => {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ sub: "user-123", role: "admin" })).toString("base64url");
    const unsignedToken = `${header}.${payload}.`;
    expect(() => verifyAccessToken(unsignedToken)).toThrow();
  });

  it.each([
    ["not-a-token"],
    ["header.payload"],
    ["header.payload.signature.extra"],
  ])("rejects malformed token strings '%s'", (malformed) => {
    expect(() => verifyAccessToken(malformed)).toThrow();
  });

  it.each([
    [{ role: "customer" }],
    [{ sub: "user-123" }],
    [{}],
  ])("rejects tokens missing sub or role (%o)", (missingClaims) => {
    const token = jwt.sign(missingClaims, env.JWT_ACCESS_SECRET, { algorithm: "HS256" });
    expect(() => verifyAccessToken(token)).toThrow(/malformed token/);
  });
});

describe("Session Refresh Tokens (offline unit tests with mock DB)", () => {
  const dummySessionId = "11111111-2222-3333-4444-555555555555";

  it("createSession stores sha256(secret) and returns formatted sessionId.secret", async () => {
    let capturedQuery = "";
    let capturedParams: any[] = [];

    const mockDb = {
      query: vi.fn(async (query: string, params: any[]) => {
        capturedQuery = query;
        capturedParams = params;
        return { rows: [{ id: dummySessionId }] };
      }),
    } as unknown as PoolClient;

    const token = await createSession(mockDb, "user-abc", {
      platform: "android",
      deviceId: "device-1",
      userAgent: "TestAgent/1.0",
      ttlHours: 24,
    });

    const [sessionId, secret] = token.split(".");
    expect(sessionId).toBe(dummySessionId);
    expect(secret).toBeTruthy();
    expect(capturedQuery).toContain("INSERT INTO auth_sessions");
    expect(capturedParams[0]).toBe("user-abc");
    expect(capturedParams[1]).toBe(sha256(secret!));
    expect(capturedParams[2]).toBe("android");
  });

  it("rotateSession rejects malformed refresh tokens without querying DB", async () => {
    const mockDb = { query: vi.fn() } as unknown as PoolClient;

    expect(await rotateSession(mockDb, "not-a-valid-token")).toEqual({ ok: false });
    expect(await rotateSession(mockDb, "notauuid.secret")).toEqual({ ok: false });
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it("rotateSession returns ok: false if session is not found in DB", async () => {
    const mockDb = {
      query: vi.fn(async () => ({ rows: [] })),
    } as unknown as PoolClient;

    const result = await rotateSession(mockDb, `${dummySessionId}.someSecret`);
    expect(result).toEqual({ ok: false });
  });

  it("rotateSession detects token theft and revokes session when secret mismatch occurs", async () => {
    const queries: string[] = [];
    const secretInToken = "stolenOrOldSecret";
    const actualHashInDb = sha256("actualValidSecret");

    const mockDb = {
      query: vi.fn(async (q: string) => {
        queries.push(q);
        if (q.includes("SELECT s.refresh_token_hash")) {
          return {
            rows: [
              {
                refresh_token_hash: actualHashInDb,
                user_id: "user-123",
                role: "customer",
                status: "active",
              },
            ],
          };
        }
        return { rows: [] };
      }),
    } as unknown as PoolClient;

    const result = await rotateSession(mockDb, `${dummySessionId}.${secretInToken}`);
    expect(result).toEqual({ ok: false });
    expect(queries.some((q) => q.includes("UPDATE auth_sessions SET revoked_at = now()"))).toBe(true);
  });

  it("rotateSession revokes session if user status is suspended", async () => {
    const validSecret = "correctSecretValue";
    const mockDb = {
      query: vi.fn(async (q: string) => {
        if (q.includes("SELECT s.refresh_token_hash")) {
          return {
            rows: [
              {
                refresh_token_hash: sha256(validSecret),
                user_id: "user-123",
                role: "customer",
                status: "suspended",
              },
            ],
          };
        }
        return { rows: [] };
      }),
    } as unknown as PoolClient;

    const result = await rotateSession(mockDb, `${dummySessionId}.${validSecret}`);
    expect(result).toEqual({ ok: false });
  });

  it("rotateSession successfully rotates secret on valid token", async () => {
    const validSecret = "validInitialSecret";
    let updatedHash = "";

    const mockDb = {
      query: vi.fn(async (q: string, params?: any[]) => {
        if (q.includes("SELECT s.refresh_token_hash")) {
          return {
            rows: [
              {
                refresh_token_hash: sha256(validSecret),
                user_id: "user-123",
                role: "customer",
                status: "active",
              },
            ],
          };
        }
        if (q.includes("UPDATE auth_sessions SET refresh_token_hash")) {
          updatedHash = params![1];
          return { rows: [] };
        }
        return { rows: [] };
      }),
    } as unknown as PoolClient;

    const result = await rotateSession(mockDb, `${dummySessionId}.${validSecret}`);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.userId).toBe("user-123");
      expect(result.role).toBe("customer");
      const [newSessionId, newSecret] = result.refreshToken.split(".");
      expect(newSessionId).toBe(dummySessionId);
      expect(newSecret).not.toBe(validSecret);
      expect(sha256(newSecret!)).toBe(updatedHash);
    }
  });

  it("revokeSession revokes session when valid token provided", async () => {
    let capturedQuery = "";
    let capturedParams: any[] = [];

    const mockDb = {
      query: vi.fn(async (q: string, params?: any[]) => {
        capturedQuery = q;
        capturedParams = params ?? [];
        return { rows: [] };
      }),
    } as unknown as PoolClient;

    await revokeSession(mockDb, `${dummySessionId}.secretToRevoke`);
    expect(capturedQuery).toContain("UPDATE auth_sessions SET revoked_at = now()");
    expect(capturedParams[0]).toBe(dummySessionId);
    expect(capturedParams[1]).toBe(sha256("secretToRevoke"));
  });
});
