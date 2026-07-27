import { errorResponse, HttpError, requireSharing, hubFetchAs } from "@/lib/hub";
import { deliverApplicationInvite } from "@/lib/invitations";
import { readJsonObject } from "@/lib/request-body";
import { accessId, readHubJsonObject, validEmailContract } from "../_contracts";

export async function POST(req: Request) {
  try {
    const ctx = await requireSharing();
    const id = accessId(await readJsonObject(req));
    const res = await hubFetchAs(ctx.tenant, "/api/access/approve", {
      method: "POST",
      body: JSON.stringify({
        id,
        actor: {
          clerkUserId: ctx.userId,
          memberId: ctx.memberId,
          label: ctx.email,
        },
      }),
    });
    const out = await readHubJsonObject(res);
    if (!res.ok) return Response.json(out, { status: res.status });
    if (
      out.ok !== true ||
      (out.status !== "invited" && out.status !== "granted") ||
      !validEmailContract(out.email)
    ) {
      throw new HttpError(502, "invalid response from hub");
    }

    if (out.status === "invited") {
      const member = out.member;
      if (
        !member ||
        typeof member !== "object" ||
        !("email" in member) ||
        !validEmailContract(member.email)
      ) {
        throw new HttpError(502, "invalid response from hub");
      }
      out.delivery = await deliverApplicationInvite(member.email, new URL(req.url).origin);
    }
    return Response.json(out);
  } catch (err) {
    return errorResponse(err);
  }
}
