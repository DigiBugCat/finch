import { errorResponse, requireSharing, hubFetchAs } from "@/lib/hub";
import { readJsonObject } from "@/lib/request-body";
import { readHubJsonObject } from "../../../_shared";
import { memberId, memberRole } from "../../_input";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireSharing();
    const { id: rawId } = await params;
    const id = memberId(rawId);
    const body = await readJsonObject(req, 1_024);
    const role = memberRole(body.role);
    const response = await hubFetchAs(ctx.tenant, "/api/members/role", {
      method: "POST",
      body: JSON.stringify({
        memberId: id,
        role,
        actor: {
          clerkUserId: ctx.userId,
          memberId: ctx.memberId,
          label: ctx.email,
        },
      }),
    });
    const out = await readHubJsonObject(response);
    return Response.json(out, { status: response.status });
  } catch (error) {
    return errorResponse(error);
  }
}
