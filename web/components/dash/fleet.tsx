"use client";
// Roost — fleet tables (Appliance table/cards/compact + Machines) + detail.
import { useState } from 'react';
import { Avatar, Button, Card, CopyChip, InlineConfirm, MonoUrl, SectionLabel, StatePill, TagList, isOnline } from '@/components/dash/primitives';
import { AreaChart } from '@/components/dash/charts';
import { LATEST_AGENT } from '@/components/dash/data';

function mcpUrl(host: any, id: any) { return `https://${host}/${id}/mcp`; }
function machineUrl(host: any, id: any, machine: any) { return `https://${host}/${id}/${machine}/mcp`; }
const mdot = (st: any) => isOnline(st) ? "on" : st === "pending" ? "inv" : "off";

// out-of-date / version badge
function VersionTag({ a }: any) {
  if (a.state === "invited") return null;
  return a.outdated
    ? <span className="ver-badge out" title={`update available — latest v${LATEST_AGENT}`}>⬆ v{a.version} · update</span>
    : <span className="ver-badge mono">v{a.version}</span>;
}
function MachineCount({ a }: any) {
  if (!a.machineCount) return null;
  return <span className="m-count">{a.machineCount} machine{a.machineCount > 1 ? "s" : ""}</span>;
}

// ---- Appliances · dense table ------------------------------------
export function FleetTable({ apps, host, onOpen, onRelease, head = true }: any) {
  return (
    <Card className="table-card">
      {head && (
        <div className="frow frow-head">
          <span className="c-app">appliance</span>
          <span className="c-state">state</span>
          <span className="c-url">mcp endpoint</span>
          <span className="c-owner">owner · created</span>
          <span className="c-act"></span>
        </div>
      )}
      {apps.map((a: any) => (
        <div key={a.id} className="frow" onClick={() => onOpen(a.id)}>
          <span className="c-app">
            <Avatar state={a.state} size={30} />
            <span className="app-idwrap">
              <span className="app-id mono">{a.id}</span>
              <span className="app-sub">
                <VersionTag a={a} />
                <MachineCount a={a} />
                <TagList tags={a.tags} />
              </span>
            </span>
          </span>
          <span className="c-state"><StatePill state={a.state} /></span>
          <span className="c-url">
            {a.state === "invited"
              ? <span className="url-pending mono">waiting to fly home…</span>
              : <MonoUrl url={mcpUrl(host, a.id)} onClick={(e: any) => e.stopPropagation()} />}
          </span>
          <span className="c-owner mono">
            <span className={a.owner === "you" ? "own-you" : "own-other"}>{a.owner}</span>
            <span className="dim"> · {a.created}</span>
          </span>
          <span className="c-act">
            <InlineConfirm onConfirm={(e: any) => { e.stopPropagation(); onRelease(a.id); }} />
          </span>
        </div>
      ))}
    </Card>
  );
}

// ---- Appliances · roomy cards ------------------------------------
export function FleetCards({ apps, host, onOpen, onRelease }: any) {
  return (
    <div className="cardgrid">
      {apps.map((a: any) => (
        <Card key={a.id} className="appcard" onClick={() => onOpen(a.id)}>
          <div className="appcard-top">
            <Avatar state={a.state} size={40} />
            <div className="appcard-id">
              <span className="app-id mono">{a.id}</span>
              <span className="appcard-box dim">{a.machineCount ? `${a.machineCount} machine${a.machineCount > 1 ? "s" : ""}` : "no machines"}{a.state !== "invited" ? <> · <VersionTag a={a} /></> : null}</span>
            </div>
            <StatePill state={a.state} />
          </div>
          <p className="appcard-blurb">{a.blurb}</p>
          {a.tags && a.tags.length > 0 && <TagList tags={a.tags} />}
          {a.state === "invited"
            ? <div className="url-pending mono appcard-url">🎟 waiting to fly home…</div>
            : <MonoUrl url={mcpUrl(host, a.id)} onClick={(e: any) => e.stopPropagation()} />}
          <div className="appcard-foot">
            <span className="mono dim">
              <span className={a.owner === "you" ? "own-you" : "own-other"}>{a.owner}</span> · {a.created}
            </span>
            <InlineConfirm onConfirm={(e: any) => { e.stopPropagation(); onRelease(a.id); }} />
          </div>
        </Card>
      ))}
    </div>
  );
}

// ---- Appliances · compact ----------------------------------------
export function FleetCompact({ apps, host, onOpen, onRelease }: any) {
  return (
    <Card className="compact-card">
      {apps.map((a: any) => (
        <div key={a.id} className="crow" onClick={() => onOpen(a.id)}>
          <span className={`crow-dot crow-${mdot(a.state)}`} />
          <span className="app-id mono crow-id">{a.id}</span>
          <StatePill state={a.state} />
          {a.machineCount ? <span className="m-count">{a.machineCount}×</span> : null}
          {a.outdated && <span className="ver-badge out crow-ver" title={`update to v${LATEST_AGENT}`}>⬆</span>}
          <span className="crow-spacer" />
          {a.state !== "invited" && <CopyChip value={mcpUrl(host, a.id)} label="copy url" />}
        </div>
      ))}
    </Card>
  );
}

// ---- Machines · flat node list (Tailscale lens) ------------------
export function MachinesTable({ machines, host, onOpen, query }: any) {
  if (!machines.length) {
    return <Card className="group-empty"><div className="dim">{query ? `No machines match “${query}”.` : "No machines yet."}</div></Card>;
  }
  return (
    <Card className="table-card">
      <div className="mrow mrow-head">
        <span>machine</span><span>appliance</span><span>address</span><span>version</span><span>last seen</span><span>status</span>
      </div>
      {machines.map((m: any) => (
        <div key={m.name} className="mrow" onClick={() => onOpen(m.appliance)}>
          <span className="m-machine">
            <span className={`crow-dot crow-${mdot(m.state)}`} />
            <span className="m-id"><span className="mono m-name">{m.name}</span><span className="dim m-os">{m.os}</span></span>
          </span>
          <span className="m-appliance"><span className="ent ent-appliance">{m.appliance}</span></span>
          <span className="m-addr mono dim">{m.address}</span>
          <span className="m-ver">{m.outdated ? <span className="ver-badge out">⬆ v{m.version}</span> : <span className="ver-badge mono">v{m.version}</span>}</span>
          <span className="m-seen mono dim">{m.lastSeen}</span>
          <span className="m-status"><StatePill state={m.state} /></span>
        </div>
      ))}
    </Card>
  );
}

// ============ APPLIANCE DETAIL ====================================
export function DetailView({ app, host, onBack, onRelease, onTags, onApprove, onDecline, onRevokeMachineKey }: any) {
  const [tab, setTab] = useState("claude");
  const [newTag, setNewTag] = useState("");
  const url = mcpUrl(host, app.id);
  const online = isOnline(app.state);

  const addTag = () => {
    const t = newTag.trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
    if (!t || (app.tags || []).includes(t)) { setNewTag(""); return; }
    onTags(app.id, [...(app.tags || []), t]);
    setNewTag("");
  };

  const snippets: any = {
    claude: `claude mcp add ${app.id} ${url}`,
    cursor: `# ~/.cursor/mcp.json\n{\n  "mcpServers": {\n    "${app.id}": { "url": "${url}" }\n  }\n}`,
    json: `{\n  "mcpServers": {\n    "${app.id}": {\n      "url": "${url}",\n      "transport": "http"\n    }\n  }\n}`,
  };

  return (
    <div className="view">
      <button className="backlink" onClick={onBack}>← Fleet</button>

      <Card className="detail-head">
        <Avatar state={app.state} size={52} />
        <div className="detail-head-mid">
          <div className="detail-id-row">
            <h1 className="app-id mono detail-id">{app.id}</h1>
            <StatePill state={app.state} />
            <span className="group-tag">{app.group}</span>
          </div>
          <p className="detail-meta mono dim">
            {app.machineCount} machine{app.machineCount === 1 ? "" : "s"} · owner <span className={app.owner === "you" ? "own-you" : "own-other"}>{app.owner}</span>
            {" · "}{online ? `up ${app.uptime}` : `last seen ${app.lastSeen}`}
          </p>
        </div>
        <div className="detail-head-stats">
          <Stat n={app.calls.toLocaleString()} l="calls" />
          <Stat n={online ? `${app.p50}ms` : "—"} l="p50" />
          <Stat n={online ? `${app.err}%` : "—"} l="errors" />
        </div>
      </Card>

      <div className="detail-grid">
        {app.state === "pending" && (
          <Card className="approve-card connect-card">
            <div className="update-row">
              <span className="update-ic approve-ic">⏳</span>
              <div className="update-body">
                <div className="update-title">Waiting for admin approval</div>
                <div className="update-sub dim"><b className="mono">{app.id}</b> connected and is ready to serve. Approve it to let traffic through, or decline to remove it.</div>
                <div className="approve-actions">
                  <Button kind="accent" size="md" onClick={() => onApprove(app.id)}>Approve device</Button>
                  <Button kind="ghost" size="md" onClick={() => onDecline(app.id)}>Decline</Button>
                </div>
              </div>
            </div>
          </Card>
        )}

        {/* Connect */}
        <Card className="connect-card">
          <SectionLabel hint={app.machineCount > 1 ? "load-balanced across every healthy machine" : "paste this URL into any MCP client"}>connect</SectionLabel>
          {app.state === "invited"
            ? <div className="url-pending mono big-pending">🎟 ticket minted — waiting for the box to phone home…</div>
            : <MonoUrl url={url} hero />}
          <div className="client-tabs">
            {[["claude", "Claude"], ["cursor", "Cursor"], ["json", "raw JSON"]].map(([k, lbl]) => (
              <button key={k} className={`ctab ${tab === k ? "ctab-on" : ""}`} onClick={() => setTab(k)}>{lbl}</button>
            ))}
          </div>
          <div className="snippet">
            <pre className="mono">{snippets[tab]}</pre>
            <CopyChip value={snippets[tab]} className="snippet-copy" />
          </div>
        </Card>

        {/* Traffic */}
        <Card className="chart-card connect-card">
          <div className="chart-head">
            <div>
              <div className="chart-title">Requests / hour</div>
              <div className="chart-sub dim">across all machines · last 24 hours{online ? " · live" : ""}</div>
            </div>
            <div className="chart-stats">
              <div className="stat"><div className="stat-n mono">{app.calls.toLocaleString()}</div><div className="stat-l">calls</div></div>
              <div className="stat"><div className="stat-n mono">{online ? app.p50 + "ms" : "—"}</div><div className="stat-l">p50</div></div>
              <div className="stat"><div className="stat-n mono">{online ? app.p95 + "ms" : "—"}</div><div className="stat-l">p95</div></div>
              <div className="stat"><div className="stat-n mono">{online ? app.err + "%" : "—"}</div><div className="stat-l">errors</div></div>
            </div>
          </div>
          {online
            ? <>
                <AreaChart values={app.traffic24h} color="#f2b443" h={150} />
                <div className="chart-axis">{["-24h", "-18h", "-12h", "-6h", "now"].map((t) => <span key={t} className="x-tick">{t}</span>)}</div>
              </>
            : <div className="url-pending mono big-pending">🌙 resting — no live traffic to show.</div>}
        </Card>

        {/* Machines */}
        <Card className="machines-card connect-card">
          <SectionLabel hint="boxes serving this appliance · revoke keys here">machines</SectionLabel>
          {app.machines.length ? app.machines.map((m: any) => (
            <div key={m.name} className="mach">
              <div className="mach-head">
                <span className={`crow-dot crow-${mdot(m.state)}`} />
                <span className="mach-name mono">{m.name}</span>
                <span className="mach-os dim">{m.os}</span>
                {m.outdated ? <span className="ver-badge out">⬆ v{m.version}</span> : <span className="ver-badge mono">v{m.version}</span>}
                <span className="mach-spacer" />
                <StatePill state={m.state} />
              </div>
              <MonoUrl url={machineUrl(host, app.id, m.name)} />
              <div className="mach-foot">
                <span className="mach-keys">
                  <span className="auth-sub dim">keys</span>
                  {m.keys.length ? m.keys.map((k: any) => (
                    <span key={k} className="kchip mono">🔑 {k}<button className="tag-x" title="revoke" onClick={() => onRevokeMachineKey(app.id, m.name, k)}>×</button></span>
                  )) : <span className="dim">none</span>}
                </span>
                {m.outdated && <span className="mach-update mono">finch update <CopyChip value="finch update" /></span>}
              </div>
            </div>
          )) : <div className="dim">No machines yet — this appliance is waiting for a box to phone home.</div>}
        </Card>

        {/* Auth + tags */}
        <Card className="auth-card">
          <SectionLabel hint="enforced at the hub, before traffic reaches the box">auth</SectionLabel>
          <div className="auth-row"><span className="dim">OAuth</span><span className="auth-ok">● WorkOS connected</span></div>
          <div className="auth-row"><span className="dim">policy</span><span className="mono">allow: listed keys</span></div>
          <div className="auth-tags">
            <span className="auth-sub dim">tags</span>
            <TagList tags={app.tags} onRemove={(t: any) => onTags(app.id, app.tags.filter((x: any) => x !== t))} />
            <span className="tag-add">
              <input value={newTag} onChange={(e) => setNewTag(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") addTag(); }}
                placeholder="add tag" spellCheck={false} autoCapitalize="off" />
              <button onClick={addTag} title="add tag">＋</button>
            </span>
          </div>
        </Card>

        {/* Recent calls */}
        <Card className="calls-card">
          <SectionLabel hint="newest first">recent calls</SectionLabel>
          {online && app.recentCalls.length ? app.recentCalls.map((c: any, i: number) => (
            <div key={i} className="call-row">
              <span className={`feed-status ${c.status < 300 ? "fs-ok" : c.status < 500 ? "fs-warn" : "fs-err"}`}>{c.status}</span>
              <span className="feed-caller mono">{c.caller}</span>
              <span className="feed-arrow">→</span>
              <span className="feed-route mono dim">{c.route}</span>
              <span className="feed-spacer" />
              <span className="feed-ms mono dim">{c.ms}ms</span>
              <span className="act-time mono dim">{c.ago}</span>
            </div>
          )) : <div className="dim">no calls while resting.</div>}
        </Card>

        {/* Danger */}
        <Card className="danger-card">
          <SectionLabel>danger zone</SectionLabel>
          <div className="danger-row">
            <div>
              <div className="danger-title">Release this appliance</div>
              <div className="dim danger-sub">Removes it and every machine from the roost and revokes their credentials. The boxes keep the code.</div>
            </div>
            <InlineConfirm prompt="set free?" trigger="release" onConfirm={() => onRelease(app.id)} />
          </div>
        </Card>
      </div>
    </div>
  );
}

function Stat({ n, l }: any) {
  return (
    <div className="stat">
      <div className="stat-n mono">{n}</div>
      <div className="stat-l">{l}</div>
    </div>
  );
}
