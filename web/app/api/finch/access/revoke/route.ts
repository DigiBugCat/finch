// POST /api/finch/access/revoke {id | ruleId} -> pull a user's service grant.
// Accepts either the access-request row id or a single-destination ACL rule id. Removal is
// SURGICAL (DO removeUserGrant): only the {user, service} destination comes
// out, so a multi-dst rule keeps its other services. If a broader rule
// (all/tag/group/locked) still covers the user we FAIL with 409 rather than
// report a revoke that changed nothing at the door.
import {
  errorResponse,
  HttpError,
  hubFetchAs,
  requireSharing,
} from "@/lib/hub";
import { readJsonObject } from "@/lib/request-body";
import { readHubJsonObject, requiredString } from "../_contracts";

export async function POST(req: Request) {
  try {
    const { tenant, userId, memberId, email: actorEmail } = await requireSharing();
    const body = await readJsonObject(req);
    const id = body.id === undefined ? "" : requiredString(body, "id", "valid id or ruleId required");
    const ruleId = body.ruleId === undefined
      ? ""
      : requiredString(body, "ruleId", "valid id or ruleId required");
    if (!id && !ruleId) throw new HttpError(400, "id or ruleId required");
    if (id && ruleId) throw new HttpError(400, "provide id or ruleId, not both");

    const response = await hubFetchAs(tenant, "/api/access/revoke", {
      method: "POST",
      body: JSON.stringify({
        ...(id ? { id } : { ruleId }),
        actor: { clerkUserId: userId, memberId, label: actorEmail },
      }),
    });
    const out = await readHubJsonObject(response);
    if (!response.ok) return Response.json(out, { status: response.status });
    if (
      out.ok !== true ||
      typeof out.removed !== "boolean" ||
      typeof out.denied !== "number" ||
      !Number.isSafeInteger(out.denied) ||
      out.denied < 0
    ) {
      throw new HttpError(502, "invalid response from hub");
    }
    return Response.json(out);
  } catch (err) {
    return errorResponse(err);
  }
}
