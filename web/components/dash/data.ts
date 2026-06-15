// Finch dashboard — shared TS types + the few static constants the view
// components still import. The mock ROOST_DATA arrays are GONE: the dashboard
// now reads live TenantState from the hub via /api/finch/state (see
// useFinchState.ts).
//
// The types below MIRROR the canonical control-plane schema in
// ../../worker/src/types.ts (the hub is the source of truth). They're inlined
// here rather than imported across the repo boundary so `web` stays a
// self-contained package. Keep them in sync with the worker types.

export type ApplianceState =
  | "in_use"
  | "chirping"
  | "resting"
  | "invited"
  | "pending";

/** A box that runs an appliance type. Path: /<appliance>/<machine>/mcp */
export interface Machine {
  name: string;
  os: string;
  version: string;
  state: ApplianceState;
  appliance: string;
  applianceLabel: string;
  keys: string[];
  address: string;
  outdated: boolean;
  lastSeen: string;
  relay: string;
  handshake: string;
  connected?: boolean;
  // flattened-lens enrichment (the hub adds these on the Machines projection)
  group?: string;
  tags?: string[];
  owner?: string;
}

export interface RecentCall {
  ago: string;
  route: string;
  caller: string;
  status: number;
  ms: number;
}

export interface Connection {
  relay: string;
  version: string;
  address: string;
  handshake: string;
  protocol: string;
}

/** An appliance = a capability TYPE (web-scraper, printer, embeddings…). */
export interface Appliance {
  id: string;
  label: string;
  state: ApplianceState;
  owner: string;
  box: string;
  created: string;
  lastSeen: string;
  uptime: string;
  blurb: string;
  group: string;
  version: string;
  tags: string[];
  outdated: boolean;
  routes: string[];
  keys: string[];
  components: { name: string; state: "online" | "offline"; log: string }[];
  machines: Machine[];
  machineCount: number;
  calls: number;
  p50: number;
  p95: number;
  err: number;
  traffic24h: number[];
  lat24h: number[];
  recentCalls: RecentCall[];
  conn: Connection;
}

/** A key's reach, in STRUCTURED form — mirrors the worker's KeyScope
 *  (worker/src/types.ts). Either every appliance ({all:true}) or an explicit
 *  allow-list of appliance ids. NOT a free-text string: the hub validates this
 *  shape at mint, and checkKey Gate 1 reads `scope.all === true` / the id list.
 *  Keep this in sync with the worker type — the two cross the wire verbatim. */
export type KeyScope = { all: true } | { all?: false; appliances: string[] };

/** Render a KeyScope as a human label for the dashboard (panels.tsx). The hub
 *  returns a KeyScope OBJECT, so rendering it raw yields "[object Object]";
 *  this collapses it to "all appliances" or a comma-joined id list. Tolerant of
 *  a malformed/legacy value so the Keys table never renders garbage. */
export function formatScope(scope: KeyScope | null | undefined): string {
  if (!scope) return "—";
  if ("all" in scope && scope.all === true) return "all appliances";
  const ids = Array.isArray((scope as { appliances?: unknown }).appliances)
    ? (scope as { appliances: string[] }).appliances
    : [];
  return ids.length ? ids.join(", ") : "no appliances";
}

export interface AclEntity {
  type: "user" | "group" | "key" | "tag" | "appliance" | "all";
  name?: string;
}
export interface AclRule {
  id: string;
  src: AclEntity;
  dst: AclEntity[];
  action: "allow";
  locked?: boolean;
}

export interface LogEvent {
  ago: string;
  ts: number;
  cat: "request" | "device" | "key" | "access" | "admin";
  actor: string;
  action: string;
  target: string;
  ip: string;
  result?: number;
}

export interface Group {
  name: string;
  members: string[];
  extra?: number;
}

export interface Settings {
  org: string;
  subdomain: string;
  region: string;
  requireApproval: boolean;
  defaultGroup: string;
  keyExpiry: string;
  enforceExpiry: boolean;
  require2fa: boolean;
}

export interface Overview {
  callsToday: number;
  callsDelta: number;
  activeNow: number;
  total: number;
  p50: number;
  p95: number;
  errRate: number;
  keysActive: number;
  traffic24h: number[];
  latency24h: number[];
  latest: string;
}

/** A key as exposed to the dashboard — no hash, no plaintext. `scope` is the
 *  STRUCTURED KeyScope the hub returns (worker/src/types.ts PublicKey), NOT a
 *  string — render it through formatScope() for display. */
export interface PublicKey {
  id: string;
  label: string;
  owner: string;
  created: string;
  scope: KeyScope;
  last4: string;
}

/** A user shaped for the Users view (layered in from Clerk by /api/finch/state). */
export interface DashUser {
  id: string;
  name: string;
  email: string;
  role: "Owner" | "Admin" | "Member";
  devices: number;
  lastActive: string;
  status: string;
}

/** The full per-tenant state — what GET /api/finch/state returns. */
export interface TenantState {
  host: string;
  appliances: Appliance[];
  machines: Machine[];
  keys: PublicKey[];
  groups: Group[];
  acl: AclRule[];
  logs: LogEvent[];
  settings: Settings;
  overview: Overview;
  latestAgent: string;
  // layered in by /api/finch/state from Clerk
  users: DashUser[];
}

/** Hub POST /api/enroll response. */
export interface EnrollResp {
  id: string;
  ticket: string;
  url: string;
  install: string;
  expiresAt: number;
}

/** Hub POST /api/keys response (plaintext returned ONCE). `scope` is the
 *  structured KeyScope the hub minted (worker/src/types.ts MintKeyResp). */
export interface MintKeyResp {
  key: string;
  label: string;
  scope: KeyScope;
}

// The agent version the dashboard treats as "latest" for the out-of-date badge
// (fleet.tsx). Kept in sync with the hub's LATEST_AGENT.
export const LATEST_AGENT = "1.4.0";
