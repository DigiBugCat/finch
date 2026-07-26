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

// Server-side role projection.
//
// `member` is a deliberately fenced-in principal: approveAccess mints exactly
// that role for an OUTSIDER granted a single service, and the DO refuses admin
// operations for it. Every sibling control-plane route sits behind
// requireAdmin()/requireSharing() -- keys, acl, access, settings, hostnames,
// users. This route cannot simply join them, because the member dashboard
// (overview / home / detail / logs) reads it. So project instead of gate.
//
// This has to happen here: hubFetchAs sends only a signed {tenant} assertion and
// getState() takes no actor, so the hub has no idea who is asking.
//
// Collections are emptied rather than deleted so the client's shape expectations
// (and requireStateShape's own contract) still hold.
const EMPTY_COLLECTIONS = ["keys", "acl", "accessRequests", "groups", "members"] as const;

// Emptying the collections above is not sufficient on its own: the AUDIT LOG
// re-supplies the same data in prose, and members legitimately see the Logs
// view. Each excluded category embeds precisely what was stripped —
//   access — invitee emails, `id <email>` roster pairs, ACL grant topology
//   key    — key labels and their owners
//   admin  — setting values (re-supplying `settings`), group and tag topology
// so the category filter, not the collection emptying, is what actually holds
// the boundary. Kept: `device` (enrollment/join/online-offline, whose actor and
// target are service and box ids) and `request` (the latency-and-errors feed).
const MEMBER_LOG_CATEGORIES = new Set(["device", "request"]);

function projectLogsForMember(logs: unknown): unknown {
  if (!Array.isArray(logs)) return logs;
  return logs
    .filter(
      (entry) =>
        isJsonObject(entry) &&
        typeof entry.cat === "string" &&
        MEMBER_LOG_CATEGORIES.has(entry.cat),
    )
    .map((entry) => {
      const row = entry as Record<string, unknown>;
      // A `request` actor is the finch_ KEY LABEL — the same identifier removed
      // from services[].keys, so leaving it would hand it straight back.
      return row.cat === "request" ? { ...row, actor: "" } : row;
    });
}

/** Key labels reveal which credentials reach which service; address/relay are
 *  box infrastructure. Neither is needed by the views a member can open. */
function stripBoxDetail(box: unknown): unknown {
  return isJsonObject(box) ? { ...box, keys: [], address: "", relay: "" } : box;
}

function stripServiceDetail(service: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...service, keys: [] };
  if (Array.isArray(out.boxes)) out.boxes = out.boxes.map(stripBoxDetail);
  // recentCalls[].caller is resolved at the relay to the finch_ key LABEL —
  // strictly more revealing than services[].keys, which holds key IDs. The feed
  // (route, status, ms, timestamp) survives; only the caller identity goes.
  if (Array.isArray(out.recentCalls)) {
    out.recentCalls = out.recentCalls.map((call) =>
      isJsonObject(call) ? { ...call, caller: "" } : call,
    );
  }
  return out;
}

function projectForMember(state: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...state };
  for (const field of EMPTY_COLLECTIONS) out[field] = [];
  out.settings = {};
  out.logs = projectLogsForMember(out.logs);
  if (Array.isArray(out.services)) {
    out.services = out.services.map((service) =>
      isJsonObject(service) ? stripServiceDetail(service) : service,
    );
  }
  if (Array.isArray(out.boxes)) out.boxes = out.boxes.map(stripBoxDetail);
  return out;
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
    // isAdmin is role !== "member" (lib/hub.ts). The roster goes with it: it
    // carries every member's email and clerkUserId.
    const visibleState = ctx.isAdmin ? state : projectForMember(state);
    return Response.json({
      ...visibleState,
      users: ctx.isAdmin ? users : [],
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
