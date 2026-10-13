import { API_URL } from "@/lib/session";

export async function POST(req: Request) {
  const res = await fetch(`${API_URL}/api/v1/auth/otp/request`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": req.headers.get("x-forwarded-for") ?? "" },
    body: await req.text(),
  });
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
}
