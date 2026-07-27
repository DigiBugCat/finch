import { errorResponse, requireSharing, hubFetchAs } from "@/lib/hub";
import { readHubJsonObject } from "../../../_shared";
import { memberId } from "../../_input";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireSharing();
    const { id: rawId } = await params;
    const id = memberId(rawId);
    const response = await hubFetchAs(ctx.tenant, "/api/members/state", {
      method: "POST",
      body: JSON.stringify({
        memberId: id,
        state: "active",
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
