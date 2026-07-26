import { auth } from "@clerk/nextjs/server";
import { errorResponse, HttpError, userFetch } from "@/lib/hub";
import { serializeSyncedIdentity, syncIdentity } from "@/lib/identity";
import { clearActiveTenant, readActiveTenant } from "@/lib/tenant-cookie";
import { readHubJsonObject, relayValidatedHubJson } from "../_shared";

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
        body: serializeSyncedIdentity(identity),
      });
    } catch (error) {
      console.error("finch bridge: tenant bootstrap failed", error);
      return Response.json({ error: "bridge unavailable" }, { status: 502 });
    }
    if (!response.ok) return relayValidatedHubJson(response, () => false);
    const body = await readHubJsonObject(response);
    if (!Array.isArray(body.tenants) || !Array.isArray(body.claimable)) {
      throw new HttpError(502, "invalid response from hub");
    }
    const selected = await readActiveTenant();
    const selectedIsActive = selected === userId || body.tenants.some((row) => (
      row !== null &&
      typeof row === "object" &&
      !Array.isArray(row) &&
      row.tenantId === selected &&
      row.state === "active"
    ));
    if (selected && !selectedIsActive) await clearActiveTenant();
    return Response.json({
      ...body,
      activeTenant: selected && selectedIsActive ? selected : userId,
      ...(identity.emails.length ? {} : { needsVerifiedEmail: true }),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
