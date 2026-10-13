import { NextResponse } from "next/server";
import { API_URL, clearSession, getTokens } from "@/lib/session";

export async function POST() {
  const { refreshToken } = await getTokens();
  if (refreshToken) {
    await fetch(`${API_URL}/api/v1/auth/logout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    }).catch(() => {});
  }
  await clearSession();
  return NextResponse.json({ ok: true });
}
