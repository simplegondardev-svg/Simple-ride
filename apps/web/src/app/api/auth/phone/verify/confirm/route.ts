import { authCall } from "@/lib/bff";

export const POST = async (req: Request) => {
  const body = await req.json().catch(() => ({}));
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  const sanitizedReq = new Request(req.url, {
    method: "POST",
    headers: req.headers,
    body: JSON.stringify({ code }),
  });
  if ((req as any).sessionManager) {
    (sanitizedReq as any).sessionManager = (req as any).sessionManager;
  }
  return authCall(sanitizedReq, "phone/verify/confirm", { authed: true });
};
