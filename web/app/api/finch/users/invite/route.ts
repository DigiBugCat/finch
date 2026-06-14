// POST /api/finch/users/invite {email,role} -> Clerk org invitation.
// Users live in Clerk, not the hub — so this talks to Clerk directly. Requires
// an active org (you can't invite a teammate to a personal/no-org tenant).
import { auth, clerkClient } from "@clerk/nextjs/server";

function clerkRole(role: string | undefined): "org:admin" | "org:member" {
  return role === "Admin" || role === "org:admin" ? "org:admin" : "org:member";
}

export async function POST(req: Request) {
  try {
    const { userId, orgId } = await auth();
    if (!userId) {
      return Response.json({ error: "unauthenticated" }, { status: 401 });
    }
    if (!orgId) {
      return Response.json(
        { error: "an active organization is required to invite teammates" },
        { status: 400 },
      );
    }
    const body = await req.json().catch(() => ({}));
    const email = (body?.email ?? "").trim();
    if (!email) {
      return Response.json({ error: "email required" }, { status: 400 });
    }

    const clerk = await clerkClient();
    const invitation =
      await clerk.organizations.createOrganizationInvitation({
        organizationId: orgId,
        emailAddress: email,
        role: clerkRole(body?.role),
        inviterUserId: userId,
      });

    return Response.json({ ok: true, id: invitation.id }, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "invite failed";
    return Response.json({ error: message }, { status: 400 });
  }
}
