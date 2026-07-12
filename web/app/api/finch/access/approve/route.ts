// POST /api/finch/access/approve {id} -> grant or invite.
// The DO never talks to Clerk; this route is the orchestrator. If the
// requested email is already a tenant member we grant immediately (ACL rule +
// status "granted"); otherwise we send a Clerk org invitation and park the row
// at "invited" — the Clerk webhook finishes the grant when they join.
// Idempotent: re-approving neither duplicates the ACL rule nor re-invites.
import { clerkClient } from "@clerk/nextjs/server";
import {
  callerLabel,
  ensureUserGrantAs,
  errorResponse,
  HttpError,
  listAccessAs,
  requireSharing,
  setAccessStatusAs,
  toClerkOrgRole,
} from "@/lib/hub";

export async function POST(req: Request) {
  try {
    const { tenant, orgId, userId } = await requireSharing();
    const body = (await req.json().catch(() => ({}))) as { id?: string };
    const id = (body?.id ?? "").trim();
    if (!id) throw new HttpError(400, "id required");

    const { requests } = await listAccessAs(tenant);
    const row = requests.find((r) => r.id === id);
    if (!row) throw new HttpError(404, "unknown access request");
    // Already resolved as granted — nothing to redo.
    if (row.status === "granted") {
      return Response.json({ ok: true, status: "granted" }, { status: 200 });
    }

    const clerk = await clerkClient();

    // Is this email already a member of the tenant? Org tenants: look the user
    // up by email, then check their org memberships. Personal (no-org)
    // tenants have exactly one member — the owner.
    const users = await clerk.users.getUserList({ emailAddress: [row.email] });
    const user = users.data[0];
    let isMember = false;
    if (user && orgId) {
      const memberships = await clerk.users.getOrganizationMembershipList({
        userId: user.id,
      });
      isMember = memberships.data.some((m) => m.organization.id === orgId);
    } else if (user && !orgId) {
      isMember = user.id === userId;
    }

    const resolvedBy = await callerLabel(userId);

    if (isMember) {
      // Member already — grant now (idempotent) and close the row.
      await ensureUserGrantAs(tenant, row.email, row.service);
      await setAccessStatusAs(tenant, id, "granted", resolvedBy);
      return Response.json({ ok: true, status: "granted" }, { status: 200 });
    }

    // Not a member — needs a Clerk org invitation, so an org is required.
    if (!orgId) {
      throw new HttpError(
        400,
        "an active organization is required to invite outside users",
      );
    }
    try {
      await clerk.organizations.createOrganizationInvitation({
        organizationId: orgId,
        emailAddress: row.email,
        role: toClerkOrgRole(undefined),
        inviterUserId: userId,
      });
    } catch (err) {
      // An outstanding invitation for this email already exists (re-approve,
      // or an invite sent elsewhere) — that IS the desired state. Swallow ONLY
      // that error code: any other failure (rate limit, revoked invite,
      // misconfig) must surface even on a re-approve of an "invited" row,
      // otherwise the admin sees success while no email ever goes out.
      const code = (err as { errors?: { code?: string }[] })?.errors?.[0]?.code;
      const isDuplicate =
        code === "duplicate_record" || (code ?? "").includes("already");
      if (!isDuplicate) throw err;
    }
    await setAccessStatusAs(tenant, id, "invited", resolvedBy);
    return Response.json({ ok: true, status: "invited" }, { status: 200 });
  } catch (err) {
    return errorResponse(err);
  }
}
