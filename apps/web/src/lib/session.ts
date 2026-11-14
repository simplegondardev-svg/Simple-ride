import { cookies } from "next/headers";

/**
 * Web session = the API's access + refresh tokens in httpOnly cookies.
 * Browser JS never sees the tokens (XSS can't steal them); all API calls go
 * through /api/proxy, which attaches the bearer token server-side.
 * The Flutter apps talk to the API directly and store tokens in secure storage.
 */
export const API_URL = process.env.API_URL ?? "http://localhost:4000";
const AT = "sr_at";
const RT = "sr_rt";
const secure = process.env.NODE_ENV === "production";

export interface SessionCookieOptions {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "lax" | "strict" | "none";
  path: string;
  maxAge: number;
}

export interface CookieStore {
  get(name: string): { value: string } | undefined;
  set(name: string, value: string, opts: SessionCookieOptions): void;
  delete(name: string): void;
}

export interface SessionManager {
  setSession(accessToken: string, refreshToken: string): Promise<void>;
  clearSession(): Promise<void>;
  getTokens(): Promise<{ accessToken?: string; refreshToken?: string }>;
}

export type CookieStoreResolver = CookieStore | (() => Promise<CookieStore> | CookieStore);

/**
 * Factory creating an isolated SessionManager bound to a provided CookieStore
 * or a dynamic cookie-store resolver. Defaults to Next.js cookies().
 */
export function createSessionManager(resolver: CookieStoreResolver = async () => cookies()): SessionManager {
  const getJar = async (): Promise<CookieStore> => {
    if (typeof resolver === "function") {
      return await resolver();
    }
    return resolver;
  };

  return {
    async setSession(accessToken: string, refreshToken: string) {
      const jar = await getJar();
      jar.set(AT, accessToken, { httpOnly: true, secure, sameSite: "lax", path: "/", maxAge: 15 * 60 });
      jar.set(RT, refreshToken, { httpOnly: true, secure, sameSite: "lax", path: "/", maxAge: 30 * 86400 });
    },
    async clearSession() {
      const jar = await getJar();
      jar.delete(AT);
      jar.delete(RT);
    },
    async getTokens() {
      const jar = await getJar();
      return { accessToken: jar.get(AT)?.value, refreshToken: jar.get(RT)?.value };
    },
  };
}

// Default production session manager
const defaultSession = createSessionManager();

export const setSession = defaultSession.setSession;
export const clearSession = defaultSession.clearSession;
export const getTokens = defaultSession.getTokens;

/** Exchange the refresh token for a new pair. Returns the new access token. */
export async function refresh(session: SessionManager = defaultSession): Promise<string | null> {
  const { refreshToken } = await session.getTokens();
  if (!refreshToken) return null;
  const res = await fetch(`${API_URL}/api/v1/auth/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  });
  if (!res.ok) {
    await session.clearSession();
    return null;
  }
  const body = await res.json();
  await session.setSession(body.accessToken, body.refreshToken);
  return body.accessToken;
}
