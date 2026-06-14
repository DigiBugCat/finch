// Roost — mock data for the prototype. Plain TS module; exports ROOST_DATA.
const HOST = "maray.finchmcp.com";

// Appliance states: 'in_use' | 'chirping' | 'resting' | 'invited'
// online = in_use | chirping
const appliances: any[] = [
  {
    id: "thermal-printer",
    label: "Thermal printer",
    state: "in_use",
    owner: "you",
    box: "Mac mini",
    created: "2026-04-02",
    lastSeen: "now",
    uptime: "12d 4h",
    calls: 1284,
    p50: 42,
    p95: 118,
    err: 0.2,
    blurb: "Prints labels & receipts on demand for agent workflows.",
    components: [
      { name: "gateway", state: "online", log: "relay open · 1 stream · idle 0.4s" },
      { name: "printer", state: "online", log: "POST /print 200 · 38ms · job #4471" },
    ],
    keys: ["home-laptop", "ci-runner"],
  },
  {
    id: "web-scraper",
    label: "Web scraper",
    state: "chirping",
    owner: "you",
    box: "Raspberry Pi 5",
    created: "2026-03-18",
    lastSeen: "now",
    uptime: "31d 9h",
    calls: 8820,
    p50: 210,
    p95: 540,
    err: 1.1,
    blurb: "Fetches & cleans pages, returns readable markdown.",
    components: [
      { name: "gateway", state: "online", log: "relay open · idle 12s" },
      { name: "app", state: "online", log: "GET /fetch 200 · 184ms" },
    ],
    keys: ["home-laptop"],
  },
  {
    id: "embeddings",
    label: "Embeddings",
    state: "chirping",
    owner: "you",
    box: "Mac mini",
    created: "2026-03-30",
    lastSeen: "now",
    uptime: "9d 1h",
    calls: 4012,
    p50: 64,
    p95: 150,
    err: 0.0,
    blurb: "Local bge-small embeddings over your private corpus.",
    components: [
      { name: "gateway", state: "online", log: "relay open · idle 3s" },
      { name: "model", state: "online", log: "embed batch=16 · 61ms" },
    ],
    keys: ["home-laptop", "priya-mbp"],
  },
  {
    id: "finance-tools",
    label: "Finance tools",
    state: "resting",
    owner: "priya",
    box: "old ThinkPad",
    created: "2026-02-10",
    lastSeen: "2h ago",
    uptime: "—",
    calls: 642,
    p50: 88,
    p95: 240,
    err: 0.4,
    blurb: "Reads ledgers, runs categorization & budget queries.",
    components: [
      { name: "gateway", state: "offline", log: "last relay closed 2h ago" },
      { name: "app", state: "offline", log: "—" },
    ],
    keys: ["priya-mbp"],
  },
  {
    id: "transcribe",
    label: "Transcribe",
    state: "chirping",
    owner: "you",
    box: "Mac Studio",
    created: "2026-03-05",
    lastSeen: "now",
    uptime: "44d 2h",
    calls: 2190,
    p50: 920,
    p95: 2100,
    err: 0.6,
    blurb: "Whisper-large transcription for audio & meetings.",
    components: [
      { name: "gateway", state: "online", log: "relay open · idle 41s" },
      { name: "whisper", state: "online", log: "transcribe 12.4s clip · 1.9s" },
    ],
    keys: ["home-laptop"],
  },
  {
    id: "calendar-sync",
    label: "Calendar sync",
    state: "invited",
    owner: "you",
    box: "—",
    created: "just now",
    lastSeen: "never",
    uptime: "—",
    calls: 0,
    p50: 0,
    p95: 0,
    err: 0,
    blurb: "Ticket minted — waiting for the box to phone home.",
    components: [],
    keys: [],
  },
  {
    id: "nightly-backups",
    label: "Nightly backups",
    state: "resting",
    owner: "sam",
    box: "Synology NAS",
    created: "2026-01-22",
    lastSeen: "6h ago",
    uptime: "—",
    calls: 311,
    p50: 70,
    p95: 190,
    err: 0.0,
    blurb: "Triggers & reports on encrypted off-site backups.",
    components: [
      { name: "gateway", state: "offline", log: "last relay closed 6h ago" },
      { name: "app", state: "offline", log: "—" },
    ],
    keys: ["sam-desktop"],
  },
  {
    id: "doc-scanner",
    label: "Doc scanner",
    state: "pending",
    owner: "priya",
    box: "Mac mini",
    created: "just now",
    lastSeen: "now",
    uptime: "—",
    calls: 0,
    p50: 0,
    p95: 0,
    err: 0,
    blurb: "Connected — waiting for an admin to approve it.",
    components: [
      { name: "gateway", state: "online", log: "relay open · awaiting approval" },
    ],
    keys: [],
  },
];

const keys: any[] = [
  { id: "k1", label: "home-laptop", owner: "you", created: "2026-03-18", value: "rk_live_8f2a91c4d7e0b6a3f95c2e", scope: "all appliances" },
  { id: "k2", label: "ci-runner", owner: "you", created: "2026-04-02", value: "rk_live_2b7d40e9a1c8f63048bd5a", scope: "thermal-printer" },
  { id: "k3", label: "priya-mbp", owner: "priya", created: "2026-02-11", value: "rk_live_5c1e88b30af9d2746e0a17", scope: "embeddings, finance-tools" },
  { id: "k4", label: "sam-desktop", owner: "sam", created: "2026-01-22", value: "rk_live_9a44f7102ce8b5d63fa091", scope: "nightly-backups" },
];

const activity: any[] = [
  { t: "19:42", ago: "2m ago", kind: "call", who: "home-laptop", text: "called thermal-printer · /print 200" },
  { t: "19:31", ago: "13m ago", kind: "online", who: "embeddings", text: "embeddings started chirping" },
  { t: "18:55", ago: "49m ago", kind: "call", who: "priya-mbp", text: "called embeddings · /embed 200" },
  { t: "17:40", ago: "2h ago", kind: "offline", who: "finance-tools", text: "finance-tools went resting" },
  { t: "14:02", ago: "5h ago", kind: "keymint", who: "you", text: "minted key ci-runner" },
  { t: "08:11", ago: "11h ago", kind: "enroll", who: "you", text: "enrolled transcribe" },
  { t: "Yesterday", ago: "1d ago", kind: "revoke", who: "you", text: "revoked key old-laptop" },
  { t: "Apr 02", ago: "3d ago", kind: "enroll", who: "you", text: "enrolled thermal-printer" },
];

// ---- observability enrichment -------------------------------------
let _seed = 20260613;
const rnd = () => { _seed = (_seed * 1664525 + 1013904223) & 0x7fffffff; return _seed / 0x7fffffff; };
const series = (n: number, base: number, amp: number, trend = 0): number[] => Array.from({ length: n }, (_, i) =>
  Math.max(0, Math.round(base + Math.sin(i / 2.5 + 1) * amp * 0.45 + (rnd() - 0.5) * amp + trend * i)));

const ROUTES: Record<string, string[]> = {
  "thermal-printer": ["/print", "/status"],
  "web-scraper": ["/fetch", "/extract", "/readable"],
  "embeddings": ["/embed", "/search"],
  "transcribe": ["/transcribe"],
  "finance-tools": ["/query", "/categorize"],
  "nightly-backups": ["/trigger", "/report"],
  "calendar-sync": ["/sync"],
};
const REGIONS = ["sfo · us-west", "ord · us-central", "ams · eu-west", "nyc · us-east"];
const ROUTES_EXTRA: Record<string, string[]> = { "doc-scanner": ["/scan"] };
Object.assign(ROUTES, ROUTES_EXTRA);
const CALLERS = ["home-laptop", "ci-runner", "priya-mbp", "sam-desktop"];

const LATEST_AGENT = "1.4.0";
const GROUP_OF: Record<string, string> = {
  "thermal-printer": "Home lab", "web-scraper": "Home lab", "embeddings": "Home lab",
  "transcribe": "Studio", "calendar-sync": "Studio", "doc-scanner": "Studio",
  "finance-tools": "Acme · prod", "nightly-backups": "Acme · prod",
};
const VERSION_OF: Record<string, string> = {
  "thermal-printer": "1.4.0", "web-scraper": "1.2.1", "embeddings": "1.4.0",
  "transcribe": "1.3.0", "calendar-sync": "1.4.0", "doc-scanner": "1.4.0",
  "finance-tools": "1.1.4", "nightly-backups": "1.2.0",
};
const TAGS_OF: Record<string, string[]> = {
  "thermal-printer": ["printer", "home"],
  "web-scraper": ["web", "home"],
  "embeddings": ["ai", "home"],
  "transcribe": ["ai"],
  "calendar-sync": ["home"],
  "doc-scanner": ["scanner"],
  "finance-tools": ["finance", "prod"],
  "nightly-backups": ["backup", "prod"],
};
// Machines (physical boxes) that run each appliance type. Path: /<appliance>/<machine>/mcp
const MACHINES_OF: Record<string, any[]> = {
  "thermal-printer": [{ name: "studio-mac-mini", os: "macOS 14.4", version: "1.4.0", state: "in_use", keys: ["home-laptop", "ci-runner"] }],
  "web-scraper": [
    { name: "closet-pi", os: "Raspberry Pi OS", version: "1.2.1", state: "chirping", keys: ["home-laptop"] },
    { name: "garage-nuc", os: "Ubuntu 24.04", version: "1.4.0", state: "chirping", keys: ["home-laptop"] },
  ],
  "embeddings": [
    { name: "studio-mac-studio", os: "macOS 14.4", version: "1.4.0", state: "chirping", keys: ["home-laptop", "priya-mbp"] },
    { name: "loft-nuc", os: "Ubuntu 24.04", version: "1.4.0", state: "chirping", keys: ["priya-mbp"] },
  ],
  "finance-tools": [{ name: "old-thinkpad", os: "Debian 12", version: "1.1.4", state: "resting", keys: ["priya-mbp"] }],
  "transcribe": [{ name: "mac-studio-2", os: "macOS 14.4", version: "1.3.0", state: "chirping", keys: ["home-laptop"] }],
  "calendar-sync": [],
  "nightly-backups": [{ name: "synology-nas", os: "DSM 7.2", version: "1.2.0", state: "resting", keys: ["sam-desktop"] }],
  "doc-scanner": [{ name: "front-desk-mini", os: "macOS 14.4", version: "1.4.0", state: "pending", keys: [] }],
};
const groups: any[] = [
  { name: "Home lab", members: ["you"] },
  { name: "Studio", members: ["you", "priya"] },
  { name: "Acme · prod", members: ["you", "priya", "sam"], extra: 2 },
];

appliances.forEach((a: any, idx: number) => {
  const on = a.state === "chirping" || a.state === "in_use";
  const reachable = on || a.state === "pending";
  a.routes = ROUTES[a.id] || ["/call"];
  a.group = GROUP_OF[a.id] || "Home lab";
  a.version = VERSION_OF[a.id] || LATEST_AGENT;
  a.tags = TAGS_OF[a.id] ? [...TAGS_OF[a.id]] : [];
  a.outdated = a.state !== "invited" && a.version !== LATEST_AGENT;
  a.traffic24h = on ? series(24, Math.max(5, a.calls / 280), Math.max(4, a.calls / 200)) : Array(24).fill(0);
  a.lat24h = on ? series(24, a.p50, Math.max(6, a.p50 * 0.4)) : [];
  a.conn = {
    relay: reachable ? REGIONS[idx % REGIONS.length] : "—",
    version: `finch-agent ${a.version}`,
    address: `100.${64 + idx}.${12 + idx}.${3 + idx}`,
    handshake: reachable ? `${Math.floor(rnd() * 40) + 4}s ago` : a.lastSeen,
    protocol: on ? "QUIC · DERP relay" : a.state === "pending" ? "QUIC · awaiting approval" : "offline",
  };
  a.recentCalls = on ? Array.from({ length: 6 }, (_, i) => {
    const r = a.routes[Math.floor(rnd() * a.routes.length)];
    const bad = rnd() < (a.err / 100) * 2.5;
    return {
      ago: `${i * 7 + 3}s ago`, route: r, caller: CALLERS[Math.floor(rnd() * CALLERS.length)],
      status: bad ? (rnd() < 0.5 ? 429 : 500) : 200, ms: Math.round(a.p50 * (0.6 + rnd() * 1.4)),
    };
  }) : [];
});

const onAppls = appliances.filter((a: any) => a.state === "chirping" || a.state === "in_use");

// ---- machines (boxes) attached to each appliance ------------------
let _maddr = 0;
appliances.forEach((a: any, idx: number) => {
  a.machines = (MACHINES_OF[a.id] || []).map((m: any, mi: number) => {
    const mon = m.state === "chirping" || m.state === "in_use";
    const mreach = mon || m.state === "pending";
    _maddr++;
    return {
      name: m.name, os: m.os, version: m.version, state: m.state,
      appliance: a.id, applianceLabel: a.label, keys: [...(m.keys || [])],
      address: `100.${80 + _maddr}.${10 + mi}.${4 + idx}`,
      outdated: m.version !== LATEST_AGENT,
      lastSeen: mon ? "now" : m.state === "pending" ? "now" : a.lastSeen,
      relay: mreach ? REGIONS[(idx + mi) % REGIONS.length] : "—",
      handshake: mreach ? `${Math.floor(rnd() * 40) + 4}s ago` : a.lastSeen,
    };
  });
  a.machineCount = a.machines.length;
  if (a.machineCount) a.outdated = a.machines.some((m: any) => m.outdated);
});
const machines: any[] = [];
appliances.forEach((a: any) => a.machines.forEach((m: any) => machines.push({ ...m, group: a.group, tags: a.tags, owner: a.owner })));
const trafficByHour = Array.from({ length: 24 }, (_, h) =>
  onAppls.reduce((s: number, a: any) => s + (a.traffic24h[h] || 0), 0));

const acl: any[] = [
  { id: "r1", src: { type: "user", name: "you" }, dst: [{ type: "all" }], action: "allow" },
  { id: "r2", src: { type: "group", name: "Acme · prod" }, dst: [{ type: "tag", name: "prod" }, { type: "tag", name: "finance" }], action: "allow" },
  { id: "r3", src: { type: "user", name: "priya" }, dst: [{ type: "tag", name: "ai" }], action: "allow" },
  { id: "r4", src: { type: "key", name: "home-laptop" }, dst: [{ type: "tag", name: "home" }, { type: "tag", name: "ai" }], action: "allow" },
  { id: "r5", src: { type: "key", name: "ci-runner" }, dst: [{ type: "appliance", name: "thermal-printer" }], action: "allow" },
];

const overview: any = {
  callsToday: trafficByHour.reduce((s: number, v: number) => s + v, 0) * 7 + 1840,
  callsDelta: 12.4,
  activeNow: onAppls.length,
  total: appliances.length,
  p50: Math.round(onAppls.reduce((s: number, a: any) => s + a.p50, 0) / Math.max(1, onAppls.length)),
  p95: Math.max(...onAppls.map((a: any) => a.p95), 0),
  errRate: +(onAppls.reduce((s: number, a: any) => s + a.err, 0) / Math.max(1, onAppls.length)).toFixed(2),
  keysActive: keys.length,
  traffic24h: trafficByHour,
  latency24h: series(24, 96, 30),
  latest: LATEST_AGENT,
};

const users: any[] = [
  { id: "u1", name: "you", email: "you@acme.com", role: "Owner", devices: 4, lastActive: "now", status: "active" },
  { id: "u2", name: "priya", email: "priya@acme.com", role: "Admin", devices: 2, lastActive: "2h ago", status: "active" },
  { id: "u3", name: "sam", email: "sam@acme.com", role: "Member", devices: 1, lastActive: "6h ago", status: "active" },
  { id: "u4", name: "jordan", email: "jordan@acme.com", role: "Member", devices: 0, lastActive: "—", status: "invited" },
];

const logs: any[] = [
  { ago: "2m ago", cat: "request", actor: "home-laptop", action: "called", target: "thermal-printer /print", ip: "100.64.12.3", result: 200 },
  { ago: "6m ago", cat: "request", actor: "priya-mbp", action: "called", target: "embeddings /embed", ip: "100.66.14.5", result: 200 },
  { ago: "13m ago", cat: "device", actor: "embeddings", action: "started chirping", target: "", ip: "100.66.14.5" },
  { ago: "22m ago", cat: "request", actor: "ci-runner", action: "called", target: "web-scraper /fetch", ip: "100.65.13.4", result: 429 },
  { ago: "40m ago", cat: "access", actor: "you", action: "granted", target: "priya → tag:ai", ip: "100.64.12.3" },
  { ago: "1h ago", cat: "key", actor: "you", action: "minted key", target: "ci-runner", ip: "100.64.12.3" },
  { ago: "2h ago", cat: "device", actor: "finance-tools", action: "went resting", target: "", ip: "100.67.15.6" },
  { ago: "2h ago", cat: "request", actor: "home-laptop", action: "called", target: "transcribe /transcribe", ip: "100.64.12.3", result: 200 },
  { ago: "3h ago", cat: "admin", actor: "you", action: "invited", target: "jordan@acme.com", ip: "100.64.12.3" },
  { ago: "5h ago", cat: "device", actor: "doc-scanner", action: "requested approval", target: "", ip: "100.68.16.7" },
  { ago: "5h ago", cat: "access", actor: "you", action: "updated policy", target: "Acme · prod → tag:prod", ip: "100.64.12.3" },
  { ago: "8h ago", cat: "key", actor: "sam", action: "revoked key", target: "old-laptop", ip: "100.69.17.8" },
  { ago: "1d ago", cat: "device", actor: "you", action: "enrolled", target: "thermal-printer", ip: "100.64.12.3" },
  { ago: "2d ago", cat: "admin", actor: "you", action: "changed default key expiry", target: "90 days", ip: "100.64.12.3" },
];

const settings: any = {
  org: "Acme", subdomain: "maray", region: "sfo · us-west",
  requireApproval: true, defaultGroup: "Home lab", keyExpiry: "90 days",
  enforceExpiry: true, require2fa: false,
};

export const ROOST_DATA = { HOST, appliances, machines, keys, activity, overview, groups, acl, users, logs, settings, callers: CALLERS, LATEST_AGENT };
