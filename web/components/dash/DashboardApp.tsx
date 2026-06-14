"use client";
// Finch — dashboard app shell: header, nav, live state, router.
//
// Data source: the live hub TenantState via useFinchState() (GET
// /api/finch/state). Every mutation calls the Next bridge under /api/finch/*
// and then refetch()es so the UI reflects real hub state. The view components
// are prop-driven and unchanged — only the data source + action handlers here.
import { useCallback, useState } from 'react';
import { UserButton, useUser } from '@clerk/nextjs';
import { HomeView } from './home';
import { FleetView } from './overview';
import { DetailView } from './fleet';
import { EnrollView, KeysView } from './panels';
import { UsersView } from './users';
import { AccessView } from './access';
import { LogsView } from './logs';
import { SettingsView } from './settings';
import { isOnline, Card } from './primitives';
import { useFinchState } from './useFinchState';

export default function DashboardApp() {
  const { user } = useUser();
  const { state, loading, error, refetch } = useFinchState();

  const [view, setView] = useState("overview");
  const [openId, setOpenId] = useState<any>(null);
  const [layout, setLayout] = useState("table");
  const [toast, setToast] = useState<any>(null);

  const flash = (msg: any) => { setToast(msg); setTimeout(() => setToast(null), 2200); };
  const go = (v: any) => { setView(v); window.scrollTo({ top: 0 }); };

  // POST/PUT/DELETE a bridge endpoint, then refetch live state. Returns the
  // parsed JSON body so callers can read minted secrets / install strings.
  const mutate = useCallback(async (
    path: string,
    init: RequestInit,
    okMsg?: string,
    failMsg?: string,
  ): Promise<any | null> => {
    try {
      const res = await fetch(path, {
        ...init,
        headers: { "content-type": "application/json", ...(init.headers || {}) },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        flash(`⚠ ${body?.error || failMsg || "something went wrong"}`);
        return null;
      }
      await refetch();
      if (okMsg) flash(okMsg);
      return body;
    } catch (e) {
      flash(`⚠ ${failMsg || (e instanceof Error ? e.message : "request failed")}`);
      return null;
    }
  }, [refetch]);

  // ----- live state (with safe fallbacks while loading) -------------
  const host = state?.host ?? "";
  const appliances = state?.appliances ?? [];
  const keys = state?.keys ?? [];
  const logs = state?.logs ?? [];
  const users = state?.users ?? [];
  const settings = state?.settings ?? ({} as any);
  const groups = state?.groups ?? [];
  const acl = state?.acl ?? [];
  const overview = state?.overview ?? ({} as any);

  // machines lens is derived from appliance state so it stays in sync; the hub
  // also flattens it into state.machines — prefer that, fall back to derive.
  const machines = (state?.machines && state.machines.length)
    ? state.machines
    : appliances.flatMap((a: any) => (a.machines || []).map((m: any) => ({ ...m, group: a.group, tags: a.tags, owner: a.owner })));

  // --- device actions ----------------------------------------------
  const openDevice = (id: any) => { setOpenId(id); go("detail"); };

  const releaseDevice = (id: any) => {
    void mutate(`/api/finch/appliances/${encodeURIComponent(id)}/release`,
      { method: "POST" }, `🕊 ${id} set free`, `couldn't release ${id}`);
    if (view === "detail") go("overview");
  };

  // Returns the hub's real EnrollResp ({ id, ticket, url, install, expiresAt })
  // so EnrollView renders the real ticket + install command (no fabrication).
  const enrollDevice = async (id: any, group: any) => {
    // POST creates the 'invited' appliance server-side; it stays 'invited'
    // until the agent joins. refetch surfaces it.
    const resp = await mutate(
      `/api/finch/enroll`,
      { method: "POST", body: JSON.stringify({ name: id, group }) },
      undefined,
      `couldn't enroll ${id}`,
    );
    if (resp?.ticket) flash(`🎟 ${id} enrolled — install ready`);
    return resp;
  };

  const approveDevice = (id: any) =>
    void mutate(`/api/finch/appliances/${encodeURIComponent(id)}/approve`,
      { method: "POST" }, `🐦 ${id} approved — now chirping`, `couldn't approve ${id}`);

  const declineDevice = (id: any) => {
    void mutate(`/api/finch/appliances/${encodeURIComponent(id)}/decline`,
      { method: "POST" }, `${id} declined`, `couldn't decline ${id}`);
    if (view === "detail") go("overview");
  };

  const setTags = (id: any, tags: any) =>
    void mutate(`/api/finch/appliances/${encodeURIComponent(id)}/tags`,
      { method: "PUT", body: JSON.stringify({ tags }) }, undefined, `couldn't update tags`);

  // Per-machine key chip (appliance detail view): detach a key label from a box.
  const revokeMachineKey = (appId: any, machineName: any, key: any) =>
    void mutate(`/api/finch/keys/revoke`,
      { method: "POST", body: JSON.stringify({ machine: machineName, appliance: appId, key }) },
      "🔑 key revoked", "couldn't revoke key");

  // --- keys (the tenant-level Keys view) ---------------------------
  // Mint a real finch_ key via the hub; returns the MintKeyResp so KeysView can
  // reveal the plaintext once. Revoke by the key's stable id (not its label).
  const mintKey = ({ label, owner }: any) =>
    mutate(`/api/finch/keys`,
      { method: "POST", body: JSON.stringify({ label, owner }) },
      `🔑 key minted — ${label}`, `couldn't mint ${label}`);

  const revokeKey = (k: any) =>
    void mutate(`/api/finch/keys/revoke`,
      { method: "POST", body: JSON.stringify({ id: k.id, label: k.label }) },
      "🔑 key revoked", "couldn't revoke key");

  // --- user actions (Clerk-backed via the bridge) ------------------
  const inviteUser = ({ email, role }: any) =>
    void mutate(`/api/finch/users/invite`,
      { method: "POST", body: JSON.stringify({ email, role }) },
      `✉ invite sent to ${email}`, `couldn't invite ${email}`);

  const setUserRole = (id: any, role: any) =>
    void mutate(`/api/finch/users/${encodeURIComponent(id)}/role`,
      { method: "POST", body: JSON.stringify({ role }) }, undefined, "couldn't set role");

  const removeUser = (id: any) =>
    void mutate(`/api/finch/users/${encodeURIComponent(id)}`,
      { method: "DELETE" }, "teammate removed", "couldn't remove teammate");

  // --- access (ACL) ------------------------------------------------
  const addAcl = (src: any, dst: any) =>
    void mutate(`/api/finch/acl`,
      { method: "POST", body: JSON.stringify({ src, dst }) }, "✓ rule added", "couldn't add rule");
  const removeAcl = (id: any) =>
    void mutate(`/api/finch/acl/${encodeURIComponent(id)}`,
      { method: "DELETE" }, "rule removed", "couldn't remove rule");

  const updateSetting = (key: any, val: any) =>
    void mutate(`/api/finch/settings`,
      { method: "PUT", body: JSON.stringify({ key, val }) }, undefined, `couldn't update ${key}`);

  const onAddDevice = () => go("enroll");

  const current = appliances.find((a: any) => a.id === openId);
  const online = appliances.filter((a: any) => isOnline(a.state)).length;

  const nav = [
    ["overview", "Fleet"], ["home", "Observability"], ["keys", "Keys"],
    ["users", "Users"], ["access", "Access"], ["logs", "Logs"], ["settings", "Settings"],
  ];

  // ----- loading / error gate --------------------------------------
  const showLoading = loading && !state;

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href="/" title="finchmcp.com">
            <span className="brand-mark">🐦</span>
            <span className="brand-name">Finch</span>
            {host && <span className="host-chip mono">{host}</span>}
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
        {showLoading && (
          <div className="view"><Card><p className="dim" style={{ padding: 20 }}>Loading your flock…</p></Card></div>
        )}
        {!showLoading && error && !state && (
          <div className="view"><Card><p className="dim" style={{ padding: 20 }}>Couldn’t load your flock — {error}</p></Card></div>
        )}

        {!showLoading && state && (
          <>
            {view === "home" && (
              <HomeView appliances={appliances} machines={machines} overview={overview} host={host}
                onOpen={openDevice} onApprove={approveDevice} onAddDevice={onAddDevice} />
            )}
            {view === "overview" && (
              <FleetView appliances={appliances} machines={machines} overview={overview} host={host}
                groups={groups} onOpen={openDevice} onRelease={releaseDevice} onAddDevice={onAddDevice}
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
              <EnrollView host={host} existingIds={appliances.map((a: any) => a.id)} groups={groups.map((g: any) => g.name)} onEnrolled={enrollDevice} onWatch={() => go("overview")} />
            )}
            {view === "keys" && (
              <KeysView keys={keys} users={users} onMint={mintKey} onRevoke={revokeKey} />
            )}
            {view === "users" && (
              <UsersView users={users} onInvite={inviteUser} onRole={setUserRole} onRemove={removeUser} />
            )}
            {view === "access" && (
              <AccessView appliances={appliances} groups={groups} keys={keys} acl={acl} users={users}
                onAdd={addAcl} onRemove={removeAcl} />
            )}
            {view === "logs" && (
              <LogsView logs={logs} />
            )}
            {view === "settings" && (
              <SettingsView settings={settings} groups={groups} onChange={updateSetting} />
            )}
          </>
        )}
      </main>

      <div className={`toast ${toast ? "toast-in" : ""}`}>{toast}</div>
    </div>
  );
}
