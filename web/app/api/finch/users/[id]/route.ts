import { errorResponse, HttpError, requireSharing, hubFetchAs } from "@/lib/hub";
import { readJsonObject } from "@/lib/request-body";
import { readHubJsonObject } from "../../_shared";
import { memberId } from "../_input";

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireSharing();
    const { id: rawId } = await params;
    const id = memberId(rawId);
    const body = await readJsonObject(req, 1_024);
    if (body.revokeGrants !== undefined && typeof body.revokeGrants !== "boolean") {
      throw new HttpError(400, "revokeGrants must be a boolean");
    }
    const response = await hubFetchAs(ctx.tenant, "/api/members/remove", {
      method: "POST",
      body: JSON.stringify({
        memberId: id,
        revokeGrants: body.revokeGrants === true,
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
