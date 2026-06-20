// Finch control-plane — canonical types shared by the hub worker, the agent
// join protocol, and (mirrored) the dashboard. This is the REAL schema; the
// dashboard's view components consume this exact shape (it matches the former
// mock ROOST_DATA so the UI renders unchanged).

export type ApplianceState =
  | "in_use"
  | "chirping"
  | "resting"
  | "invited"
  | "pending";

export const isOnline = (s: ApplianceState): boolean =>
  s === "chirping" || s === "in_use";

/** A box that runs an appliance type. Path: /<appliance>/<machine>/mcp */
export interface Machine {
  name: string;
  os: string;
  version: string;
  state: ApplianceState;
  appliance: string; // appliance id
  applianceLabel: string;
  keys: string[]; // finch_ key labels scoped to this machine
  address: string; // tailnet-style display address
  outdated: boolean;
  lastSeen: string; // formatted relative string, derived from lastSeenAt on read
  lastSeenAt?: number; // epoch ms (0/undefined = never)
  relay: string;
  handshake: string; // formatted relative string, derived from handshakeAt on read
  handshakeAt?: number; // epoch ms (0/undefined = never)
  // runtime (not persisted): the relay DO sets these from the live WS
  connected?: boolean;
}

/** An appliance = a capability TYPE (web-scraper, printer, embeddings…). */
export interface Appliance {
  id: string;
  label: string;
  state: ApplianceState; // derived from its machines (online if any machine online)
  owner: string;
  box: string;
  created: string;
  lastSeen: string; // formatted relative string, derived from lastSeenAt on read
  lastSeenAt?: number; // epoch ms (0/undefined = never)
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
  // metrics (real, from the relay's rolling counters; zero until traffic flows)
  calls: number;
  p50: number;
  p95: number;
  err: number;
  traffic24h: number[]; // 24 trailing hourly buckets, index 23 = current hour
  lat24h: number[];
  // Absolute epoch-hour (Date.now()/3_600_000, floored) the buckets were last
  // written/rolled. recordCall ages stale buckets to zero from here; getState
  // rotates the array so index 23 is the current hour on read. undefined → the
  // buckets are treated as belonging to the current hour (legacy/first write).
  lastBucketHour?: number;
  recentCalls: RecentCall[];
  conn: Connection;
}

export interface RecentCall {
  ts: number; // epoch ms — formatted to a relative "ago" on read
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

/** A key's reach, in STRUCTURED form (no magic strings). Either every
 *  appliance ({all:true}) or an explicit allow-list of appliance ids. The
 *  allow-list is validated at mint (every id must exist) so a key can never
 *  carry free-text that silently grants nothing or everything. */
export type KeyScope = { all: true } | { all?: false; appliances: string[] };

export interface Key {
  id: string;
  label: string;
  owner: string;
  created: string;
  scope: KeyScope; // structured reach (validated at mint)
  hash: string; // sha-256 of the finch_ key; plaintext returned ONCE at mint
  last4: string; // for display
  // Absolute expiry (epoch ms). Stamped at mint from settings.keyExpiry; only
  // ENFORCED when settings.enforceExpiry is on. undefined = never expires.
  expiresAt?: number;
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
  ts: number; // epoch ms, for ordering/filtering
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

/** The full per-tenant state — exactly what GET /api/state returns and what
 *  the dashboard renders. Users are NOT stored here; they come from Clerk org. */
export interface TenantState {
  host: string; // <subdomain>.finchmcp.com
  appliances: Appliance[];
  machines: Machine[]; // flattened across appliances (the Machines lens)
  keys: PublicKey[]; // hash/last4 only — never plaintext over the wire
  groups: Group[];
  acl: AclRule[];
  logs: LogEvent[];
  settings: Settings;
  overview: Overview;
  latestAgent: string;
}

/** A key as exposed to the dashboard — no hash, no plaintext. */
export type PublicKey = Omit<Key, "hash"> & { hash?: undefined };

// ---- API request/response shapes ----------------------------------

export interface EnrollResp {
  id: string;
  ticket: string; // one-shot signed join ticket (shown once)
  url: string; // load-balanced appliance URL
  install: string; // one-paste command for the box
  expiresAt: number;
}

export interface JoinResp {
  ok: boolean;
  tenant: string;
  appliance: string;
  machine: string;
  host: string; // public host, e.g. <slug>.finchmcp.com — lets the agent print the full URL
  url: string; // public MCP endpoint, e.g. https://<slug>.finchmcp.com/<appliance>/mcp
  connectUrl: string; // wss URL to open the relay WebSocket
  // Short-lived (~120s) per-machine HMAC grant the agent MUST present on the
  // _connect dial as ?ct=<connectToken>. The hub verifies it (kind+tenant+
  // appliance+machine match, not expired) BEFORE forwarding the WS upgrade.
  connectToken: string;
  // Long-lived (~30d) per-machine credential. The agent keeps this and presents
  // it at POST /refresh to mint fresh connect-tokens, so steady-state reconnects
  // never re-use the one-shot join ticket (which is burned on first /join).
  refreshToken: string;
}

// POST /refresh response — re-mints a connect-token from a still-valid refresh
// token (no ticket re-use). Same shape as JoinResp minus the refresh token.
export interface RefreshResp {
  ok: boolean;
  tenant: string;
  appliance: string;
  machine: string;
  host: string;
  url: string;
  connectUrl: string;
  connectToken: string;
}

export interface MintKeyResp {
  key: string; // plaintext finch_… — returned ONCE
  label: string;
  scope: KeyScope;
}

export const LATEST_AGENT = "1.4.0";
