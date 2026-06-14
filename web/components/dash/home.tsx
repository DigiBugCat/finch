"use client";
// Roost — Home: the observability dashboard (health, attention, traffic).
import { AreaChart, Sparkline } from '@/components/dash/charts';
import { Button, Card, PerchMeter, isOnline } from '@/components/dash/primitives';

function Kpi({ label, value, unit, delta, sub, spark, color, extra }: any) {
  const dir = delta == null ? null : delta > 0 ? "up" : delta < 0 ? "down" : "flat";
  return (
    <Card className="kpi">
      <div className="kpi-top">
        <span className="kpi-label">{label}</span>
        {delta != null && (
          <span className={`kpi-delta ${dir}`}>{delta > 0 ? "▲" : delta < 0 ? "▼" : "—"} {Math.abs(delta)}%</span>
        )}
      </div>
      <div className="kpi-val">{value}{unit && <span className="unit">{unit}</span>}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
      {extra}
      {spark && <div className="kpi-spark"><Sparkline values={spark} color={color} /></div>}
    </Card>
  );
}

export function HomeView({ appliances, machines, overview, host, onOpen, onApprove, onAddDevice }: any) {
  const ov = overview;
  const online = appliances.filter((a: any) => isOnline(a.state));
  const resting = appliances.filter((a: any) => a.state === "resting");
  const invited = appliances.filter((a: any) => a.state === "invited");
  const pending = appliances.filter((a: any) => a.state === "pending");

  const issues: any[] = [];
  pending.forEach((a: any) => issues.push({ tone: "green", ic: "⏳", title: `${a.id} is waiting for approval`, sub: `Connected from ${a.box}, owned by ${a.owner}. Approve to let traffic through.`, cta: ["Approve", () => onApprove(a.id)] }));
  online.filter((a: any) => a.err >= 1).forEach((a: any) => issues.push({ tone: "red", ic: "⚠", title: `${a.id} · ${a.err}% errors`, sub: `p95 ${a.p95}ms · above your 1% comfort line over the last 24h.`, cta: ["Inspect", () => onOpen(a.id)] }));
  appliances.filter((a: any) => a.outdated).forEach((a: any) => issues.push({ tone: "amber", ic: "⬆", title: `${a.id} has a machine out of date`, sub: `One or more machines are behind v${ov.latest}. Open it for the update command.`, cta: ["Update", () => onOpen(a.id)] }));
  invited.forEach((a: any) => issues.push({ tone: "amber", ic: "🎟", title: `${a.id} hasn't phoned home`, sub: "Ticket is waiting — run the install command on the box.", cta: ["Open", () => onOpen(a.id)] }));
  const hasErr = issues.some((i: any) => i.tone === "red");

  return (
    <div className="view">
      <Card className="roost-head">
        <div className="roost-head-left">
          <h1 className="roost-title">Your flock, this evening <span className="moon">🌙</span></h1>
          <p className="roost-sub">
            <b className="n-on">{online.length} chirping</b> · {resting.length} resting
            {invited.length ? <> · <b className="n-inv">{invited.length} invited</b></> : null}
            {pending.length ? <> · <b className="n-inv">{pending.length} pending</b></> : null}
          </p>
        </div>
        <div className="roost-head-right">
          <div className="perch-wrap" title="Perch meter — one bar per appliance">
            <PerchMeter items={appliances} big />
            <span className="perch-cap">perch meter</span>
          </div>
          <Button kind="accent" size="md" onClick={onAddDevice}>＋ Add device</Button>
        </div>
      </Card>

      <div className="ov-label">Observability <span className="dim">· last 24 hours</span></div>
      <div className="kpi-row kpi-row-3">
        <Kpi label="Appliances online" value={ov.activeNow} unit={` / ${ov.total}`}
          sub={`${machines.filter((m: any) => m.state === "chirping" || m.state === "in_use").length} of ${machines.length} machines up`}
          extra={<div className="kpi-states"><PerchMeter items={appliances} /></div>} />
        <Kpi label="Latency p50" value={ov.p50} unit="ms" sub={`p95 ${ov.p95}ms`} spark={ov.latency24h} color="#c4a8ef" />
        <Kpi label="Error rate" value={ov.errRate} unit="%" delta={-0.3}
          sub={hasErr ? `${issues.filter((i: any) => i.tone === "red").length} appliance over target` : "comfortably under 1% target"}
          spark={ov.traffic24h.map((v: number) => Math.max(0, v * 0.04 + 1))} color={hasErr ? "#e8848f" : "#79d995"} />
      </div>

      <Card className="chart-card">
        <div className="chart-head">
          <div>
            <div className="chart-title">Traffic across the fleet</div>
            <div className="chart-sub dim">requests / hour · last 24 hours</div>
          </div>
          <div className="chart-legend">
            <span className="leg"><span className="leg-sw" style={{ background: "#f2b443" }} /> requests</span>
            <span className="leg"><span className="live-dot" /> live</span>
          </div>
        </div>
        <AreaChart values={ov.traffic24h} color="#f2b443" h={170} />
        <div className="chart-axis">
          {["-24h", "-20h", "-16h", "-12h", "-8h", "-4h", "now"].map((t) => <span key={t} className="x-tick">{t}</span>)}
        </div>
      </Card>

      {issues.length > 0 && (
        <Card className={`attn-card ${hasErr ? "attn-alert" : ""}`}>
          <div className="attn-head">Needs attention <span className={`attn-count ${hasErr ? "alert" : ""}`}>{issues.length}</span></div>
          {issues.map((a: any, i: number) => (
            <div key={i} className="attn-row">
              <span className={`attn-ic ${a.tone}`}>{a.ic}</span>
              <div className="attn-body">
                <div className="attn-title">{a.title}</div>
                <div className="attn-sub">{a.sub}</div>
              </div>
              {a.cta && <div className="attn-cta"><button onClick={a.cta[1]}>{a.cta[0]}</button></div>}
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
