// POST /api/finch/aviary-describe {user_code} — retrieve the exact, non-secret
// service manifest attached to an AviaryMCP device code. Admin-only: a leaked
// short code must not disclose machine details to an arbitrary signed-in user.
import { errorResponse, hubFetchAs, requireAdmin } from "@/lib/hub";

const MAX_USER_CODE_LENGTH = 32;

export async function POST(req: Request) {
  try {
    const ctx = await requireAdmin();
    const body = await req.json().catch(() => ({}));
    const userCode = String(body.user_code || body.userCode || "")
      .trim()
      .toUpperCase();
    if (!userCode || userCode.length > MAX_USER_CODE_LENGTH) {
      return Response.json({ error: "a valid user_code is required" }, { status: 400 });
    }

    return await hubFetchAs(ctx.tenant,"/api/aviary/device/describe", {
      method: "POST",
      body: JSON.stringify({ user_code: userCode }),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
