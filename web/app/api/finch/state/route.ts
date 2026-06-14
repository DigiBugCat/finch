// GET /api/finch/state — the hub's TenantState, augmented with Clerk users.
//
// The hub never stores users (see worker/src/types.ts: "Users are NOT stored
// here; they come from Clerk org"). So we fetch state from the hub, then layer
// in the org's members (or the lone signed-in user, when there's no org) shaped
// to what the dashboard's Users view consumes.

import { auth, clerkClient } from "@clerk/nextjs/server";
import { errorResponse, hubFetch } from "@/lib/hub";

type DashUser = {
  id: string;
  name: string;
  email: string;
  role: "Owner" | "Admin" | "Member";
  devices: number;
  lastActive: string;
  status: string;
};

/** Map a Clerk org role (e.g. "org:admin") to the dashboard's role label. */
function roleLabel(clerkRole: string | null | undefined): "Admin" | "Member" {
  return clerkRole === "org:admin" || clerkRole === "admin" ? "Admin" : "Member";
}

export async function GET() {
  try {
    const { userId, orgId } = await auth();
    if (!userId) {
      return Response.json({ error: "unauthenticated" }, { status: 401 });
    }

    // 1. Pull canonical tenant state from the hub.
    const res = await hubFetch("/api/state");
    const state = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      return Response.json(state, { status: res.status });
    }

    // 2. Derive users from Clerk.
    const clerk = await clerkClient();
    let users: DashUser[];

    if (orgId) {
      const list = await clerk.organizations.getOrganizationMembershipList({
        organizationId: orgId,
        limit: 100,
      });
      users = list.data.map((m) => {
        const pud = m.publicUserData;
        const name =
          [pud?.firstName, pud?.lastName].filter(Boolean).join(" ") ||
          pud?.identifier ||
          "unknown";
        // The org creator/owner carries the "admin" role in Clerk; we surface
        // the current signed-in admin as Owner so the UI shows a locked row.
        const isSelf = pud?.userId === userId;
        const role: DashUser["role"] =
          isSelf && (m.role === "org:admin" || m.role === "admin")
            ? "Owner"
            : roleLabel(m.role);
        return {
          id: pud?.userId ?? m.id,
          name,
          email: pud?.identifier ?? "",
          role,
          devices: 0,
          lastActive: "—",
          status: "active",
        };
      });
    } else {
      // No org → the tenant is the user; they're the sole Owner.
      const user = await clerk.users.getUser(userId);
      const name =
        user.fullName ||
        [user.firstName, user.lastName].filter(Boolean).join(" ") ||
        user.username ||
        user.primaryEmailAddress?.emailAddress ||
        "you";
      users = [
        {
          id: userId,
          name,
          email: user.primaryEmailAddress?.emailAddress ?? "",
          role: "Owner",
          devices: 0,
          lastActive: "—",
          status: "active",
        },
      ];
    }

    return Response.json({ ...state, users });
  } catch (err) {
    return errorResponse(err);
  }
}
