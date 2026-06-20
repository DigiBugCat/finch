// POST /api/finch/cli-describe {userCode} — return the pending device code's
// INITIATOR context (where the `finch login` was started) so the approver can
// confirm it's their own device before approving. Admin-only; no secrets.
import { requireAdmin, hubProxy, errorResponse } from "@/lib/hub";

export async function POST(req: Request) {
  try {
    await requireAdmin();
    const body = await req.json().catch(() => ({}));
    const userCode = String(body.userCode || "").trim();
    if (!userCode) {
      return Response.json({ error: "userCode required" }, { status: 400 });
    }
    const res = await hubProxy("/api/cli-describe", {
      method: "POST",
      body: JSON.stringify({ userCode }),
    });
    return new Response(await res.text(), {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
