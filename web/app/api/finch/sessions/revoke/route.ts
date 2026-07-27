// POST /api/finch/sessions/revoke — sign out every live login-wall web session
// for the admin's tenant (bumps the tenant's sessionEpoch on the hub so all
// outstanding finch_session cookies stop validating). Admin-only. Same-origin
// is enforced by middleware.ts's CSRF guard for /api/finch/*.
import { revokeSessions, errorResponse, HttpError } from "@/lib/hub";
import { relayHubJson } from "@/app/api/finch/keys/route-contract";

function validSessionRevokeResponse(value: Record<string, unknown>): boolean {
  return (
    value.ok === true &&
    Number.isSafeInteger(value.epoch) &&
    (value.epoch as number) >= 0
  );
}

export async function POST() {
  try {
    let res: Response;
    try {
      res = await revokeSessions();
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(502, "hub unavailable");
    }
    return await relayHubJson(res, validSessionRevokeResponse);
  } catch (err) {
    return errorResponse(err);
  }
}
