import { auth, clerkClient } from "@clerk/nextjs/server";
import { errorResponse, HttpError, userFetch } from "@/lib/hub";
import { organizationsUnavailable } from "@/lib/identity";
import { writeActiveTenant } from "@/lib/tenant-cookie";
import { forwardHubResponse, readHubJsonObject, readJsonObject } from "../../_shared";

const PAGE_SIZE = 100;
const MAX_CALLER_ORGANIZATIONS = 1_000;
const MAX_IMPORTED_MEMBERS = 200;

const normalized = (value: string) => value.trim().toLowerCase();
const validEmail = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const email = normalized(value);
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
};

async function verifiedIdentity(clerk: any, userId: string) {
  const user = await clerk.users.getUser(userId);
  const verified = Array.isArray(user?.emailAddresses)
    ? user.emailAddresses.filter((row: any) => row?.verification?.status === "verified")
    : [];
  const primary = verified.find((row: any) => row.id === user.primaryEmailAddressId) ?? verified[0];
  return validEmail(primary?.emailAddress);
}

function pageData(page: any): any[] {
  if (!page || !Array.isArray(page.data) || page.data.length > PAGE_SIZE) {
    throw new HttpError(502, "invalid response from identity provider");
  }
  return page.data;
}

async function findCallerMembership(
  fetchPage: (offset: number) => Promise<any>,
  clerkOrgId: string,
): Promise<any | null> {
  for (let offset = 0; offset < MAX_CALLER_ORGANIZATIONS; offset += PAGE_SIZE) {
    const data = pageData(await fetchPage(offset));
    const found = data.find((row) => row?.organization?.id === clerkOrgId);
    if (found) return found;
    if (data.length < PAGE_SIZE) return null;
  }
  throw new HttpError(409, "too many organization memberships to search safely");
}

async function allPages(
  fetchPage: (offset: number) => Promise<any>,
  maxRows: number,
  overflowMessage: string,
) {
  const rows: any[] = [];
  for (let offset = 0;; offset += PAGE_SIZE) {
    const data = pageData(await fetchPage(offset));
    rows.push(...data);
    if (rows.length > maxRows) throw new HttpError(409, overflowMessage);
    if (data.length < PAGE_SIZE) return rows;
  }
}

export async function POST(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId) throw new HttpError(401, "unauthenticated");
    const body = await readJsonObject(req);
    const clerkOrgId = typeof body.clerkOrgId === "string" ? body.clerkOrgId.trim() : "";
    if (!/^org_[A-Za-z0-9_-]{1,124}$/.test(clerkOrgId)) {
      throw new HttpError(400, "invalid organization id");
    }
    const clerk: any = await clerkClient();
    let caller: any | null;
    try {
      caller = await findCallerMembership(
        (offset) => clerk.users.getOrganizationMembershipList({ userId, limit: PAGE_SIZE, offset }),
        clerkOrgId,
      );
    } catch (error) {
      if (organizationsUnavailable(error)) throw new HttpError(400, "organizations unavailable on this instance");
      throw error;
    }
    if (!caller || !["org:admin", "admin"].includes(caller.role)) throw new HttpError(403, "organization admin required");

    let organization: any;
    let memberships: any[];
    let invitations: any[];
    try {
      organization = await clerk.organizations.getOrganization({ organizationId: clerkOrgId });
      memberships = await allPages(
        (offset) => clerk.organizations.getOrganizationMembershipList({ organizationId: clerkOrgId, limit: PAGE_SIZE, offset }),
        MAX_IMPORTED_MEMBERS,
        "organization has more than 200 members",
      );
      invitations = await allPages(
        (offset) => clerk.organizations.getOrganizationInvitationList({ organizationId: clerkOrgId, limit: PAGE_SIZE, offset, status: "pending" }),
        MAX_IMPORTED_MEMBERS,
        "organization has more than 200 pending invitations",
      );
    } catch (error) {
      if (organizationsUnavailable(error)) throw new HttpError(400, "organizations unavailable on this instance");
      throw error;
    }
    const imported: any[] = [];
    const skipped: string[] = [];
    for (const membership of memberships) {
      const uid = membership?.publicUserData?.userId ?? membership?.public_user_data?.user_id;
      if (!uid) { skipped.push("membership without user id"); continue; }
      const email = await verifiedIdentity(clerk, uid);
      const identifier = membership.publicUserData?.identifier ?? membership.public_user_data?.identifier ?? "";
      const fallback = validEmail(identifier);
      if (!email && !fallback) { skipped.push(uid); continue; }
      const resolvedEmail = email ?? fallback;
      if (imported.some((row) => row.clerkUserId === uid || row.email === resolvedEmail)) continue;
      imported.push({ clerkUserId: email ? uid : undefined, email: resolvedEmail, role: uid === userId ? "owner" : (["org:admin", "admin"].includes(membership.role) ? "admin" : "member"), state: email ? "active" : "invited" });
    }
    for (const invitation of invitations) {
      const email = validEmail(invitation?.emailAddress ?? invitation?.email_address);
      if (email && !imported.some((row) => row.email === email)) imported.push({ email, role: "member", state: "invited" });
    }
    if (!imported.some((row) => row.clerkUserId === userId && row.role === "owner" && row.state === "active")) {
      const email = await verifiedIdentity(clerk, userId);
      if (!email) throw new HttpError(403, "verify your email before claiming this workspace");
      imported.unshift({ clerkUserId: userId, email, role: "owner", state: "active" });
    }
    if (imported.length > 200) throw new HttpError(409, "organization has more than 200 importable members");

    // User expansion can be slow for a large org. Re-read the caller's role
    // immediately before the irreversible bootstrap so a mid-import demotion
    // does not turn a former admin into the workspace owner.
    let currentCaller: any | null;
    try {
      currentCaller = await findCallerMembership(
        (offset) => clerk.users.getOrganizationMembershipList({ userId, limit: PAGE_SIZE, offset }),
        clerkOrgId,
      );
    } catch (error) {
      if (organizationsUnavailable(error)) throw new HttpError(400, "organizations unavailable on this instance");
      throw error;
    }
    if (!currentCaller || !["org:admin", "admin"].includes(currentCaller.role)) {
      throw new HttpError(403, "organization admin required");
    }

    const rawDisplayName = typeof organization?.name === "string" ? organization.name.trim() : "";
    const displayName = [...rawDisplayName].slice(0, 64).join("") || clerkOrgId;
    const hub = await userFetch(userId, "/api/tenant-bootstrap", { method: "POST", body: JSON.stringify({ tenantId: clerkOrgId, clerkOrgId, displayName, kind: "team", bootstrappedFrom: "legacy-org", members: imported }) });
    if (!hub.ok) return forwardHubResponse(hub);
    const out = await readHubJsonObject(hub);
    if (out.ok !== true) throw new HttpError(502, "invalid response from hub");
    await writeActiveTenant(clerkOrgId);
    const counts = { owners: imported.filter((m) => m.role === "owner").length, admins: imported.filter((m) => m.role === "admin").length, members: imported.filter((m) => m.role === "member" && m.state === "active").length, invited: imported.filter((m) => m.state === "invited").length, skipped };
    return Response.json({ ok: true, tenantId: clerkOrgId, imported: counts });
  } catch (error) {
    return errorResponse(error);
  }
}
