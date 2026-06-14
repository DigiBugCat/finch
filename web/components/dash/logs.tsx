"use client";
// Roost — Logs: filterable audit trail.
import { useState } from 'react';
import { Card } from '@/components/dash/primitives';

const L_CATS = [["all", "All"], ["request", "Requests"], ["device", "Devices"], ["key", "Keys"], ["access", "Access"], ["admin", "Admin"]];

export function LogsView({ logs }: any) {
  const [cat, setCat] = useState("all");
  const [q, setQ] = useState("");
  const ql = q.trim().toLowerCase();
  const rows = logs.filter((l: any) =>
    (cat === "all" || l.cat === cat) &&
    (!ql || [l.actor, l.action, l.target, l.ip].join(" ").toLowerCase().includes(ql)));

  return (
    <div className="view">
      <h1 className="page-title">Logs</h1>
      <p className="page-lede">Every enrollment, request, key change, and access edit — newest first. Filter by kind or search by actor, target, or IP.</p>

      <div className="fleet-search">
        <span className="si">🔍</span>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search actor, target, IP…" spellCheck={false} autoCapitalize="off" autoCorrect="off" />
        {q && <button className="clr" onClick={() => setQ("")} title="Clear">✕</button>}
      </div>

      <div className="cat-bar">
        {L_CATS.map(([k, l]) => (
          <button key={k} className={`group-chip ${cat === k ? "on" : ""}`} onClick={() => setCat(k)}>
            {l} <span className="ct">{k === "all" ? logs.length : logs.filter((x: any) => x.cat === k).length}</span>
          </button>
        ))}
      </div>

      <Card className="table-card">
        <div className="lrow lrow-head">
          <span>time</span><span>kind</span><span>event</span><span>source</span><span></span>
        </div>
        {rows.map((l: any, i: number) => (
          <div key={i} className="lrow">
            <span className="l-time mono dim">{l.ago}</span>
            <span className="l-cat"><span className={`logcat logcat-${l.cat}`}>{l.cat}</span></span>
            <span className="l-event"><b className="mono">{l.actor}</b> <span className="dim">{l.action}</span>{l.target ? <> <span className="mono">{l.target}</span></> : null}</span>
            <span className="l-ip mono dim">{l.ip || "—"}</span>
            <span className="l-res">{l.result ? <span className={`feed-status ${l.result < 300 ? "fs-ok" : l.result < 500 ? "fs-warn" : "fs-err"}`}>{l.result}</span> : null}</span>
          </div>
        ))}
        {!rows.length && <div className="dim" style={{ padding: "22px 20px" }}>No matching events.</div>}
      </Card>
    </div>
  );
}
