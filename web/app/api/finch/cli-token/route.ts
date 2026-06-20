// POST /api/finch/cli-token — mint a long-lived CLI token for `finch login`.
// Admin-only; the token is a tenant credential, returned once.
import { mintCliToken, errorResponse } from "@/lib/hub";

export async function POST() {
  try {
    return Response.json(await mintCliToken());
  } catch (err) {
    return errorResponse(err);
  }
}
