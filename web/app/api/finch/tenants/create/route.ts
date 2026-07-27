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

    // The idempotency key is REQUIRED end to end: the hub derives the tenant
    // id from (user, key), which is what makes a retry after a failed index
    // write REPAIR the original workspace instead of bootstrapping a second
    // one. The browser holds the key across retries of the same attempt
    // (localStorage, per workspace name — see DashboardApp). A missing or
    // malformed key is rejected here, before any hub state is touched, with
    // the same 400 the hub would give: silently dropping it would quietly
    // downgrade the create to the non-idempotent behaviour this exists to
    // remove.
    const rawKey = body.idempotencyKey;
    if (typeof rawKey !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(rawKey)) {
      throw new HttpError(400, "idempotencyKey required — reload the dashboard and try again");
    }
    const idempotencyKey = rawKey;

    const identity = await syncIdentity(userId);
    const email = identity.primaryEmail ?? identity.emails[0];
    if (!email) throw new HttpError(403, "verify your email");
    const response = await userFetch(userId, "/api/tenant-create", {
      method: "POST",
      body: JSON.stringify({ name, email, emails: identity.emails, idempotencyKey }),
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
