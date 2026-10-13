import { NextResponse } from "next/server";
import { API_URL, setSession } from "@/lib/session";

export async function POST(req: Request) {
  const body = await req.json();
  const res = await fetch(`${API_URL}/api/v1/auth/otp/verify`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": req.headers.get("user-agent") ?? "" },
    body: JSON.stringify({ ...body, platform: "web" }),
  });
  const data = await res.json();
  if (!res.ok) return NextResponse.json(data, { status: res.status });
  await setSession(data.accessToken, data.refreshToken);
  return NextResponse.json({ user: data.user, isNewUser: data.isNewUser });
}
