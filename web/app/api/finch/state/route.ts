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
// FIELD projection is only half of it: blanking keys/acl/labels still shipped
// every service and box in the fleet. Narrowing the COLLECTIONS needs the ACL,
// so it happens in the hub — GET /api/state?viewer=<memberId>, evaluated by
// TenantDO.viewerFilter with the same predicate the browser door uses
// (worker/src/tenant-do.ts gateBrowser). Re-implementing that walk here would
// fork the rule and eventually hide services a member can legitimately call.
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
//
// This category filter is a FIELD projection, not an ACL one: the two kept
// categories are per-SERVICE rows, and which services a member may see is a
// question only the hub can answer. So the hub narrows logs[] by the same
// viewerFilter it narrows services[] with (tenant-do.ts getState, keyed on the
// structured StoredLogEvent.svc). This filter stays as the second, coarser
// layer — it is not the thing holding the service boundary.
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
  // The hub echoes viewerScoped only after it has actually applied the ACL
  // narrowing. Web and hub deploy independently, so an unpatched (or rolled
  // back) hub would answer the ?viewer= request with the WHOLE fleet and the
  // field projection below would happily dress it up as member-safe. Fail
  // closed instead: no echo, no fleet — and no LOG either, since an unnarrowed
  // logs[] carries the same per-service call feed (`${service} ${route}` +
  // status, 500 deep) that emptying services[] was meant to withhold.
  //
  // ============================ DEPLOY ORDER =============================
  // THE HUB MUST BE DEPLOYED BEFORE THIS WEB WORKER. Ship web first and every
  // member gets a blank dashboard until the hub catches up — an availability
  // regression, not a security one, and the trade is deliberate: this branch
  // does not get weakened to soften it.
  //
  // Two things enforce the order rather than merely asking for it:
  //   - .github/workflows/deploy.yml — the `web` job declares `needs: hub`, so
  //     the hub Worker for the env is live before web is built at all.
  //   - web/scripts/deploy-preflight.mjs — refuses to build web from a tree
  //     whose worker/src/tenant-do.ts does not emit the echo, which is what a
  //     hand-run `npm run deploy` from a stale/reverted checkout looks like.
  // =======================================================================
  if (state.viewerScoped !== true) {
    out.services = [];
    out.boxes = [];
    out.logs = [];
    return out;
  }
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
    // Only a member is scoped. An admin's read is byte-for-byte what it was:
    // no viewer, so the DO takes its unnarrowed path.
    const path = ctx.isAdmin
      ? "/api/state"
      : `/api/state?viewer=${encodeURIComponent(ctx.memberId)}`;
    const response = await hubFetchAs(ctx.tenant, path, { method: "GET" });
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
