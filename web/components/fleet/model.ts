// The /fleet page's view of an account, mapped from the hub's GET /api/state.
//
// This is the privacy boundary for the page: toFleetView copies an explicit
// allow-list of fields and nothing else. The hub's state also carries things
// the page must never print (a key's hash and last digits, the owner's email,
// the admin log with caller IPs); none of them are read here, so none of them
// can reach the HTML or the client components' props. Call records are the
// relay's RecentCall (time, route, caller, status, duration). Bodies are never
// recorded by the hub, and this module has no field that could carry one.
//
// Pure and dependency-free so it can be tested without Next or Clerk.

export type AuthMode = 'key' | 'public';
export type ServiceStatus = 'online' | 'offline' | 'waiting';

export interface FleetCall {
  /** epoch ms */
  ts: number;
  /** UTC wall time: "14:02:05" today, "Sep 26, 14:02" before today. */
  time: string;
  /** Relative to the read time: "now", "3m ago". */
  ago: string;
  route: string;
  caller: string;
  status: number;
  ok: boolean;
  took: string;
}

export interface FleetMachine {
  name: string;
  os: string;
  version: string;
  online: boolean;
  /** Joined but not yet approved on the hub. */
  pending: boolean;
  lastSeen: string;
  outdated: boolean;
}

export interface FleetService {
  id: string;
  label: string;
  url: string;
  auth: AuthMode;
  status: ServiceStatus;
  lastSeen: string;
  machines: FleetMachine[];
  calls: FleetCall[];
}

export interface FleetKey {
  id: string;
  label: string;
  /** Every service, or the named ones. */
  reach: 'all' | string[];
  created: string;
  /**
   * The day the hub stops accepting the key (YYYY-MM-DD), or "" when it never
   * will. Every key is stamped with a date at mint, but the hub only enforces
   * it when the account turns expiry on (settings.enforceExpiry), so a date is
   * shown only then.
   */
  expires: string;
  /** Past its enforced expiry date: the hub already rejects it. */
  expired: boolean;
}

export interface OldMachine {
  service: string;
  machine: string;
  version: string;
}

export interface FleetView {
  /** The account's slug, e.g. "sunny-wren-42"; "" until the hub assigns one. */
  slug: string;
  /** The account address callers use, e.g. "sunny-wren-42.finchmcp.com". */
  address: string;
  /** Origin every service URL starts with. */
  base: string;
  services: FleetService[];
  keys: FleetKey[];
  latestAgent: string;
  oldMachines: OldMachine[];
  /** epoch ms the page read the hub. */
  readAt: number;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const pad = (n: number) => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "14:02:05" in UTC. */
export function utcClock(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/** UTC time of day for a call from today (by the read time), else a short date. */
export function callTime(ts: number, now: number): string {
  if (!ts || ts <= 0) return '—';
  const d = new Date(ts);
  const n = new Date(now);
  const sameDay =
    d.getUTCFullYear() === n.getUTCFullYear() &&
    d.getUTCMonth() === n.getUTCMonth() &&
    d.getUTCDate() === n.getUTCDate();
  if (sameDay) return utcClock(ts);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** Relative time, matching the hub's own wording ("now", "3m ago", "never"). */
export function timeAgo(ts: number, now: number): string {
  if (!ts || ts <= 0) return 'never';
  const sec = Math.floor(Math.max(0, now - ts) / 1000);
  if (sec < 10) return 'now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

/**
 * Who made a call, as a person reads it. The relay records a key's label, or
 * oauth:<Clerk user id> for a signed-in connector (on a single-user account
 * that is always the owner), "public" for a public service called without a
 * key ("anonymous" when that call found the machine offline), and "dashboard"
 * for the hub's own first-party calls (finch test / call).
 */
export function callerLabel(raw: string): string {
  if (raw.startsWith('oauth:')) return 'you, signed in (OAuth)';
  if (raw === 'public' || raw === 'anonymous') return 'no key (public)';
  // "finch-cli" from the 1.8 hub on; "dashboard" on calls recorded before it.
  if (raw === 'finch-cli' || raw === 'dashboard') return 'finch test or call';
  if (!raw) return 'unknown';
  return `key: ${raw}`;
}

/**
 * "waiting" means a machine joined and needs `finch approve`. A service is
 * "invited" from `finch add` until its first machine joins; there is nothing
 * to approve yet, so it reads as offline (the card says no machine connected).
 */
function serviceStatus(state: string): ServiceStatus {
  if (state === 'online' || state === 'in_use') return 'online';
  if (state === 'pending') return 'waiting';
  return 'offline';
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

/**
 * True only when `version` is an older release than `latest`. The hub flags a
 * machine as outdated on any difference, which would also tell a machine on a
 * newer or locally built finch to "update"; anything that isn't plain semver
 * is never called old.
 */
export function olderThan(version: string, latest: string): boolean {
  const a = SEMVER.exec(version.trim());
  const b = SEMVER.exec(latest.trim());
  if (!a || !b) return false;
  for (let i = 1; i <= 3; i++) {
    const d = Number(a[i]) - Number(b[i]);
    if (d !== 0) return d < 0;
  }
  // Same x.y.z: a prerelease of the latest (1.8.0-rc.1) is older than it.
  return Boolean(a[4]) && !b[4];
}

function tookLabel(ms: number): string {
  if (ms >= 10_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms)} ms`;
}

function isoDay(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Map the hub's /api/state JSON to exactly what the page shows. */
export function toFleetView(raw: unknown, now: number): FleetView {
  const state = obj(raw);
  const settings = obj(state.settings);
  const slug = str(settings.subdomain);
  const address = str(state.host);
  // The hub names the origin services answer on (serviceBase). Fall back to
  // the stored address only if an older hub didn't send it.
  const base = str(state.serviceBase).replace(/\/+$/, '') || (address ? `https://${address}` : '');
  const latestAgent = str(state.latestAgent);
  const enforceExpiry = settings.enforceExpiry === true;

  const services: FleetService[] = arr(state.services).flatMap((s) => {
    const svc = obj(s);
    const id = str(svc.id);
    if (!id) return [];
    const machines: FleetMachine[] = arr(svc.boxes).map((b) => {
      const box = obj(b);
      return {
        name: str(box.name),
        os: str(box.os),
        version: str(box.version),
        online: box.online === true,
        pending: str(box.state) === 'pending',
        lastSeen: timeAgo(num(box.lastSeenAt), now),
        outdated: olderThan(str(box.version), latestAgent),
      };
    });
    const calls: FleetCall[] = arr(svc.recentCalls).map((c) => {
      const call = obj(c);
      const ts = num(call.ts);
      const status = num(call.status);
      return {
        ts,
        time: callTime(ts, now),
        ago: timeAgo(ts, now),
        route: str(call.route),
        caller: callerLabel(str(call.caller)),
        status,
        ok: status > 0 && status < 400,
        took: tookLabel(num(call.ms)),
      };
    });
    return [{
      id,
      label: str(svc.label) || id,
      url: base ? `${base}/${id}/mcp` : '',
      auth: svc.auth === 'public' ? 'public' : 'key',
      status: serviceStatus(str(svc.state)),
      lastSeen: timeAgo(num(svc.lastSeenAt), now),
      machines,
      calls,
    }];
  });

  const keys: FleetKey[] = arr(state.keys).flatMap((k) => {
    const key = obj(k);
    const id = str(key.id);
    if (!id) return [];
    const scope = obj(key.scope);
    const reach: FleetKey['reach'] = scope.all === true
      ? 'all'
      : arr(scope.services).filter((x): x is string => typeof x === 'string');
    const expiresAt = enforceExpiry ? num(key.expiresAt) : 0;
    return [{
      id,
      label: str(key.label) || id,
      reach,
      created: str(key.created),
      expires: isoDay(expiresAt),
      expired: expiresAt > 0 && now > expiresAt,
    }];
  });

  const oldMachines: OldMachine[] = services.flatMap((svc) =>
    svc.machines
      .filter((m) => m.outdated && m.version)
      .map((m) => ({ service: svc.id, machine: m.name, version: m.version })),
  );

  return { slug, address, base, services, keys, latestAgent, oldMachines, readAt: now };
}

/** Quote one shell argument only when it needs it. */
function shellArg(value: string): string {
  return /^[A-Za-z0-9._:/@=-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The exact finch commands the page offers; every change is made from a terminal. */
export const cmd = {
  logs: (id: string) => `finch logs ${shellArg(id)}`,
  test: (id: string) => `finch test ${shellArg(id)}`,
  connect: (id: string) => `finch connect ${shellArg(id)} --client claude-code`,
  auth: (id: string, mode: AuthMode) => `finch auth ${shellArg(id)} ${mode}`,
  rm: (id: string) => `finch rm ${shellArg(id)}`,
  approve: (id: string) => `finch approve ${shellArg(id)}`,
  revoke: (keyId: string) => `finch keys revoke ${shellArg(keyId)}`,
  mint: (service: string) => `finch keys mint my-client --service ${shellArg(service)}`,
  update: () => 'finch update',
  serviceStatus: () => 'finch service status',
  fleet: () => 'finch fleet',
};
