import { NextResponse } from "next/server";
import {
  API_URL,
  clearSession as defaultClearSession,
  getTokens as defaultGetTokens,
  setSession as defaultSetSession,
  type SessionManager,
} from "./session";

export { clearSession } from "./session";

export interface AuthCallOptions {
  authed?: boolean;
  clearSessionOnSuccess?: boolean;
  session?: SessionManager;
}

/**
 * Forward an auth call to the API.
 * - On success, if tokens are present, stores them in httpOnly cookies.
 * - If clearSessionOnSuccess is true and the backend call succeeds, clears session cookies.
 * - Never modifies cookies on non-token responses unless clearSessionOnSuccess is specified.
 * - Strips accessToken and refreshToken from the response before returning to the browser.
 */
export async function authCall(req: Request, path: string, opts: AuthCallOptions = {}) {
  const body = await req.json().catch(() => ({}));
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": req.headers.get("user-agent") ?? "",
  };

  const session = opts.session ?? (req as any).sessionManager;
  const getTokens = session?.getTokens ?? defaultGetTokens;
  const setSession = session?.setSession ?? defaultSetSession;
  const clearSession = session?.clearSession ?? defaultClearSession;

  if (opts.authed) {
    const { accessToken } = await getTokens();
    if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  }
  const res = await fetch(`${API_URL}/api/v1/auth/${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...body, platform: "web" }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return NextResponse.json(data, { status: res.status });

  if (opts.clearSessionOnSuccess) {
    await clearSession();
  } else if (
    typeof data?.accessToken === "string" &&
    data.accessToken.trim().length > 0 &&
    typeof data?.refreshToken === "string" &&
    data.refreshToken.trim().length > 0
  ) {
    await setSession(data.accessToken, data.refreshToken);
  }

  const { accessToken: _a, refreshToken: _r, ...rest } = data ?? {};
  return NextResponse.json(rest, { status: res.status });
}
