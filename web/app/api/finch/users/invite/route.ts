// POST /api/finch/users/invite {email,role} -> Clerk org invitation.
// Admin-only. Users live in Clerk, not the hub — so this talks to Clerk
// directly. Requires an active org (you can't invite a teammate to a
// personal/no-org tenant). requireAdmin() blocks members from inviting outsiders.
import { clerkClient } from "@clerk/nextjs/server";
import { errorResponse, HttpError, requireAdmin, toClerkOrgRole } from "@/lib/hub";

export async function POST(req: Request) {
  try {
    const { orgId, userId } = await requireAdmin();
    if (!orgId) {
      throw new HttpError(
        400,
        "an active organization is required to invite teammates",
      );
    }
    const body = (await req.json().catch(() => ({}))) as {
      email?: string;
      role?: string;
    };
    const email = (body?.email ?? "").trim();
    if (!email) {
      throw new HttpError(400, "email required");
    }

    const clerk = await clerkClient();
    const invitation =
      await clerk.organizations.createOrganizationInvitation({
        organizationId: orgId,
        emailAddress: email,
        role: toClerkOrgRole(body?.role),
        inviterUserId: userId,
      });

    return Response.json({ ok: true, id: invitation.id }, { status: 200 });
  } catch (err) {
    return errorResponse(err);
  }
}
