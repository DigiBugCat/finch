"use client";
// Roost — app shell: header, nav, shared state, router.
import { useState } from 'react';
import { UserButton, useUser } from '@clerk/nextjs';
import { HomeView } from './home';
import { FleetView } from './overview';
import { DetailView } from './fleet';
import { EnrollView } from './panels';
import { UsersView } from './users';
import { AccessView } from './access';
import { LogsView } from './logs';
import { SettingsView } from './settings';
import { isOnline, Card } from './primitives';
import { ROOST_DATA } from './data';

const LOG_CAT: any = {
  enroll: "device", online: "device", offline: "device", release: "device",
  approve: "device", decline: "device", revoke: "key", keymint: "key",
  invite: "admin", role: "admin", setting: "admin", access: "access",
};

export default function DashboardApp() {
  const { user } = useUser();
  const D = ROOST_DATA;
  const host = D.HOST;

  const [appliances, setAppliances] = useState(D.appliances);
  const [keys] = useState(D.keys);
  const [logs, setLogs] = useState(D.logs);
  const [users, setUsers] = useState(D.users);
  const [settings, setSettings] = useState(D.settings);

  const [view, setView] = useState("overview");
  const [openId, setOpenId] = useState<any>(null);
  const [layout, setLayout] = useState("table");
  const [toast, setToast] = useState<any>(null);

  const flash = (msg: any) => { setToast(msg); setTimeout(() => setToast(null), 2200); };
  const go = (v: any) => { setView(v); window.scrollTo({ top: 0 }); };

  const log = (kind: any, actor: any, action: any, target: any) =>
    setLogs((l: any) => [{ ago: "just now", cat: LOG_CAT[kind] || "admin", actor, action, target: target || "", ip: "100.64.12.3" }, ...l]);

  // machines lens is derived from appliance state so it stays in sync
  const machines = appliances.flatMap((a: any) => (a.machines || []).map((m: any) => ({ ...m, group: a.group, tags: a.tags, owner: a.owner })));

  // --- device actions ----------------------------------------------
  const openDevice = (id: any) => { setOpenId(id); go("detail"); };

  const releaseDevice = (id: any) => {
    setAppliances((list: any) => list.filter((a: any) => a.id !== id));
    log("release", "you", "released", id);
    flash(`🕊 ${id} set free`);
    if (view === "detail") go("overview");
  };

  const makeMachine = (id: any, state: any) => ({
    name: `${id}-pi`, os: "Raspberry Pi OS", version: D.LATEST_AGENT, state,
    appliance: id, applianceLabel: id, keys: [], address: "100.99.0.1",
    outdated: false, lastSeen: "now", relay: "sfo · us-west", handshake: "now",
  });

  const enrollDevice = (id: any, group: any) => {
    const requireApproval = settings.requireApproval;
    const appliance = {
      id, label: id, state: "invited", owner: "you", box: "—",
      created: "just now", lastSeen: "never", uptime: "—",
      calls: 0, p50: 0, p95: 0, err: 0,
      group: group || settings.defaultGroup || "Home lab", version: D.LATEST_AGENT, outdated: false, tags: [],
      machines: [], machineCount: 0, routes: ["/call"], traffic24h: Array(24).fill(0), lat24h: [], recentCalls: [],
      conn: { relay: "—", version: `finch-agent ${D.LATEST_AGENT}`, address: "—", handshake: "never", protocol: "pending" },
      blurb: "Ticket minted — waiting for the box to phone home.", components: [], keys: [],
    };
    setAppliances((list: any) => [appliance, ...list.filter((a: any) => a.id !== id)]);
    log("enroll", "you", "enrolled", id);
    setTimeout(() => {
      const st = requireApproval ? "pending" : "chirping";
      setAppliances((list: any) => list.map((a: any) => a.id === id ? {
        ...a, state: st, box: "Raspberry Pi 5", lastSeen: "now", uptime: requireApproval ? "—" : "0d 0h",
        machines: [makeMachine(id, st)], machineCount: 1,
        blurb: requireApproval ? "Connected — waiting for an admin to approve it." : "Just connected — serving its first calls.",
      } : a));
      if (requireApproval) { log("device", id, "requested approval", ""); flash(`⏳ ${id} connected — awaiting approval`); }
      else { log("online", id, "started chirping", ""); flash(`🐦 ${id} flew home — now chirping`); }
    }, 4200);
  };

  const approveDevice = (id: any) => {
    setAppliances((list: any) => list.map((a: any) => a.id === id ? {
      ...a, state: "chirping", uptime: "0d 0h", blurb: "Just connected — serving its first calls.",
      machines: (a.machines || []).map((m: any) => ({ ...m, state: "chirping" })),
    } : a));
    log("approve", "you", "approved", id);
    flash(`🐦 ${id} approved — now chirping`);
  };
  const declineDevice = (id: any) => {
    setAppliances((list: any) => list.filter((a: any) => a.id !== id));
    log("decline", "you", "declined", id);
    flash(`${id} declined`);
    if (view === "detail") go("overview");
  };

  const setTags = (id: any, tags: any) => setAppliances((list: any) => list.map((a: any) => a.id === id ? { ...a, tags } : a));

  const revokeMachineKey = (appId: any, machineName: any, key: any) => {
    setAppliances((list: any) => list.map((a: any) => a.id === appId
      ? { ...a, machines: a.machines.map((m: any) => m.name === machineName ? { ...m, keys: m.keys.filter((k: any) => k !== key) } : m) }
      : a));
    log("revoke", "you", "revoked key", `${key} · ${machineName}`);
    flash("🔑 key revoked");
  };

  // --- user actions ------------------------------------------------
  const inviteUser = ({ email, role }: any) => {
    const name = email.split("@")[0];
    setUsers((us: any) => [...us, { id: "u" + Date.now(), name, email, role, devices: 0, lastActive: "—", status: "invited" }]);
    log("invite", "you", "invited", email);
    flash(`✉ invite sent to ${email}`);
  };
  const setUserRole = (id: any, role: any) => {
    setUsers((us: any) => us.map((u: any) => u.id === id ? { ...u, role } : u));
    const u = users.find((x: any) => x.id === id);
    log("role", "you", "set role", `${u ? u.name : id} → ${role}`);
  };
  const removeUser = (id: any) => {
    const u = users.find((x: any) => x.id === id);
    setUsers((us: any) => us.filter((x: any) => x.id !== id));
    if (u) log("role", "you", "removed", u.name);
    flash("teammate removed");
  };

  const updateSetting = (key: any, val: any) => {
    setSettings((s: any) => ({ ...s, [key]: val }));
    log("setting", "you", "changed", key);
  };

  const onAddDevice = () => go("enroll");

  const current = appliances.find((a: any) => a.id === openId);
  const online = appliances.filter((a: any) => isOnline(a.state)).length;

  const nav = [
    ["overview", "Fleet"], ["home", "Observability"], ["users", "Users"],
    ["access", "Access"], ["logs", "Logs"], ["settings", "Settings"],
  ];

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href="/" title="finchmcp.com">
            <span className="brand-mark">🐦</span>
            <span className="brand-name">Finch</span>
            <span className="host-chip mono">{host}</span>
          </a>
          <div className="user">
            <span className="admin-badge">admin</span>
            <span className="user-name">{user?.firstName || user?.username || 'you'}</span>
            <UserButton />
          </div>
        </div>
        <div className="topbar-nav">
          <div className="topbar-nav-inner">
            <nav className="nav">
              {nav.map(([v, lbl]) => (
                <button key={v} className={`nav-item ${(view === v || (v === "overview" && view === "detail")) ? "nav-on" : ""}`} onClick={() => go(v)}>
                  {lbl}
                  {v === "overview" && <span className="nav-badge mono">{online}</span>}
                </button>
              ))}
            </nav>
          </div>
        </div>
      </header>

      <main className="main">
        {view === "home" && (
          <HomeView appliances={appliances} machines={machines} overview={D.overview} host={host}
            onOpen={openDevice} onApprove={approveDevice} onAddDevice={onAddDevice} />
        )}
        {view === "overview" && (
          <FleetView appliances={appliances} machines={machines} overview={D.overview} host={host}
            groups={D.groups} onOpen={openDevice} onRelease={releaseDevice} onAddDevice={onAddDevice}
            layout={layout} setLayout={setLayout} />
        )}
        {view === "detail" && current && (
          <DetailView app={current} host={host} onBack={() => go("overview")}
            onRelease={releaseDevice} onTags={setTags} onApprove={approveDevice} onDecline={declineDevice}
            onRevokeMachineKey={revokeMachineKey} />
        )}
        {view === "detail" && !current && (
          <div className="view"><button className="backlink" onClick={() => go("overview")}>← Fleet</button>
            <Card><p className="dim" style={{ padding: 20 }}>This appliance has left the roost.</p></Card></div>
        )}
        {view === "enroll" && (
          <EnrollView host={host} existingIds={appliances.map((a: any) => a.id)} groups={D.groups.map((g: any) => g.name)} onEnrolled={enrollDevice} onWatch={() => go("overview")} />
        )}
        {view === "users" && (
          <UsersView users={users} onInvite={inviteUser} onRole={setUserRole} onRemove={removeUser} />
        )}
        {view === "access" && (
          <AccessView appliances={appliances} groups={D.groups} keys={keys} acl={D.acl} />
        )}
        {view === "logs" && (
          <LogsView logs={logs} />
        )}
        {view === "settings" && (
          <SettingsView settings={settings} onChange={updateSetting} />
        )}
      </main>

      <div className={`toast ${toast ? "toast-in" : ""}`}>{toast}</div>
    </div>
  );
}
