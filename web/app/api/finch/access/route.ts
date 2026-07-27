// GET /api/finch/access -> hub GET /api/access (the tenant DO's listAccess:
// every access-request row plus the user→service ACL grants). Sharing-gated
// like the rest of the access surface.
import { errorResponse, hubFetchAs, requireSharing } from "@/lib/hub";
import { accessLens, readHubJsonObject } from "./_contracts";

export async function GET() {
  try {
    const { tenant } = await requireSharing();
    const upstream = await hubFetchAs(tenant, "/api/access", { method: "GET" });
    const out = await readHubJsonObject(upstream);
    if (!upstream.ok) return Response.json(out, { status: upstream.status });
    return Response.json(accessLens(out));
  } catch (err) {
    return errorResponse(err);
  }
}
