// POST /api/finch/users/:id/role {role} -> update a Clerk org membership's role.
// Best-effort: 400 when there's no active org. `:id` is the Clerk user id.
import { auth, clerkClient } from "@clerk/nextjs/server";

function clerkRole(role: string | undefined): "org:admin" | "org:member" {
  return role === "Admin" || role === "org:admin" ? "org:admin" : "org:member";
}

export async function POST(
  req: Request,
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
    const body = await req.json().catch(() => ({}));

    const clerk = await clerkClient();
    await clerk.organizations.updateOrganizationMembership({
      organizationId: orgId,
      userId: id,
      role: clerkRole(body?.role),
    });
    return Response.json({ ok: true }, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "update failed";
    return Response.json({ error: message }, { status: 400 });
  }
}
