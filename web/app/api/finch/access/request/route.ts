// POST /api/finch/access/request {email,service} -> hub POST /api/access/request
// Creates (or returns the existing) pending access-request row in the tenant
// DO. The DO is idempotent for a live pending/invited email+service pair.
import {
  errorResponse,
  hubFetchAs,
  requireSharing,
} from "@/lib/hub";
import { readJsonObject } from "@/lib/request-body";
import {
  accessEmail,
  accessRequestResult,
  readHubJsonObject,
  requiredString,
} from "../_contracts";

export async function POST(req: Request) {
  try {
    const { tenant, userId, email: actorEmail } = await requireSharing();
    const body = await readJsonObject(req);
    const email = accessEmail(body);
    const service = requiredString(body, "service", "valid email and service required");

    const upstream = await hubFetchAs(tenant, "/api/access/request", {
      method: "POST",
      body: JSON.stringify({
        email,
        service,
        requestedBy: actorEmail,
        requestedByUserId: userId,
      }),
    });
    const out = await readHubJsonObject(upstream);
    if (!upstream.ok) return Response.json(out, { status: upstream.status });
    return Response.json(accessRequestResult(out));
  } catch (err) {
    return errorResponse(err);
  }
}
