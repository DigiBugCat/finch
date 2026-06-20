// POST /api/finch/cli-revoke — invalidate every outstanding CLI token for the
// admin's tenant (bumps cliTokenEpoch on the hub). Admin-only.
import { revokeCliTokens, errorResponse } from "@/lib/hub";

export async function POST() {
  try {
    const res = await revokeCliTokens();
    return new Response(await res.text(), {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
