// POST /api/finch/cli-describe {userCode} — return the pending device code's
// INITIATOR context (where the `finch login` was started) so the approver can
// confirm it's their own device before approving. Admin-only; no secrets.
import { errorResponse, HttpError, hubFetchAs, requireAdmin } from "@/lib/hub";
import { readJsonObject } from "@/lib/request-body";
import { forwardHubResponse, readHubJsonObject } from "../_shared";
import {
  cleanDescribeResponse,
  MAX_CLI_REQUEST_BYTES,
  parseCliUserCode,
} from "../cli-contract";

export async function POST(req: Request) {
  try {
    const ctx = await requireAdmin();
    const body = await readJsonObject(req, MAX_CLI_REQUEST_BYTES);
    const userCode = parseCliUserCode(body.userCode);
    let res: Response;
    try {
      res = await hubFetchAs(ctx.tenant, "/api/cli-describe", {
        method: "POST",
        body: JSON.stringify({ userCode }),
      });
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(502, "hub unavailable");
    }
    if (!res.ok) return forwardHubResponse(res);
    const out = cleanDescribeResponse(await readHubJsonObject(res));
    if (!out) throw new HttpError(502, "invalid response from hub");
    return Response.json(out);
  } catch (err) {
    return errorResponse(err);
  }
}
