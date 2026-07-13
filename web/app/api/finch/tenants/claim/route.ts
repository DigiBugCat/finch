import { auth, clerkClient } from "@clerk/nextjs/server";
import { errorResponse, HttpError, userFetch } from "@/lib/hub";
import { organizationsUnavailable } from "@/lib/identity";
import { writeActiveTenant } from "@/lib/tenant-cookie";

const normalized = (value: string) => value.trim().toLowerCase();
async function verifiedIdentity(clerk: any, userId: string) {
  const user = await clerk.users.getUser(userId);
  const verified = user.emailAddresses.filter((row: any) => row.verification?.status === "verified");
  const primary = verified.find((row: any) => row.id === user.primaryEmailAddressId) ?? verified[0];
  return primary ? normalized(primary.emailAddress) : null;
}
async function allPages(fetchPage: (offset: number) => Promise<any>) {
  const rows: any[] = [];
  for (let offset = 0;; offset += 100) {
    const page = await fetchPage(offset);
    rows.push(...page.data);
    if (page.data.length < 100) return rows;
  }
}

export async function POST(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId) throw new HttpError(401, "unauthenticated");
    const body = await req.json().catch(() => ({})) as { clerkOrgId?: string };
    const clerkOrgId = String(body.clerkOrgId || "").trim();
    if (!/^org_[A-Za-z0-9_-]+$/.test(clerkOrgId)) throw new HttpError(400, "invalid organization id");
    const clerk: any = await clerkClient();
    let callerMemberships: any[];
    try {
      callerMemberships = await allPages((offset) => clerk.users.getOrganizationMembershipList({ userId, limit: 100, offset }));
    } catch (error) {
      if (organizationsUnavailable(error)) throw new HttpError(400, "organizations unavailable on this instance");
      throw error;
    }
    const caller = callerMemberships.find((row) => row.organization.id === clerkOrgId);
    if (!caller || !["org:admin", "admin"].includes(caller.role)) throw new HttpError(403, "organization admin required");

    let organization: any;
    let memberships: any[];
    let invitations: any[];
    try {
      organization = await clerk.organizations.getOrganization({ organizationId: clerkOrgId });
      memberships = await allPages((offset) => clerk.organizations.getOrganizationMembershipList({ organizationId: clerkOrgId, limit: 100, offset }));
      invitations = await allPages((offset) => clerk.organizations.getOrganizationInvitationList({ organizationId: clerkOrgId, limit: 100, offset, status: "pending" }));
    } catch (error) {
      if (organizationsUnavailable(error)) throw new HttpError(400, "organizations unavailable on this instance");
      throw error;
    }
    const imported: any[] = [];
    const skipped: string[] = [];
    for (const membership of memberships) {
      const uid = membership.publicUserData?.userId ?? membership.public_user_data?.user_id;
      if (!uid) { skipped.push("membership without user id"); continue; }
      const email = await verifiedIdentity(clerk, uid);
      const identifier = membership.publicUserData?.identifier ?? membership.public_user_data?.identifier ?? "";
      const fallback = /^\S+@\S+\.\S+$/.test(identifier) ? normalized(identifier) : null;
      if (!email && !fallback) { skipped.push(uid); continue; }
      imported.push({ clerkUserId: email ? uid : undefined, email: email ?? fallback, role: uid === userId ? "owner" : (["org:admin", "admin"].includes(membership.role) ? "admin" : "member"), state: email ? "active" : "invited" });
    }
    for (const invitation of invitations) {
      const email = normalized(invitation.emailAddress ?? invitation.email_address ?? "");
      if (email && !imported.some((row) => row.email === email)) imported.push({ email, role: "member", state: "invited" });
    }
    if (!imported.some((row) => row.clerkUserId === userId && row.role === "owner" && row.state === "active")) {
      const email = await verifiedIdentity(clerk, userId);
      if (!email) throw new HttpError(403, "verify your email before claiming this workspace");
      imported.unshift({ clerkUserId: userId, email, role: "owner", state: "active" });
    }
    if (imported.length > 200) throw new HttpError(409, "organization has more than 200 importable members");
    const hub = await userFetch(userId, "/api/tenant-bootstrap", { method: "POST", body: JSON.stringify({ tenantId: clerkOrgId, clerkOrgId, displayName: organization.name || clerkOrgId, kind: "team", bootstrappedFrom: "legacy-org", members: imported }) });
    const out = await hub.json().catch(() => ({}));
    if (!hub.ok) return Response.json(out, { status: hub.status });
    await writeActiveTenant(clerkOrgId);
    const counts = { owners: imported.filter((m) => m.role === "owner").length, admins: imported.filter((m) => m.role === "admin").length, members: imported.filter((m) => m.role === "member" && m.state === "active").length, invited: imported.filter((m) => m.state === "invited").length, skipped };
    return Response.json({ ok: true, tenantId: clerkOrgId, imported: counts });
  } catch (error) {
    return errorResponse(error);
  }
}
