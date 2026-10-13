import { NextResponse } from "next/server";
import { API_URL, getTokens, setSession } from "@/lib/session";

/**
 * Forward an auth call to the API. On success, store the returned tokens in
 * httpOnly cookies and hand the browser everything except the tokens.
 */
export async function authCall(req: Request, path: string, opts: { authed?: boolean } = {}) {
  const body = await req.json().catch(() => ({}));
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": req.headers.get("user-agent") ?? "",
  };
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
  await setSession(data.accessToken, data.refreshToken);
  const { accessToken: _a, refreshToken: _r, ...rest } = data;
  return NextResponse.json(rest, { status: res.status });
}
