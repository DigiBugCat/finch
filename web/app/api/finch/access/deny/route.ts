// POST /api/finch/access/deny {id} -> mark the request row denied.
// Pure DO transition — deny NEVER touches Clerk (an already-sent invitation
// stands; the member just gets no service grant).
import { errorResponse, HttpError, hubFetchAs, requireSharing } from "@/lib/hub";
import { readJsonObject } from "@/lib/request-body";
import { accessId, readHubJsonObject } from "../_contracts";

export async function POST(req: Request) {
  try {
    const { tenant, userId, memberId, email: actorEmail } = await requireSharing();
    const body = await readJsonObject(req);
    const id = accessId(body);

    const response = await hubFetchAs(tenant, "/api/access/deny", {
      method: "POST",
      body: JSON.stringify({
        id,
        actor: {
          clerkUserId: userId,
          memberId,
          label: actorEmail,
        },
      }),
    });
    const out = await readHubJsonObject(response);
    if (!response.ok) return Response.json(out, { status: response.status });
    if (out.ok !== true || out.status !== "denied") {
      throw new HttpError(502, "invalid response from hub");
    }
    return Response.json(out);
  } catch (err) {
    return errorResponse(err);
  }
}
