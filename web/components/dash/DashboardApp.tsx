"use client";
// Finch — dashboard app shell: header, nav, live state, router.
//
// Data source: the live hub TenantState via useFinchState() (GET
// /api/finch/state). Every mutation calls the Next bridge under /api/finch/*
// and then refetch()es so the UI reflects real hub state. The view components
// are prop-driven and unchanged — only the data source + action handlers here.
import { useCallback, useEffect, useState } from 'react';
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
import type { AccessInfo } from './data';

export default function DashboardApp() {
  const { user } = useUser();
  const { state, tenants, loading, error, refetch } = useFinchState();

  const [view, setView] = useState("overview");
  const [openId, setOpenId] = useState<any>(null);
  const [layout, setLayout] = useState("table");
  const [toast, setToast] = useState<any>(null);

  const flash = (msg: any) => { setToast(msg); setTimeout(() => setToast(null), 2200); };
  const go = (v: any) => { setView(v); window.scrollTo({ top: 0 }); };

  // Deep-link: /dashboard?service=<id> opens that service's detail view
  // straight away (the menubar app links here when you click a service). The
  // id is set before services load; DetailView renders once `current` resolves.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("service");
    if (id) { setOpenId(id); setView("detail"); }
  }, []);

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
      const body: any = await res.json().catch(() => ({}));
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
  const services = state?.services ?? [];
  const keys = state?.keys ?? [];
  const logs = state?.logs ?? [];
  const users = state?.users ?? [];
  const settings = state?.settings ?? ({} as any);
  const groups = state?.groups ?? [];
  const acl = state?.acl ?? [];
  const overview = state?.overview ?? ({} as any);

  // boxes lens is derived from service state so it stays in sync; the hub
  // also flattens it into state.boxes — prefer that, fall back to derive.
  const boxes = (state?.boxes && state.boxes.length)
    ? state.boxes
    : services.flatMap((a: any) => (a.boxes || []).map((m: any) => ({ ...m, group: a.group, tags: a.tags, owner: a.owner })));

  // --- device actions ----------------------------------------------
  const openDevice = (id: any) => { setOpenId(id); go("detail"); };

  const releaseDevice = (id: any) => {
    void mutate(`/api/finch/services/${encodeURIComponent(id)}/release`,
      { method: "POST" }, `${id} deleted`, `couldn't delete ${id}`);
    if (view === "detail") go("overview");
  };

  // Returns the hub's real EnrollResp ({ id, ticket, url, install, expiresAt })
  // so EnrollView renders the real ticket + install command (no fabrication).
  const enrollDevice = async (id: any, group: any) => {
    // POST creates the 'invited' service server-side; it stays 'invited'
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
    void mutate(`/api/finch/services/${encodeURIComponent(id)}/approve`,
      { method: "POST" }, `${id} approved and online`, `couldn't approve ${id}`);

  const declineDevice = (id: any) => {
    void mutate(`/api/finch/services/${encodeURIComponent(id)}/decline`,
      { method: "POST" }, `${id} declined`, `couldn't decline ${id}`);
    if (view === "detail") go("overview");
  };

  const setTags = (id: any, tags: any) =>
    void mutate(`/api/finch/services/${encodeURIComponent(id)}/tags`,
      { method: "PUT", body: JSON.stringify({ tags }) }, undefined, `couldn't update tags`);

  // Per-box key chip (service detail view): detach a key label from a box.
  const revokeBoxKey = (appId: any, boxName: any, key: any) =>
    void mutate(`/api/finch/keys/revoke`,
      { method: "POST", body: JSON.stringify({ box: boxName, service: appId, key }) },
      "🔑 key revoked", "couldn't revoke key");

  // Push a hub→box "update" frame: the live box self-updates from the hub's
  // /releases and re-execs in place; the poll shows the new version when it
  // re-joins (~7s). Offline boxes 503 — the row keeps the copy-paste fallback.
  const updateBox = (appId: any, boxName: any) =>
    void mutate(
      `/api/finch/services/${encodeURIComponent(appId)}/boxes/${encodeURIComponent(boxName)}/update`,
      { method: "POST" },
      `⬆ update pushed to ${boxName} — it'll chirp back on the new version`,
      `couldn't update ${boxName}`,
    );

  // --- keys (the tenant-level Keys view) ---------------------------
  // Mint a real finch_ key via the hub; returns the MintKeyResp so KeysView can
  // reveal the plaintext once. Revoke by the key's stable id (not its label).
  //
  // For a minted key to actually REACH an enrolled service it must clear BOTH
  // gates in TenantDO.checkKey (worker/src/tenant-do.ts):
  //   Gate 1 (scope): the structured KeyScope must be {all:true} or list the
  //     service. We default to {all:true} so a v1 owner key works fleet-wide.
  //     (A caller MAY pass an explicit `scope` to narrow it to picked services.)
  //   Gate 2 (ACL, default-deny): some allow rule's src must match the key's
  //     OWNER identity. A fresh tenant ships ONE locked rule: user "you" -> all.
  //     The single-owner common case (no org / sole user) is that "you" owner —
  //     so we normalize a sole-owner mint to owner "you" so it matches the
  //     locked rule and the key works with ZERO extra ACL steps. In a multi-user
  //     org the picked owner is sent verbatim (the admin scopes ACL per user),
  //     so this never silently widens a multi-user tenant's access.
  const mintKey = ({ label, owner, scope }: any) => {
    return mutate(`/api/finch/keys`,
      { method: "POST", body: JSON.stringify({ label, owner, scope: scope ?? { all: true } }) },
      `🔑 key minted — ${label}`, `couldn't mint ${label}`);
  };

  const revokeKey = (k: any) =>
    void mutate(`/api/finch/keys/revoke`,
      { method: "POST", body: JSON.stringify({ id: k.id, label: k.label }) },
      "🔑 key revoked", "couldn't revoke key");

  // --- user actions (Clerk-backed via the bridge) ------------------
  const inviteUser = async ({ email, role }: any) => {
    const resp = await mutate(`/api/finch/users/invite`,
      { method: "POST", body: JSON.stringify({ email, role }) },
      undefined, `couldn't invite ${email}`);
    if (!resp) return;
    if (resp.delivery === "sent") flash(`invite sent to ${email}`);
    else if (resp.delivery === "failed") flash(`${email} was added, but invitation delivery failed — use Resend`);
    else flash(`${email} was added and can sign in`);
  };

  const setUserRole = (id: any, role: any) =>
    void mutate(`/api/finch/users/${encodeURIComponent(id)}/role`,
      { method: "POST", body: JSON.stringify({ role }) }, undefined, "couldn't set role");

  const removeUser = (id: any, revokeGrants = false) =>
    void mutate(`/api/finch/users/${encodeURIComponent(id)}`,
      { method: "DELETE", body: JSON.stringify({ revokeGrants }) }, "teammate removed", "couldn't remove teammate");
  const enableUser = (id: any) => void mutate(`/api/finch/users/${encodeURIComponent(id)}/enable`, { method: "POST", body: "{}" }, "teammate re-enabled");

  // --- access (app sharing) -----------------------------------------
  // The request queue + user grants live behind GET /api/finch/access (DO
  // listAccess), not in TenantState — fetched here, refetched after every
  // access mutation so the Access view and per-service cards stay live.
  const [access, setAccess] = useState<AccessInfo | null>(null);
  const refetchAccess = useCallback(async () => {
    try {
      const res = await fetch("/api/finch/access", { cache: "no-store" });
      if (res.ok) setAccess(await res.json());
    } catch (_) { /* non-fatal: the view renders empty */ }
  }, []);
  useEffect(() => { if (state?.callerRole === "owner" || state?.callerRole === "admin") void refetchAccess(); }, [refetchAccess, state?.callerRole]);

  // mutate() then refresh the access snapshot too (mutate only refetches state)
  const accessMutate = useCallback(async (path: string, body: any, okMsg?: string, failMsg?: string) => {
    const resp = await mutate(path, { method: "POST", body: JSON.stringify(body) }, okMsg, failMsg);
    await refetchAccess();
    return resp;
  }, [mutate, refetchAccess]);

  // Per-service Share button. A NON-member gets a pending request (approve
  // sends the Clerk invite from the Sharing tab). An existing MEMBER needs no
  // invite — chain request → approve so "Grant access" actually grants instead
  // of parking a self-addressed pending row the admin must approve elsewhere.
  const requestAccess = async (email: any, service: any, isMember?: boolean) => {
    const resp = await accessMutate(`/api/finch/access/request`, { email, service },
      isMember ? undefined : `✉ ${service} shared with ${email}`, `couldn't share ${service}`);
    const id = resp?.request?.id;
    if (isMember && id) {
      await accessMutate(`/api/finch/access/approve`, { id },
        `✓ ${service} shared with ${email}`, `couldn't grant ${service}`);
    }
  };
  const approveAccess = (id: any) =>
    void accessMutate(`/api/finch/access/approve`, { id }, "✓ access approved", "couldn't approve");
  const denyAccess = (id: any) =>
    void accessMutate(`/api/finch/access/deny`, { id }, "access denied", "couldn't deny");
  const revokeAccess = (ids: { id?: string; ruleId?: string }) =>
    void accessMutate(`/api/finch/access/revoke`, ids, "access revoked", "couldn't revoke");

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

  const current = services.find((a: any) => a.id === openId);
  const online = services.filter((a: any) => isOnline(a.state)).length;

  const isAdmin = state?.callerRole !== "member";
  const nav = isAdmin ? [
    ["overview", "Fleet"], ["home", "Observability"], ["keys", "Keys"],
    ["users", "Users"], ["access", "Access"], ["logs", "Logs"], ["settings", "Settings"],
  ] : [["overview", "Fleet"], ["home", "Observability"], ["logs", "Logs"]];
  useEffect(() => { if (!isAdmin && !["overview","home","detail","logs"].includes(view)) setView("overview"); }, [isAdmin, view]);
  const selectWorkspace = async (tenantId:string) => { const res=await fetch("/api/finch/tenants/select",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({tenantId})});if(res.ok)window.location.reload();else flash("couldn't switch workspace"); };
  const createWorkspace = async () => {
    const name = window.prompt("Workspace name")?.trim();
    if (!name) return;
    const res = await fetch("/api/finch/tenants/create", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
    const body = await res.json().catch(() => ({}));
    if (res.ok) window.location.reload(); else flash(body.error || "couldn't create workspace");
  };
  const claimWorkspace = async (clerkOrgId: string) => {
    if (!window.confirm("Import this legacy Clerk organization into Finch? Roles become a Finch-owned snapshot.")) return;
    const res = await fetch("/api/finch/tenants/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clerkOrgId }) });
    const body = await res.json().catch(() => ({}));
    if (res.ok) window.location.reload(); else flash(body.error || "couldn't claim workspace");
  };
  const chooseWorkspace = (value: string) => {
    if (value === "__create") void createWorkspace();
    else if (value.startsWith("__claim:")) void claimWorkspace(value.slice("__claim:".length));
    else void selectWorkspace(value);
  };

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
            <select aria-label="Workspace" className="role-select" value={tenants?.activeTenant ?? state?.workspace.id ?? ""} onChange={(e)=>chooseWorkspace(e.target.value)}>
              {(tenants?.tenants ?? []).map((t)=><option key={t.tenantId} value={t.tenantId} disabled={t.state!=="active"}>{t.name ?? t.tenantId} · {t.kind ?? "workspace"}</option>)}
              <option value="__create">Create workspace…</option>
              {(tenants?.claimable ?? []).map((claim)=><option key={claim.clerkOrgId} value={`__claim:${claim.clerkOrgId}`}>Claim {claim.name ?? claim.clerkOrgId}…</option>)}
            </select>
            <span className="admin-badge">{state?.callerRole ?? "member"}</span>
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
          <div className="view"><Card><p className="dim" style={{ padding: 20 }}>Loading your services…</p></Card></div>
        )}
        {!showLoading && tenants?.needsVerifiedEmail && (
          <div className="view"><Card><p className="dim" style={{ padding: 20 }}>Verify an email address to finish setting up your workspace.</p></Card></div>
        )}
        {!showLoading && error && !state && !tenants?.needsVerifiedEmail && (
          <div className="view"><Card><p className="dim" style={{ padding: 20 }}>Couldn’t load services: {error}</p></Card></div>
        )}

        {!showLoading && state && !tenants?.needsVerifiedEmail && (
          <>
            {view === "home" && (
              <HomeView services={services} boxes={boxes} overview={overview} host={host}
                onOpen={openDevice} onApprove={approveDevice} onAddDevice={onAddDevice} canManage={isAdmin} />
            )}
            {view === "overview" && (
              <FleetView services={services} boxes={boxes} overview={overview} host={host}
                groups={groups} onOpen={openDevice} onRelease={isAdmin ? releaseDevice : undefined} onAddDevice={onAddDevice}
                layout={layout} setLayout={setLayout} canManage={isAdmin} />
            )}
            {view === "detail" && current && (
              <DetailView app={current} host={host} onBack={() => go("overview")}
                onRelease={releaseDevice} onTags={setTags} onApprove={approveDevice} onDecline={declineDevice}
                onRevokeBoxKey={revokeBoxKey} onUpdateBox={updateBox}
                access={access} users={users} onShareAccess={requestAccess} canManage={isAdmin} />
            )}
            {view === "detail" && !current && (
              <div className="view"><button className="backlink" onClick={() => go("overview")}>← Fleet</button>
                <Card><p className="dim" style={{ padding: 20 }}>This service was deleted.</p></Card></div>
            )}
            {view === "enroll" && (
              <EnrollView host={host} existingIds={services.map((a: any) => a.id)} groups={groups.map((g: any) => g.name)} onEnrolled={enrollDevice} onWatch={() => go("overview")} />
            )}
            {view === "keys" && (
              <KeysView keys={keys} users={users} onMint={mintKey} onRevoke={revokeKey} />
            )}
            {view === "users" && (
              <UsersView users={users} onInvite={inviteUser} onRole={setUserRole} onRemove={removeUser} onEnable={enableUser} />
            )}
            {view === "access" && (
              <AccessView services={services} groups={groups} keys={keys} acl={acl} users={users}
                onAdd={addAcl} onRemove={removeAcl}
                requests={access?.requests ?? []} grants={access?.grants ?? []}
                onApprove={approveAccess} onDeny={denyAccess} onRevoke={revokeAccess} />
            )}
            {view === "logs" && (
              <LogsView logs={logs} />
            )}
            {view === "settings" && (
              <SettingsView settings={settings} groups={groups} services={services} onChange={updateSetting} />
            )}
          </>
        )}
      </main>

      <div className={`toast ${toast ? "toast-in" : ""}`}>{toast}</div>
    </div>
  );
}
