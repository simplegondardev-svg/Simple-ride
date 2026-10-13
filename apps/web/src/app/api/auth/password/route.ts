import { authCall } from "@/lib/bff";

export const POST = (req: Request) => authCall(req, "password/change", { authed: true });
