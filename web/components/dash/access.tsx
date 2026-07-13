"use client";
// Roost — Access: app sharing (request queue + user grants), ACL rules
// (by tag / group / key), and the generated raw policy.
import { useState } from 'react';
import { Button, Card, CopyChip, EntityChip, InlineConfirm, SectionLabel } from '@/components/dash/primitives';

function tokenSrc(s: any) {
  if (s.type === "user") return `${s.name}@finch`;
  if (s.type === "group") return `group:${s.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
  if (s.type === "key") return `key:${s.name}`;
  return s.name;
}
function tokenDst(d: any) {
  if (d.type === "all") return "*";
  if (d.type === "tag") return `tag:${d.name}`;
  if (d.type === "group") return `group:${d.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
  return d.name; // service
}

// status → chip class (Sharing tables + per-service card in fleet.tsx)
export function AccessChip({ status }: any) {
  return <span className={`axs-chip axs-${status}`}>{status}</span>;
}

// ---- Sharing — pending requests + per-user grants ----------------
function SharingTab({ requests, grants, onApprove, onDeny, onRevoke }: any) {
  const open = requests.filter((r: any) => r.status === "pending" || r.status === "invited");
  return (
    <>
      <Card className="table-card">
        <SectionLabel hint="approve to grant the app — non-members get a Clerk invite first">pending requests</SectionLabel>
        {open.length ? (
          <>
            <div className="arow arow-head">
              <span>who</span><span>app</span><span>requested by</span><span>status</span><span></span>
            </div>
            {open.map((r: any) => (
              <div key={r.id} className="arow">
                <span className="mono">{r.email}</span>
                <span><EntityChip ent={{ type: "service", name: r.service }} /></span>
                <span className="mono dim">{r.requestedBy}</span>
                <span>
                  <AccessChip status={r.status} />
                  {r.status === "invited" && <span className="dim axs-note">awaiting join</span>}
                </span>
                <span className="a-act">
                  {r.status === "pending"
                    ? <>
                        <Button kind="accent" size="sm" onClick={() => onApprove?.(r.id)}>Approve</Button>
                        <Button kind="ghost" size="sm" onClick={() => onDeny?.(r.id)}>Deny</Button>
                      </>
                    : <InlineConfirm prompt="revoke?" trigger="revoke" onConfirm={() => onRevoke?.({ id: r.id })} />}
                </span>
              </div>
            ))}
          </>
        ) : <div className="dim group-empty-pad">No pending requests.</div>}
      </Card>

      <Card className="table-card">
        <SectionLabel hint="per-user app grants — enforced at the door">grants</SectionLabel>
        {grants.length ? (
          <>
            <div className="arow arow-grant arow-head">
              <span>who</span><span>app</span><span></span>
            </div>
            {grants.map((g: any) => (
              <div key={g.id} className="arow arow-grant">
                <span><EntityChip ent={g.src} /></span>
                <span className="rule-dsts">{g.dst.map((d: any, i: number) => <EntityChip key={i} ent={d} />)}</span>
                <span className="a-act">
                  <InlineConfirm prompt="revoke?" trigger="revoke" onConfirm={() => onRevoke?.({ ruleId: g.id })} />
                </span>
              </div>
            ))}
          </>
        ) : <div className="dim group-empty-pad">No user grants yet — share an app from its detail page.</div>}
      </Card>
    </>
  );
}

export function AccessView({ services, groups, keys, acl, users, onAdd, onRemove, requests = [], grants = [], onApprove, onDeny, onRevoke }: any) {
  const [mode, setMode] = useState("sharing"); // sharing | rules | policy
  const [dst, setDst] = useState<any[]>([]);

  const allTags = [...new Set(services.flatMap((a: any) => a.tags || []))];
  // Real Clerk members (from /api/finch/state) — not a hardcoded phantom list.
  const userNames: string[] = (users || []).map((u: any) => u.name).filter(Boolean);
  const keyNames = keys.map((k: any) => k.label);
  const groupNames = (groups || []).map((g: any) => g.name);

  // Source dropdown seeded from real entities; default to the first real user.
  const [srcVal, setSrcVal] = useState(
    userNames.length ? `user:${userNames[0]}` : "",
  );

  const targetOptions = [
    ...allTags.map((t: any) => ({ type: "tag", name: t })),
    ...groupNames.map((g: any) => ({ type: "group", name: g })),
  ];
  const inDst = (o: any) => dst.some((d) => d.type === o.type && d.name === o.name);
  const toggleDst = (o: any) => setDst((d) => inDst(o) ? d.filter((x) => !(x.type === o.type && x.name === o.name)) : [...d, o]);

  const addRule = () => {
    if (!dst.length || !srcVal) return;
    const idx = srcVal.indexOf(":");
    const src = { type: srcVal.slice(0, idx), name: srcVal.slice(idx + 1) };
    // Prop-driven: the parent persists to the hub then refetches (re-seeds acl).
    onAdd?.(src, [...dst]);
    setDst([]);
  };
  const removeRule = (id: any) => onRemove?.(id);

  const policy = JSON.stringify({
    tagOwners: Object.fromEntries(allTags.map((t: any) => [`tag:${t}`, [`${userNames[0] ?? "owner"}@finch`]])),
    acls: acl.map((r: any) => ({ action: "accept", src: [tokenSrc(r.src)], dst: r.dst.map(tokenDst) })),
  }, null, 2);

  return (
    <div className="view view-narrow">
      <h1 className="page-title">Access <span className="admin-badge">admin</span></h1>
      <p className="page-lede">Who can reach what. Every rule is enforced at the door — before a request ever touches a box. Tag your services, then grant access by tag, group, or key.</p>

      <div className="client-tabs" style={{ margin: "4px 0 0" }}>
        {[["sharing", "Sharing"], ["rules", "Rules"], ["policy", "Raw policy"]].map(([k, l]) => (
          <button key={k} className={`ctab ${mode === k ? "ctab-on" : ""}`} onClick={() => setMode(k)}>{l}</button>
        ))}
      </div>

      {mode === "sharing" && (
        <SharingTab requests={requests} grants={grants} onApprove={onApprove} onDeny={onDeny} onRevoke={onRevoke} />
      )}

      {mode === "rules" && (
        <>
          <Card className="rule-builder">
            <select className="acl-select" value={srcVal} onChange={(e) => setSrcVal(e.target.value)}>
              <optgroup label="Users">{userNames.map((u: string) => <option key={u} value={`user:${u}`}>{u}</option>)}</optgroup>
              <optgroup label="Groups">{groupNames.map((g: any) => <option key={g} value={`group:${g}`}>{g}</option>)}</optgroup>
              <optgroup label="Keys">{keyNames.map((k: any) => <option key={k} value={`key:${k}`}>{k}</option>)}</optgroup>
            </select>
            <span className="rule-arrow">may reach</span>
            <div className="dst-chips">
              {targetOptions.map((o) => (
                <button key={o.type + o.name} className={`dst-chip ${inDst(o) ? "on" : ""}`} onClick={() => toggleDst(o)}>
                  <EntityChip ent={o} />
                </button>
              ))}
            </div>
            <Button kind="accent" size="md" onClick={addRule} disabled={!dst.length}>Add rule</Button>
          </Card>

          <Card className="table-card">
            {acl.map((r: any) => (
              <div key={r.id} className="rule-card">
                <EntityChip ent={r.src} />
                <span className="rule-arrow">may reach</span>
                <span className="rule-dsts">{r.dst.map((d: any, i: number) => <EntityChip key={i} ent={d} />)}</span>
                <span className="rule-spacer" />
                <span className="rule-allow">allow</span>
                {r.locked
                  ? <span className="dim mono rule-locked">admin · locked</span>
                  : <InlineConfirm prompt="remove?" trigger="remove" onConfirm={() => removeRule(r.id)} />}
              </div>
            ))}
          </Card>
        </>
      )}

      {mode === "policy" && (
        <Card className="policy-card">
          <SectionLabel hint="generated from your rules — the source of truth at the door">policy.json</SectionLabel>
          <div className="snippet">
            <pre className="mono">{policy}</pre>
            <CopyChip value={policy} className="snippet-copy" />
          </div>
        </Card>
      )}
    </div>
  );
}
