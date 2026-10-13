import { NextResponse, type NextRequest } from "next/server";

/** Send signed-out visitors of protected pages to /login. Role checks happen in the API. */
export function proxy(req: NextRequest) {
  const hasSession = req.cookies.has("sr_at") || req.cookies.has("sr_rt");
  if (!hasSession) {
    const url = new URL("/login", req.url);
    url.searchParams.set("next", req.nextUrl.pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = { matcher: ["/admin/:path*", "/ride/:path*"] };
