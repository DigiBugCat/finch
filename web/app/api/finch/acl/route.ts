// POST /api/finch/acl {src,dst} -> hub POST /api/acl
// Managing access is a paid "sharing" capability — requireSharing gates on the
// entitlement, not just admin. Validate/canonicalize before durable state sees it.
import { errorResponse, hubFetchAs, HttpError, requireSharing } from "@/lib/hub";
import { readJsonObject } from "@/lib/request-body";
import { aclPayload, readHubJsonObject } from "../access/_contracts";

export async function POST(req: Request) {
  try {
    const { tenant } = await requireSharing();
    const body = aclPayload(await readJsonObject(req));
    const upstream = await hubFetchAs(tenant, "/api/acl", {
      method: "POST",
      body: JSON.stringify(body),
    });
    const out = await readHubJsonObject(upstream);
    if (upstream.ok && (typeof out.id !== "string" || !out.id)) {
      throw new HttpError(502, "invalid response from hub");
    }
    return Response.json(out, { status: upstream.status });
  } catch (err) {
    return errorResponse(err);
  }
}
