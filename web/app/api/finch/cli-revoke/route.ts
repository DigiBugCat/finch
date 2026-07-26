// POST /api/finch/cli-revoke — invalidate every outstanding CLI token for the
// admin's tenant (bumps cliTokenEpoch on the hub). Admin-only.
import { errorResponse, HttpError, revokeCliTokens } from "@/lib/hub";
import { forwardHubResponse, readHubJsonObject } from "../_shared";
import { validRevokeResponse } from "../cli-contract";

export async function POST() {
  try {
    let res: Response;
    try {
      res = await revokeCliTokens();
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(502, "hub unavailable");
    }
    if (!res.ok) return forwardHubResponse(res);
    const out = await readHubJsonObject(res);
    if (!validRevokeResponse(out)) {
      throw new HttpError(502, "invalid response from hub");
    }
    return Response.json({ ok: true, epoch: out.epoch });
  } catch (err) {
    return errorResponse(err);
  }
}
