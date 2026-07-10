// POST /api/finch/aviary-deny {user_code} — explicitly reject one pending
// Aviary service manifest. The browser cannot supply the approver or audit text.
import { errorResponse, hubProxy, requireAdmin } from "@/lib/hub";

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

    return await hubProxy("/api/aviary/device/deny", {
      method: "POST",
      body: JSON.stringify({
        user_code: userCode,
        approver: ctx.userId,
        reason: "Denied from the Finch Aviary authorization page",
      }),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
