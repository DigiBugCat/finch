// POST /api/finch/aviary-describe {user_code} — retrieve the exact, non-secret
// service manifest attached to an AviaryMCP device code. Admin-only: a leaked
// short code must not disclose machine details to an arbitrary signed-in user.
import { errorResponse, hubFetchAs, requireAdmin } from "@/lib/hub";
import {
  aviaryEnrollmentResponse,
  readAviaryEnrollmentRequest,
} from "../_aviary-enrollment";

export async function POST(req: Request) {
  try {
    const ctx = await requireAdmin();
    const { userCode } = await readAviaryEnrollmentRequest(req);

    const response = await hubFetchAs(ctx.tenant, "/api/aviary/device/describe", {
      method: "POST",
      body: JSON.stringify({ user_code: userCode }),
    });
    return await aviaryEnrollmentResponse(response, "describe");
  } catch (err) {
    return errorResponse(err);
  }
}
