// POST /api/finch/cli-approve {userCode} — approve a `finch login` device code.
// Admin-only; mints the CLI token on the hub and stamps it onto the pending code.
// We also pass the approver's Clerk email so the box (and its tray app) can show
// WHO it's signed in as.
import { clerkClient } from "@clerk/nextjs/server";
import { errorResponse, HttpError, hubFetchAs, requireAdmin } from "@/lib/hub";
import { readJsonObject } from "@/lib/request-body";
import { readHubJsonObject, forwardHubResponse } from "../_shared";
import {
  MAX_CLI_REQUEST_BYTES,
  normalizeServerEmail,
  parseCliUserCode,
  parseOptionalClientEmail,
  validApproveResponse,
} from "../cli-contract";

export async function POST(req: Request) {
  try {
    // Reuse the identity requireAdmin already validated — no second auth() hop.
    const ctx = await requireAdmin();
    const body = await readJsonObject(req, MAX_CLI_REQUEST_BYTES);
    const userCode = parseCliUserCode(body.userCode);
    const clientEmail = parseOptionalClientEmail(body.email);

    // The approver's email, for the box's account label. Prefer the authoritative
    // server lookup, but fall back to the email the client sent (from useUser).
    // On staging the server lookup fails — ctx.userId is the forced DEFAULT_TENANT
    // id, not a real Clerk user — so the client value is what makes it work.
    let serverEmail = "";
    try {
      const user = await (await clerkClient()).users.getUser(ctx.userId);
      const primary = user.emailAddresses?.find(
        (e) => e.id === user.primaryEmailAddressId,
      )?.emailAddress;
      serverEmail = normalizeServerEmail(
        primary ||
          user.emailAddresses?.[0]?.emailAddress ||
          user.primaryEmailAddress?.emailAddress ||
          user.username,
      );
    } catch {
      // Expected on staging (synthetic tenant id) — the client email covers it.
    }
    const email = serverEmail || clientEmail;

    let res: Response;
    try {
      res = await hubFetchAs(ctx.tenant, "/api/device-approve", {
        method: "POST",
        body: JSON.stringify({ userCode, email }),
      });
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(502, "hub unavailable");
    }
    if (!res.ok) return forwardHubResponse(res);
    const out = await readHubJsonObject(res);
    if (!validApproveResponse(out)) {
      throw new HttpError(502, "invalid response from hub");
    }
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
