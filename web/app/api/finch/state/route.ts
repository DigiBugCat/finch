import { errorResponse, HttpError, resolveTenant, hubFetchAs } from "@/lib/hub";
import { isJsonObject, readHubJsonObject } from "../services/_contract";

const ROLE_LABELS = { owner: "Owner", admin: "Admin", member: "Member" } as const;
const MEMBER_STATES = new Set(["invited", "active", "disabled"]);

function requireStateShape(state: Record<string, unknown>): void {
  const arrayFields = [
    "services",
    "boxes",
    "keys",
    "groups",
    "acl",
    "accessRequests",
    "logs",
  ];
  if (
    typeof state.host !== "string" ||
    typeof state.latestAgent !== "string" ||
    !isJsonObject(state.settings) ||
    !isJsonObject(state.overview) ||
    arrayFields.some((field) => !Array.isArray(state[field]))
  ) {
    throw new HttpError(502, "invalid response from hub");
  }
  if (state.members !== undefined && !Array.isArray(state.members)) {
    throw new HttpError(502, "invalid response from hub");
  }
}

function parseMembers(value: unknown): {
  id: string;
  email: string;
  role: keyof typeof ROLE_LABELS;
  state: "invited" | "active" | "disabled";
}[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new HttpError(502, "invalid response from hub");
  return value.map((member) => {
    if (
      !isJsonObject(member) ||
      typeof member.id !== "string" ||
      !member.id ||
      typeof member.email !== "string" ||
      !member.email ||
      (member.role !== "owner" && member.role !== "admin" && member.role !== "member") ||
      typeof member.state !== "string" ||
      !MEMBER_STATES.has(member.state)
    ) {
      throw new HttpError(502, "invalid response from hub");
    }
    return {
      id: member.id,
      email: member.email,
      role: member.role,
      state: member.state as "invited" | "active" | "disabled",
    };
  });
}

export async function GET() {
  try {
    const ctx = await resolveTenant();
    const response = await hubFetchAs(ctx.tenant, "/api/state", { method: "GET" });
    if (!response.ok) {
      const contentType = response.headers.get("content-type") ?? "application/json";
      return new Response(response.body, {
        status: response.status,
        headers: { "content-type": contentType },
      });
    }

    const state = await readHubJsonObject(response, 2 * 1024 * 1024);
    requireStateShape(state);
    const members = parseMembers(state.members);
    const tenant = state.tenant;
    if (tenant !== undefined && !isJsonObject(tenant)) {
      throw new HttpError(502, "invalid response from hub");
    }
    const tenantName = tenant?.displayName;
    const tenantKind = tenant?.kind;
    if (tenantName !== undefined && typeof tenantName !== "string") {
      throw new HttpError(502, "invalid response from hub");
    }
    if (tenantKind !== undefined && tenantKind !== "personal" && tenantKind !== "team") {
      throw new HttpError(502, "invalid response from hub");
    }
    const settings = state.settings;
    if (!isJsonObject(settings)) throw new HttpError(502, "invalid response from hub");
    const fallbackOrg = settings.org;
    if (tenantName === undefined && fallbackOrg !== undefined && typeof fallbackOrg !== "string") {
      throw new HttpError(502, "invalid response from hub");
    }

    const users = members.map((member) => ({
      id: member.id,
      name: member.email,
      email: member.email,
      role: ROLE_LABELS[member.role],
      devices: 0,
      lastActive: "—",
      status: member.state,
    }));
    return Response.json({
      ...state,
      users,
      callerRole: ctx.role,
      workspace: {
        id: ctx.tenant,
        name: tenantName ?? fallbackOrg ?? ctx.tenant,
        kind: tenantKind ?? "personal",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
