// POST /api/finch/cli-approve {userCode} — approve a `finch login` device code.
// Admin-only; mints the CLI token on the hub and stamps it onto the pending code.
// We also pass the approver's Clerk email so the box (and its tray app) can show
// WHO it's signed in as.
import { clerkClient } from "@clerk/nextjs/server";
import { requireAdmin, hubProxy, errorResponse } from "@/lib/hub";

export async function POST(req: Request) {
  try {
    // Reuse the identity requireAdmin already validated — no second auth() hop.
    const ctx = await requireAdmin();
    const body = await req.json().catch(() => ({}));
    const userCode = String(body.userCode || "").trim();
    if (!userCode) {
      return Response.json({ error: "userCode required" }, { status: 400 });
    }

    // Best-effort: the approver's email/handle, for the box's account label.
    // Mirror the fallback chain the working state route uses — primaryEmailAddress
    // alone comes back empty for org/SSO-provisioned users.
    let email = "";
    try {
      const user = await (await clerkClient()).users.getUser(ctx.userId);
      const primary = user.emailAddresses?.find(
        (e) => e.id === user.primaryEmailAddressId,
      )?.emailAddress;
      email =
        primary ||
        user.emailAddresses?.[0]?.emailAddress ||
        user.primaryEmailAddress?.emailAddress ||
        user.username ||
        "";
    } catch (err) {
      // email is a nicety — approval proceeds without it — but log so an empty
      // account label is observable rather than silently dropped.
      console.warn("cli-approve: could not resolve approver email", err);
    }

    return await hubProxy("/api/device-approve", {
      method: "POST",
      body: JSON.stringify({ userCode, email }),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
