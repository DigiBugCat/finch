// DELETE /api/finch/users/:id -> remove a member from the Clerk org.
// Best-effort: 400 when there's no active org. `:id` is the Clerk user id.
import { auth, clerkClient } from "@clerk/nextjs/server";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { userId, orgId } = await auth();
    if (!userId) {
      return Response.json({ error: "unauthenticated" }, { status: 401 });
    }
    if (!orgId) {
      return Response.json(
        { error: "an active organization is required" },
        { status: 400 },
      );
    }
    const { id } = await params;

    const clerk = await clerkClient();
    await clerk.organizations.deleteOrganizationMembership({
      organizationId: orgId,
      userId: id,
    });
    return Response.json({ ok: true }, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "remove failed";
    return Response.json({ error: message }, { status: 400 });
  }
}
