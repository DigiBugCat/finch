"use client";
// Roost — Access: ACL rules (by tag / group / key) + generated raw policy.
import { useEffect, useState } from 'react';
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
  return d.name; // appliance
}

export function AccessView({ appliances, groups, keys, acl, onAdd, onRemove }: any) {
  const [rules, setRules] = useState(acl);
  const [mode, setMode] = useState("rules"); // rules | policy
  const [srcVal, setSrcVal] = useState("user:priya");
  const [dst, setDst] = useState<any[]>([]);

  // Re-seed from live state whenever the parent refetches the ACL.
  useEffect(() => { setRules(acl); }, [acl]);

  const allTags = [...new Set(appliances.flatMap((a: any) => a.tags || []))];
  const users = ["you", "priya", "sam"];
  const keyNames = keys.map((k: any) => k.label);
  const groupNames = (groups || []).map((g: any) => g.name);

  const targetOptions = [
    ...allTags.map((t: any) => ({ type: "tag", name: t })),
    ...groupNames.map((g: any) => ({ type: "group", name: g })),
  ];
  const inDst = (o: any) => dst.some((d) => d.type === o.type && d.name === o.name);
  const toggleDst = (o: any) => setDst((d) => inDst(o) ? d.filter((x) => !(x.type === o.type && x.name === o.name)) : [...d, o]);

  const addRule = () => {
    if (!dst.length) return;
    const idx = srcVal.indexOf(":");
    const src = { type: srcVal.slice(0, idx), name: srcVal.slice(idx + 1) };
    // optimistic — the parent persists to the hub then refetches (re-seeds rules)
    setRules((r: any) => [{ id: "r" + Date.now(), src, dst: [...dst], action: "allow" }, ...r]);
    onAdd?.(src, [...dst]);
    setDst([]);
  };
  const removeRule = (id: any) => {
    setRules((r: any) => r.filter((x: any) => x.id !== id));
    onRemove?.(id);
  };

  const policy = JSON.stringify({
    tagOwners: Object.fromEntries(allTags.map((t: any) => [`tag:${t}`, ["you@finch"]])),
    acls: rules.map((r: any) => ({ action: "accept", src: [tokenSrc(r.src)], dst: r.dst.map(tokenDst) })),
  }, null, 2);

  return (
    <div className="view view-narrow">
      <h1 className="page-title">Access <span className="admin-badge">admin</span></h1>
      <p className="page-lede">Who can reach what. Every rule is enforced at the door — before a request ever touches a device. Tag your devices, then grant access by tag, group, or key.</p>

      <div className="client-tabs" style={{ margin: "4px 0 0" }}>
        {[["rules", "Rules"], ["policy", "Raw policy"]].map(([k, l]) => (
          <button key={k} className={`ctab ${mode === k ? "ctab-on" : ""}`} onClick={() => setMode(k)}>{l}</button>
        ))}
      </div>

      {mode === "rules" ? (
        <>
          <Card className="rule-builder">
            <select className="acl-select" value={srcVal} onChange={(e) => setSrcVal(e.target.value)}>
              <optgroup label="Users">{users.map((u) => <option key={u} value={`user:${u}`}>{u}</option>)}</optgroup>
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
            {rules.map((r: any) => (
              <div key={r.id} className="rule-card">
                <EntityChip ent={r.src} />
                <span className="rule-arrow">may reach</span>
                <span className="rule-dsts">{r.dst.map((d: any, i: number) => <EntityChip key={i} ent={d} />)}</span>
                <span className="rule-spacer" />
                <span className="rule-allow">allow</span>
                {r.src.type === "user" && r.src.name === "you"
                  ? <span className="dim mono rule-locked">admin · locked</span>
                  : <InlineConfirm prompt="remove?" trigger="remove" onConfirm={() => removeRule(r.id)} />}
              </div>
            ))}
          </Card>
        </>
      ) : (
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
