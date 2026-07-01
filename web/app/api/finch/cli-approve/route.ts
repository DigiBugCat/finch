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

    // The approver's email, for the box's account label. Prefer the authoritative
    // server lookup, but fall back to the email the client sent (from useUser).
    // On staging the server lookup fails — ctx.userId is the forced DEFAULT_TENANT
    // id, not a real Clerk user — so the client value is what makes it work.
    const clientEmail = String(body.email || "").slice(0, 200);
    let serverEmail = "";
    try {
      const user = await (await clerkClient()).users.getUser(ctx.userId);
      const primary = user.emailAddresses?.find(
        (e) => e.id === user.primaryEmailAddressId,
      )?.emailAddress;
      serverEmail =
        primary ||
        user.emailAddresses?.[0]?.emailAddress ||
        user.primaryEmailAddress?.emailAddress ||
        user.username ||
        "";
    } catch {
      // Expected on staging (synthetic tenant id) — the client email covers it.
    }
    const email = serverEmail || clientEmail;

    return await hubProxy("/api/device-approve", {
      method: "POST",
      body: JSON.stringify({ userCode, email }),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
