// POST /api/finch/cli-approve {userCode} — approve a `finch login` device code.
// Admin-only; mints the CLI token on the hub and stamps it onto the pending code.
// We also pass the approver's Clerk email so the box (and its tray app) can show
// WHO it's signed in as.
import { auth, clerkClient } from "@clerk/nextjs/server";
import { requireAdmin, hubProxy, errorResponse } from "@/lib/hub";

export async function POST(req: Request) {
  try {
    await requireAdmin();
    const body = await req.json().catch(() => ({}));
    const userCode = String(body.userCode || "").trim();
    if (!userCode) {
      return Response.json({ error: "userCode required" }, { status: 400 });
    }

    // Best-effort: the approver's email, for the box's account label.
    let email = "";
    try {
      const { userId } = await auth();
      if (userId) {
        const user = await (await clerkClient()).users.getUser(userId);
        email = user.primaryEmailAddress?.emailAddress ?? "";
      }
    } catch {
      /* email is a nicety — approval proceeds without it */
    }

    return await hubProxy("/api/device-approve", {
      method: "POST",
      body: JSON.stringify({ userCode, email }),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
