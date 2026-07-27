// POST /api/finch/aviary-deny {user_code} — explicitly reject one pending
// Aviary service manifest. The browser cannot supply the approver or audit text.
import { errorResponse, hubFetchAs, requireAdmin } from "@/lib/hub";
import {
  aviaryEnrollmentResponse,
  readAviaryEnrollmentRequest,
} from "../_aviary-enrollment";

export async function POST(req: Request) {
  try {
    const ctx = await requireAdmin();
    const { userCode } = await readAviaryEnrollmentRequest(req);

    const response = await hubFetchAs(ctx.tenant, "/api/aviary/device/deny", {
      method: "POST",
      body: JSON.stringify({
        user_code: userCode,
        approver: ctx.userId,
        reason: "Denied from the Finch Aviary authorization page",
      }),
    });
    return await aviaryEnrollmentResponse(response, "deny");
  } catch (err) {
    return errorResponse(err);
  }
}
