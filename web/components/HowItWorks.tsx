"use client";

import { useEffect, useRef, useState } from 'react';

// Animated, interactive flow diagram for "How it works":
// client → hub → your box, with the box dialing OUT (the pitch: nothing listens
// on the box, no open ports). Packets flow continuously; the box pulses
// "online"; hovering a leg highlights it; "Send a request" fires one packet
// through the whole round-trip in sequence.
const C = { amber: '#f2b443', green: '#79d995', card: '#2d271c', cardHi: '#352d20', line: '#4b4129', ink: '#f1e9d8', dim: '#a89d85', bg: '#1c180f' };

// The four legs of the round-trip, in firing order, each a straight path.
const LEGS = {
  request:  { d: 'M205,108 L360,108', color: C.amber, from: [205, 108], to: [360, 108] },
  relay:    { d: 'M560,108 L715,108', color: C.green, from: [560, 108], to: [715, 108] },
  response: { d: 'M715,150 L560,150', color: C.green, from: [715, 150], to: [560, 150] },
  back:     { d: 'M360,150 L205,150', color: C.amber, from: [360, 150], to: [205, 150] },
} as const;
type LegName = keyof typeof LEGS;

function FlowGraphic() {
  const [mounted, setMounted] = useState(false);          // SMIL only after mount
  const [hot, setHot] = useState<LegName | null>(null);   // hovered leg
  const [phase, setPhase] = useState<LegName | null>(null); // sequenced demo
  const [boxPing, setBoxPing] = useState(false);
  const timers = useRef<number[]>([]);

  useEffect(() => { setMounted(true); return () => { timers.current.forEach(clearTimeout); }; }, []);

  function sendRequest() {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    const steps: [number, () => void][] = [
      [0,    () => setPhase('request')],
      [620,  () => { setPhase('relay'); setBoxPing(true); }],
      [1240, () => setPhase('response')],
      [1500, () => setBoxPing(false)],
      [1860, () => setPhase('back')],
      [2500, () => setPhase(null)],
    ];
    steps.forEach(([t, fn]) => timers.current.push(window.setTimeout(fn, t)));
  }

  const Node = ({ x, label, sub, icon, accent, online }: any) => (
    <g transform={`translate(${x},74)`}>
      {online && mounted && (
        <rect width="190" height="108" rx="14" fill="none" stroke={C.green} strokeWidth="2" opacity="0.5">
          <animate attributeName="opacity" values="0.5;0.05;0.5" dur="2.4s" repeatCount="indefinite" />
          <animate attributeName="stroke-width" values="2;4;2" dur="2.4s" repeatCount="indefinite" />
        </rect>
      )}
      <rect width="190" height="108" rx="14" fill={C.card} stroke={accent} strokeWidth="1.5" />
      <text x="20" y="42" fontSize="26">{icon}</text>
      <text x="58" y="40" fill={C.ink} fontSize="17" fontWeight="600">{label}</text>
      <text x="20" y="78" fill={C.dim} fontSize="12.5">{sub}</text>
      {online && <circle cx="172" cy="22" r="5" fill={C.green}>{mounted && <animate attributeName="opacity" values="1;0.3;1" dur="1.4s" repeatCount="indefinite" />}</circle>}
    </g>
  );

  // One leg: base line + always-on flowing packet + highlight when hot/active.
  const Leg = ({ name, label, sub, labelY, subY, midX, dash }: any) => {
    const leg = LEGS[name as LegName];
    const lit = hot === name || phase === name;
    return (
      <g onMouseEnter={() => setHot(name)} onMouseLeave={() => setHot(null)} style={{ cursor: 'pointer' }}>
        <path d={leg.d} stroke={leg.color} strokeWidth={lit ? 3 : 1.8} fill="none"
          strokeDasharray={dash ? '5 4' : undefined} opacity={lit ? 1 : 0.55}
          markerEnd={`url(#ah-${leg.color === C.amber ? 'amber' : 'green'})`} style={{ transition: 'all .18s' }} />
        {/* continuous flowing packet (client-only; SMIL can break SSR) */}
        {mounted && (
          <circle r={lit ? 5 : 3.5} fill={leg.color} opacity={lit ? 1 : 0.8}>
            <animateMotion dur={name === 'response' || name === 'back' ? '2.2s' : '1.7s'} repeatCount="indefinite" path={leg.d} />
          </circle>
        )}
        {/* one-shot bright packet during the sequenced demo */}
        {mounted && phase === name && (
          <circle r="6" fill="#fff" opacity="0.95">
            <animateMotion dur="0.6s" repeatCount="1" path={leg.d} fill="freeze" />
          </circle>
        )}
        <text x={midX} y={labelY} fill={lit ? leg.color : C.dim} fontSize="12.5" textAnchor="middle" fontWeight="600" style={{ transition: 'fill .18s' }}>{label}</text>
        {sub && <text x={midX} y={subY} fill={C.dim} fontSize="11" textAnchor="middle">{sub}</text>}
      </g>
    );
  };

  return (
    <div className="how-graphic" role="img" aria-label="An MCP client reaches the finch hub on Cloudflare over HTTPS with a finch_ bearer key; your box dials out to the hub over an outbound WebSocket with no open ports; the hub relays the call and streams the response back.">
      <svg viewBox="0 0 920 300" width="100%" style={{ maxWidth: 920, display: 'block', margin: '0 auto' }}>
        <defs>
          <marker id="ah-amber" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill={C.amber} /></marker>
          <marker id="ah-green" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill={C.green} /></marker>
        </defs>

        <Leg name="request"  label="request"   sub="HTTPS · Bearer finch_…" midX={283} labelY={96}  subY={128} />
        <Leg name="back"     label="streamed response" sub={null}           midX={283} labelY={172} subY={0} dash />
        <Leg name="relay"    label="relays the call"   sub={null}           midX={636} labelY={96}  subY={0} dash />
        <Leg name="response" label="dials out · no open ports" sub="outbound WebSocket" midX={636} labelY={172} subY={140} />

        <Node x={15}  label="MCP client" sub="Claude · Cursor · any" icon="🤖" accent={C.line} />
        <Node x={365} label="finch hub"  sub="Cloudflare · auth + routing" icon="🐦" accent={C.amber} />
        <Node x={715} label="your box"   sub="Mac mini · Pi · server" icon="📦" accent={C.green} online={boxPing || phase != null} />
      </svg>
      <div className="how-graphic-cta">
        <button type="button" className="btn btn-sm btn-amber" onClick={sendRequest} disabled={phase != null}>
          {phase != null ? 'sending…' : '▶ Send a request'}
        </button>
        <span className="dim">hover a leg to highlight it</span>
      </div>
    </div>
  );
}

export default function HowItWorks() {
  function handleCopy(e: React.MouseEvent<HTMLButtonElement>) {
    const btn = e.currentTarget;
    const text = btn.getAttribute("data-copy") || "";
    navigator.clipboard.writeText(text);
    const original = btn.textContent;
    btn.textContent = "copied ✓";
    btn.classList.add("done");
    setTimeout(() => {
      btn.textContent = original;
      btn.classList.remove("done");
    }, 1200);
  }

  return (
    <section className="sec sec-bg2" id="how">
      <div className="wrap">
        <div className="sec-head">
          <span className="sec-tag">HOW IT WORKS</span>
          <h2>From cold box to live endpoint in a minute</h2>
          <p>One command up. One URL out. That's the whole loop.</p>
        </div>

        <FlowGraphic />

        <div className="steps">
          <div className="step">
            <div className="step-n"></div>
            <h3>Pick a box</h3>
            <p>Anything that stays on and runs a shell — a Mac mini, a Pi, a spare Linux box. If it can hold a process, it can hold a roost.</p>
          </div>
          <div className="step">
            <div className="step-n"></div>
            <h3>Bring it home</h3>
            <p>Run one line. The box dials out to Finch, joins your flock, and starts chirping — no port-forwarding, no firewall holes.</p>
            <div className="step-code">
              <code id="install-cmd">curl -fsSL finchmcp.com/install | sh</code>
              <button className="copybtn" data-copy="curl -fsSL finchmcp.com/install | sh" onClick={handleCopy}>Copy</button>
            </div>
          </div>
          <div className="step">
            <div className="step-n"></div>
            <h3>Hand off the URL</h3>
            <p>Each ability publishes its own MCP endpoint. Drop the URL into any client and your agent is holding the tool — auth already handled.</p>
            <div className="step-code">
              <code>maray.finchmcp.com/printer/mcp</code>
              <button className="copybtn" data-copy="https://maray.finchmcp.com/printer/mcp" onClick={handleCopy}>Copy</button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
