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

export async function setSession(accessToken: string, refreshToken: string) {
  const jar = await cookies();
  jar.set(AT, accessToken, { httpOnly: true, secure, sameSite: "lax", path: "/", maxAge: 15 * 60 });
  jar.set(RT, refreshToken, { httpOnly: true, secure, sameSite: "lax", path: "/", maxAge: 30 * 86400 });
}

export async function clearSession() {
  const jar = await cookies();
  jar.delete(AT);
  jar.delete(RT);
}

export async function getTokens() {
  const jar = await cookies();
  return { accessToken: jar.get(AT)?.value, refreshToken: jar.get(RT)?.value };
}

/** Exchange the refresh token for a new pair. Returns the new access token. */
export async function refresh(): Promise<string | null> {
  const { refreshToken } = await getTokens();
  if (!refreshToken) return null;
  const res = await fetch(`${API_URL}/api/v1/auth/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  });
  if (!res.ok) {
    await clearSession();
    return null;
  }
  const body = await res.json();
  await setSession(body.accessToken, body.refreshToken);
  return body.accessToken;
}
