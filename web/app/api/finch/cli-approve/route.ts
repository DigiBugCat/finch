// POST /api/finch/cli-approve {userCode} — approve a `finch login` device code.
// Admin-only; mints the CLI token on the hub and stamps it onto the pending code.
import { requireAdmin, hubProxy, errorResponse } from "@/lib/hub";

export async function POST(req: Request) {
  try {
    await requireAdmin();
    const body = await req.json().catch(() => ({}));
    const userCode = String(body.userCode || "").trim();
    if (!userCode) {
      return Response.json({ error: "userCode required" }, { status: 400 });
    }
    return await hubProxy("/api/device-approve", {
      method: "POST",
      body: JSON.stringify({ userCode }),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
