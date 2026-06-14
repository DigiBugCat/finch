"use client";
// Roost — Fleet: appliances (grouped, primary) + Machines (flat node lens).
import { useState } from 'react';
import { Button, Card, DuskInput, PerchMeter, isOnline } from '@/components/dash/primitives';
import { FleetTable, FleetCards, FleetCompact, MachinesTable } from '@/components/dash/fleet';

function GroupHead({ name, apps, meta }: any) {
  const onlineN = apps.filter((a: any) => isOnline(a.state)).length;
  const m = (meta && meta.members) || ["you"];
  const extra = (meta && meta.extra) || 0;
  const shared = m.length > 1 || extra > 0;
  const label = shared ? `${m.join(", ")}${extra ? ` +${extra}` : ""}` : "just you";
  return (
    <div className="group-head">
      <span className="group-name">{name}</span>
      <span className="group-meta">{onlineN}/{apps.length} online</span>
      <span className="group-spacer" />
      {apps.length ? <PerchMeter items={apps} /> : null}
      <span className={`group-share ${shared ? "on" : ""}`} title={shared ? "shared group" : "only you"}>
        {shared ? "👥" : "🔒"} {label}
      </span>
    </div>
  );
}

export function FleetView({ appliances, machines, overview, host, groups, onOpen, onRelease, onAddDevice, layout, setLayout }: any) {
  const [lens, setLens] = useState("appliances"); // appliances | machines
  const [groupFilter, setGroupFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [extraGroups, setExtraGroups] = useState<any[]>([]);
  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState("");

  const q = search.trim().toLowerCase();

  // ---- group plumbing (appliances lens) ----
  const metaMap: any = {};
  (groups || []).forEach((g: any) => { metaMap[g.name] = g; });
  const order = (groups || []).map((g: any) => g.name);
  appliances.forEach((a: any) => { if (a.group && !order.includes(a.group)) order.push(a.group); });
  const allNames = [...order, ...extraGroups.filter((n: any) => !order.includes(n))];

  const matchA = (a: any) => !q || [a.id, a.owner, a.group, "v" + a.version, a.state, ...(a.tags || []).map((t: any) => "tag:" + t)].join(" ").toLowerCase().includes(q);
  const byGroupAll: any = {}, byGroup: any = {};
  allNames.forEach((n: any) => { byGroupAll[n] = []; byGroup[n] = []; });
  appliances.forEach((a: any) => {
    const n = a.group || "Home lab";
    (byGroupAll[n] = byGroupAll[n] || []).push(a);
    if (matchA(a)) (byGroup[n] = byGroup[n] || []).push(a);
  });
  const visibleNames = groupFilter === "all" ? allNames : [groupFilter];
  const shownA = visibleNames.reduce((s: number, n: any) => s + (byGroup[n] || []).length, 0);

  const addGroup = () => {
    const n = newName.trim();
    if (!n || allNames.includes(n)) return;
    setExtraGroups((x: any) => [...x, n]); setGroupFilter(n); setNewName(""); setNewOpen(false);
  };

  const renderRows = (list: any) => {
    if (layout === "table") return <FleetTable apps={list} host={host} onOpen={onOpen} onRelease={onRelease} head={false} />;
    if (layout === "cards") return <FleetCards apps={list} host={host} onOpen={onOpen} onRelease={onRelease} />;
    return <FleetCompact apps={list} host={host} onOpen={onOpen} onRelease={onRelease} />;
  };

  // ---- machines lens ----
  const matchM = (m: any) => !q || [m.name, m.os, m.appliance, "v" + m.version, m.address, m.owner, m.group].join(" ").toLowerCase().includes(q);
  const shownMachines = machines.filter(matchM);

  return (
    <div className="view">
      <div className="fleet-header">
        <div>
          <h1 className="page-title">Fleet</h1>
          <p className="page-lede">All your appliances, organized into groups. Switch to <b>Machines</b> for the box-level view.</p>
        </div>
        <Button kind="accent" onClick={onAddDevice}>＋ Add device</Button>
      </div>

      {/* lens toggle */}
      <div className="lens-bar">
        <div className="seg lens-seg">
          {[["appliances", "Appliances"], ["machines", "Machines"]].map(([k, l]) => (
            <button key={k} className={`seg-btn ${lens === k ? "seg-on" : ""}`} onClick={() => setLens(k)}>{l}</button>
          ))}
        </div>
        <span className="lens-count dim">
          {lens === "appliances" ? `${appliances.length} appliances` : `${machines.length} machines`}
        </span>
      </div>

      {/* search */}
      <div className="fleet-search">
        <span className="si">🔍</span>
        <input value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder={lens === "appliances" ? "Search by name, owner, group, tag…" : "Search by machine, OS, appliance, address…"}
          spellCheck={false} autoCapitalize="off" autoCorrect="off" />
        {search && <button className="clr" onClick={() => setSearch("")} title="Clear">✕</button>}
      </div>

      {lens === "appliances" ? (
        <>
          <div className="group-bar">
            <button className={`group-chip ${groupFilter === "all" ? "on" : ""}`} onClick={() => setGroupFilter("all")}>
              All <span className="ct">{appliances.length}</span>
            </button>
            {allNames.map((name: any) => (
              <button key={name} className={`group-chip ${groupFilter === name ? "on" : ""}`} onClick={() => setGroupFilter(name)}>
                {name} <span className="ct">{(byGroupAll[name] || []).length}</span>
              </button>
            ))}
            {newOpen ? (
              <span className="group-new">
                <DuskInput value={newName} onChange={setNewName} placeholder="group name" mono={false} autoFocus />
                <Button kind="accent" size="md" onClick={addGroup}>Add</Button>
                <button className="group-chip" onClick={() => { setNewOpen(false); setNewName(""); }}>Cancel</button>
              </span>
            ) : (
              <button className="group-chip group-chip-new" onClick={() => setNewOpen(true)}>＋ New group</button>
            )}
          </div>

          <div className="fleet-toolbar">
            <span className="fleet-count">{shownA} {shownA === 1 ? "appliance" : "appliances"}{q ? <> matching “<b>{search}</b>”</> : null}</span>
            <div className="seg">
              {["table", "cards", "compact"].map((l) => (
                <button key={l} className={`seg-btn ${layout === l ? "seg-on" : ""}`} onClick={() => setLayout(l)}>{l}</button>
              ))}
            </div>
          </div>

          <div className="group-stack">
            {visibleNames.map((name: any) => {
              const list = byGroup[name] || [];
              if (q && list.length === 0) return null;
              return (
                <div key={name} className="group-section">
                  <GroupHead name={name} apps={byGroupAll[name] || []} meta={metaMap[name]} />
                  {list.length
                    ? renderRows(list)
                    : <Card className="group-empty">
                        <div className="dim">{q ? "No matches in this group." : "No appliances in this group yet."}</div>
                        {!q && <Button kind="ghost" size="md" onClick={onAddDevice}>＋ Add one</Button>}
                      </Card>}
                </div>
              );
            })}
            {q && shownA === 0 && <Card className="group-empty"><div className="dim">Nothing matches “{search}”.</div></Card>}
          </div>
        </>
      ) : (
        <MachinesTable machines={shownMachines} host={host} onOpen={onOpen} query={search} />
      )}
    </div>
  );
}
