// POST /api/finch/cli-token — mint a long-lived CLI token for `finch login`.
// Admin-only; the token is a tenant credential, returned once.
import { errorResponse, HttpError, mintCliToken } from "@/lib/hub";
import { validMintResponse } from "../cli-contract";

export async function POST() {
  try {
    let out: unknown;
    try {
      out = await mintCliToken();
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(502, "invalid response from hub");
    }
    if (!validMintResponse(out)) {
      throw new HttpError(502, "invalid response from hub");
    }
    return Response.json(out);
  } catch (err) {
    return errorResponse(err);
  }
}
