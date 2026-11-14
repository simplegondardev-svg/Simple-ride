import { authCall } from "@/lib/bff";

export const POST = (req: Request) => {
  // Strip any client-supplied body so the authenticated user's own phone is always verified
  const strippedReq = new Request(req.url, {
    method: "POST",
    headers: req.headers,
    body: JSON.stringify({}),
  });
  if ((req as any).sessionManager) {
    (strippedReq as any).sessionManager = (req as any).sessionManager;
  }
  return authCall(strippedReq, "phone/verify/start", { authed: true });
};
