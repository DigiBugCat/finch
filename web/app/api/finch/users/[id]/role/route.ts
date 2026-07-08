// POST /api/finch/users/:id/role {role} -> update a Clerk org membership's role.
// Admin-only. Requires an active org. `:id` is the Clerk user id.
//
// This route talks to the Clerk backend admin client directly (users live in
// Clerk, not the hub), so it must enforce authorization itself — requireAdmin()
// blocks members from self-promoting. It also refuses to demote the last
// remaining admin/owner so a tenant can never be left with no admin.
import { clerkClient } from "@clerk/nextjs/server";
import {
  errorResponse,
  HttpError,
  isClerkOrgAdmin,
  requireSharing,
  toClerkOrgRole,
} from "@/lib/hub";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { orgId } = await requireSharing();
    if (!orgId) {
      throw new HttpError(400, "an active organization is required");
    }
    const { id } = await params;
    const body = (await req.json().catch(() => ({}))) as { role?: string };
    const nextRole = toClerkOrgRole(body?.role);

    const clerk = await clerkClient();

    // Guard: don't let the last admin/owner be demoted to member.
    if (nextRole === "org:member") {
      const list = await clerk.organizations.getOrganizationMembershipList({
        organizationId: orgId,
        limit: 100,
      });
      const admins = list.data.filter((m) => isClerkOrgAdmin(m.role));
      const targetIsAdmin = admins.some((m) => m.publicUserData?.userId === id);
      if (targetIsAdmin && admins.length <= 1) {
        throw new HttpError(400, "can't demote the last admin");
      }
    }

    await clerk.organizations.updateOrganizationMembership({
      organizationId: orgId,
      userId: id,
      role: nextRole,
    });
    return Response.json({ ok: true }, { status: 200 });
  } catch (err) {
    return errorResponse(err);
  }
}
