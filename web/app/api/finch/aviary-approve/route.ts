// POST /api/finch/aviary-approve {user_code,public_approved} — approve one
// exact Aviary service manifest. The approver identity comes only from Clerk;
// the client cannot choose or spoof the audit actor.
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

    return await hubFetchAs(ctx.tenant,"/api/aviary/device/approve", {
      method: "POST",
      body: JSON.stringify({
        user_code: userCode,
        approver: ctx.userId,
        // Only the literal boolean true opts into unauthenticated public access.
        public_approved: body.public_approved === true,
      }),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
