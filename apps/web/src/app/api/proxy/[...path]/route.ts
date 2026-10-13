import { API_URL, getTokens, refresh } from "@/lib/session";

/**
 * Backend-for-frontend: forwards /api/proxy/<path> to the API's /api/v1/<path>
 * with the session's bearer token, refreshing once on expiry.
 */
async function forward(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const url = new URL(req.url);
  const target = `${API_URL}/api/v1/${path.map(encodeURIComponent).join("/")}${url.search}`;
  const body = ["GET", "HEAD"].includes(req.method) ? undefined : await req.text();

  const send = (token?: string) =>
    fetch(target, {
      method: req.method,
      headers: {
        "content-type": "application/json",
        ...(token && { authorization: `Bearer ${token}` }),
      },
      body,
    });

  let { accessToken } = await getTokens();
  if (!accessToken) accessToken = (await refresh()) ?? undefined;
  let res = await send(accessToken);
  if (res.status === 401 && accessToken) {
    const next = await refresh();
    if (next) res = await send(next);
  }
  return new Response(res.status === 204 ? null : res.body, {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
  });
}

export { forward as GET, forward as POST, forward as PUT, forward as PATCH, forward as DELETE };
