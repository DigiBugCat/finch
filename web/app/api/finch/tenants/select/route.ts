import { auth } from "@clerk/nextjs/server";
import { errorResponse, HttpError, hubFetchAs } from "@/lib/hub";
import { validTenantId, writeActiveTenant } from "@/lib/tenant-cookie";
import { readHubJsonObject, readJsonObject } from "../../_shared";

const MEMBER_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isActiveMemberContext(value: Record<string, unknown>, tenantId: string): boolean {
  const member = value.member;
  const tenantMeta = value.tenantMeta;
  return (
    isObject(member) &&
    typeof member.id === "string" &&
    MEMBER_ID_RE.test(member.id) &&
    (member.role === "owner" || member.role === "admin" || member.role === "member") &&
    member.state === "active" &&
    typeof member.email === "string" &&
    member.email.length > 0 &&
    member.email.length <= 320 &&
    isObject(tenantMeta) &&
    tenantMeta.id === tenantId
  );
}

export async function POST(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId) throw new HttpError(401, "unauthenticated");
    const body = await readJsonObject(req);
    if (!validTenantId(body.tenantId)) throw new HttpError(400, "invalid tenant id");

    const response = await hubFetchAs(body.tenantId, "/api/member-context", {
      method: "POST",
      body: JSON.stringify({ clerkUserId: userId }),
    });
    if (!response.ok) {
      if ([401, 403, 404].includes(response.status)) {
        throw new HttpError(403, "not an active member");
      }
      throw new HttpError(response.status, "could not verify workspace membership");
    }
    const out = await readHubJsonObject(response);
    if (!isActiveMemberContext(out, body.tenantId)) {
      throw new HttpError(403, "not an active member");
    }

    await writeActiveTenant(body.tenantId);
    return Response.json({ ok: true, tenantId: body.tenantId });
  } catch (error) {
    return errorResponse(error);
  }
}
