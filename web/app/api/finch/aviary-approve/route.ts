// POST /api/finch/aviary-approve {user_code,public_approved} — approve one
// exact Aviary service manifest. The approver identity comes only from Clerk;
// the client cannot choose or spoof the audit actor.
import { errorResponse, hubFetchAs, requireAdmin } from "@/lib/hub";
import {
  aviaryEnrollmentResponse,
  readAviaryEnrollmentRequest,
} from "../_aviary-enrollment";

export async function POST(req: Request) {
  try {
    const ctx = await requireAdmin();
    const { body, userCode } = await readAviaryEnrollmentRequest(req);

    const response = await hubFetchAs(ctx.tenant, "/api/aviary/device/approve", {
      method: "POST",
      body: JSON.stringify({
        user_code: userCode,
        approver: ctx.userId,
        // Only the literal boolean true opts into unauthenticated public access.
        public_approved: body.public_approved === true,
      }),
    });
    return await aviaryEnrollmentResponse(response, "approve");
  } catch (err) {
    return errorResponse(err);
  }
}
