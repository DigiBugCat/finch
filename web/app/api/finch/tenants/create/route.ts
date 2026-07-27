import { auth } from "@clerk/nextjs/server";
import { errorResponse, HttpError, userFetch } from "@/lib/hub";
import { syncIdentity } from "@/lib/identity";
import { validTenantId, writeActiveTenant } from "@/lib/tenant-cookie";
import { forwardHubResponse, readHubJsonObject, readJsonObject } from "../../_shared";

const MAX_NAME_CHARACTERS = 64;

export async function POST(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId) throw new HttpError(401, "unauthenticated");

    const body = await readJsonObject(req);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (
      !name ||
      [...name].length > MAX_NAME_CHARACTERS ||
      /[\u0000-\u001f\u007f]/.test(name)
    ) {
      throw new HttpError(400, "name must be 1-64 printable characters");
    }

    const identity = await syncIdentity(userId);
    const email = identity.primaryEmail ?? identity.emails[0];
    if (!email) throw new HttpError(403, "verify your email");
    const response = await userFetch(userId, "/api/tenant-create", {
      method: "POST",
      body: JSON.stringify({ name, email, emails: identity.emails }),
    });
    if (!response.ok) return forwardHubResponse(response);

    const out = await readHubJsonObject(response);
    if (!validTenantId(out.tenantId)) throw new HttpError(502, "invalid response from hub");
    await writeActiveTenant(out.tenantId);
    return Response.json({ ok: true, tenantId: out.tenantId });
  } catch (error) {
    return errorResponse(error);
  }
}
