import { auth } from "@clerk/nextjs/server";
import { errorResponse, HttpError, userFetch } from "@/lib/hub";
import { syncIdentity } from "@/lib/identity";
import { readActiveTenant } from "@/lib/tenant-cookie";

export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) throw new HttpError(401, "unauthenticated");
    let identity;
    let response;
    try {
      identity = await syncIdentity(userId, { includeOrgs: true });
      response = await userFetch(userId, "/api/user/sync", {
        method: "POST",
        body: JSON.stringify(identity),
      });
    } catch (error) {
      console.error("finch bridge: tenant bootstrap failed", error);
      return Response.json({ error: "bridge unavailable" }, { status: 502 });
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return Response.json(body, { status: 502 });
    return Response.json({
      ...body,
      activeTenant: await readActiveTenant() ?? userId,
      ...(identity.emails.length ? {} : { needsVerifiedEmail: true }),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
