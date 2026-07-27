import { deliverApplicationInvite } from "@/lib/invitations";
import { errorResponse, HttpError, requireSharing, hubFetchAs } from "@/lib/hub";
import { readJsonObject } from "@/lib/request-body";
import { readHubJsonObject } from "../../_shared";
import { invitationEmail, memberRole } from "../_input";

export async function POST(req: Request) {
  try {
    const ctx = await requireSharing();
    const body = await readJsonObject(req, 4_096);
    const email = invitationEmail(body.email);
    const role = memberRole(body.role);
    if (role === "owner") throw new HttpError(400, "invalid role");

    const response = await hubFetchAs(ctx.tenant, "/api/members/invite", {
      method: "POST",
      body: JSON.stringify({
        email,
        role,
        actor: {
          clerkUserId: ctx.userId,
          memberId: ctx.memberId,
          label: ctx.email,
        },
      }),
    });
    const out = await readHubJsonObject(response);
    if (!response.ok) return Response.json(out, { status: response.status });
    if (!out.member || typeof out.member !== "object" || Array.isArray(out.member)) {
      throw new HttpError(502, "invalid response from hub");
    }
    const delivery = await deliverApplicationInvite(email, new URL(req.url).origin);
    return Response.json({ ok: true, member: out.member, delivery });
  } catch (error) {
    return errorResponse(error);
  }
}
