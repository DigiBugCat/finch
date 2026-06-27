// POST /api/finch/sessions/revoke — sign out every live login-wall web session
// for the admin's tenant (bumps the tenant's sessionEpoch on the hub so all
// outstanding finch_session cookies stop validating). Admin-only. Same-origin
// is enforced by middleware.ts's CSRF guard for /api/finch/*.
import { revokeSessions, errorResponse } from "@/lib/hub";

export async function POST() {
  try {
    const res = await revokeSessions();
    return new Response(await res.text(), {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
