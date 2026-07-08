// DELETE /api/finch/users/:id -> remove a member from the Clerk org.
// Admin-only. Requires an active org. `:id` is the Clerk user id.
//
// Talks to the Clerk backend admin client directly, so it enforces
// authorization itself (requireAdmin blocks members) and refuses to remove the
// last remaining admin/owner so the tenant is never left without an admin.
import { clerkClient } from "@clerk/nextjs/server";
import { errorResponse, HttpError, isClerkOrgAdmin, requireSharing } from "@/lib/hub";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { orgId } = await requireSharing();
    if (!orgId) {
      throw new HttpError(400, "an active organization is required");
    }
    const { id } = await params;

    const clerk = await clerkClient();

    // Guard: don't let the last admin/owner be removed from the org.
    const list = await clerk.organizations.getOrganizationMembershipList({
      organizationId: orgId,
      limit: 100,
    });
    const admins = list.data.filter((m) => isClerkOrgAdmin(m.role));
    const targetIsAdmin = admins.some((m) => m.publicUserData?.userId === id);
    if (targetIsAdmin && admins.length <= 1) {
      throw new HttpError(400, "can't remove the last admin");
    }

    await clerk.organizations.deleteOrganizationMembership({
      organizationId: orgId,
      userId: id,
    });
    return Response.json({ ok: true }, { status: 200 });
  } catch (err) {
    return errorResponse(err);
  }
}
