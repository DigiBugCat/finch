"use client";
// Plate IV: the gate. Three real toggle buttons (aria-pressed) turn a dial
// between the three ways in: a key per client, OAuth sign-in, or public.
import { useState, type CSSProperties } from 'react';
import PlateHead from './PlateHead';

export type GateMode = 'key' | 'oauth' | 'public';

const f = (token: string): CSSProperties => ({ fill: `var(--${token})` });

const ANGLE: Record<GateMode, number> = { key: -60, oauth: 0, public: 60 };
const NOTE: Record<GateMode, string> = {
  key: 'locked until a key is shown',
  oauth: 'sign in once, in your browser',
  public: 'anyone can walk in',
};

const MODES: { mode: GateMode; label: string }[] = [
  { mode: 'key', label: 'Key' },
  { mode: 'oauth', label: 'Sign in' },
  { mode: 'public', label: 'Public' },
];

const DETAIL: Record<GateMode, { who: string; title: string; body: string; code: string }> = {
  key: {
    who: 'Claude Code, Cursor, scripts',
    title: 'A key per client',
    body: 'Mint one for each client that should get in. Revoke one and that client is turned away on its next request. The others keep working.',
    code: 'finch keys mint cursor --service notes',
  },
  oauth: {
    who: 'claude.ai and ChatGPT connectors',
    title: 'Sign in at the gate',
    body: 'Add the address as a connector. It sends you to sign in to finch in your browser, then connects. There is no key to copy.',
    code: 'https://maray.finchmcp.com/notes/mcp',
  },
  public: {
    who: 'Demos and public pages',
    title: 'Leave the gate open',
    body: 'Anyone with the address gets in. Use it for a demo or a public page. Every other service on your machine stays behind its own gate.',
    code: 'finch add demo --service http://127.0.0.1:3000 --public',
  },
};

// Dial ticks every 12°, with major ticks at the three settings.
function buildTicks() {
  let minor = '';
  let major = '';
  for (let a = -84; a <= 84; a += 12) {
    const r = (a * Math.PI) / 180;
    const isMajor = a === -60 || a === 0 || a === 60;
    const r2 = isMajor ? 128 : 118;
    const seg =
      `M${(190 + 108 * Math.sin(r)).toFixed(1)} ${(200 - 108 * Math.cos(r)).toFixed(1)}` +
      `L${(190 + r2 * Math.sin(r)).toFixed(1)} ${(200 - r2 * Math.cos(r)).toFixed(1)}`;
    if (isMajor) major += seg;
    else minor += seg;
  }
  return { minor, major };
}
const TICKS = buildTicks();

function Dial({ mode }: { mode: GateMode }) {
  return (
    <svg viewBox="0 0 380 330" width="380" height="330" aria-hidden="true" focusable="false">
      <g filter="url(#iw-gouache)">
        <circle cx="190" cy="200" r="104" style={f('blush')} />
        <circle cx="190" cy="200" r="74" style={f('surface')} />
      </g>
      <g fill="none" style={{ stroke: 'var(--indigo)' }} strokeLinecap="round">
        <path d={TICKS.minor} strokeWidth="1.25" />
        <path d={TICKS.major} strokeWidth="2.25" />
        <circle cx="190" cy="200" r="104" strokeWidth="1.25" />
      </g>
      <g className="fg-knob" style={{ transform: `rotate(${ANGLE[mode]}deg)` }}>
        <line x1="190" y1="200" x2="190" y2="112" style={{ stroke: 'var(--indigo)' }} strokeWidth="3" strokeLinecap="round" />
        <circle cx="190" cy="108" r="7" style={f('vermilion')} />
        <circle cx="190" cy="200" r="12" style={f('indigo')} />
      </g>
    </svg>
  );
}

function Gate({ mode }: { mode: GateMode }) {
  const show = (on: boolean): CSSProperties => ({ display: on ? 'inline' : 'none' });
  return (
    <svg viewBox="0 0 330 240" width="330" height="240" role="img" aria-label={`Garden gate: ${NOTE[mode]}`}>
      <g filter="url(#iw-gouache)">
        <path d="M0 214 C 90 204, 240 204, 330 214 L330 240 L0 240Z" style={f('sage')} />
        <rect x="86" y="70" width="14" height="148" style={f('indigo-wash')} />
        <rect x="244" y="70" width="14" height="148" style={f('indigo-wash')} />
        <path d="M150 240 L194 240 L184 214 L160 214Z" style={{ ...f('surface-raised'), ...show(mode === 'public') }} />
      </g>
      <g fill="none" style={{ stroke: 'var(--indigo)' }} strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
        <rect x="86" y="70" width="14" height="148" />
        <rect x="244" y="70" width="14" height="148" />
        <path d="M0 110 L86 110 M0 170 L86 170 M258 110 L330 110 M258 170 L330 170" />
        <path style={show(mode !== 'public')} d="M104 96 L240 96 L240 206 L104 206 Z M104 206 L240 96 M138 96 L138 206 M172 96 L172 206 M206 96 L206 206" />
        <path style={show(mode === 'public')} d="M104 96 L150 76 L150 188 L104 206 Z M104 206 L150 76 M127 86 L127 197" />
        <path style={show(mode === 'oauth')} d="M100 44 L244 44 M150 44 L150 56 M194 44 L194 56" />
      </g>
      <g style={show(mode === 'key')}>
        <path d="M224 146 C 224 132, 244 132, 244 146" fill="none" style={{ stroke: 'var(--indigo)' }} strokeWidth="3" />
        <rect x="218" y="144" width="32" height="26" rx="3" style={f('ochre')} />
        <circle cx="234" cy="156" r="3" style={f('indigo')} />
      </g>
      <g style={show(mode === 'oauth')}>
        <rect x="138" y="56" width="68" height="28" rx="3" style={f('blush')} />
        <text x="148" y="75" className="fg-svg-sans" style={{ fill: 'var(--ink)', fontSize: 13, fontWeight: 700 }}>sign in</text>
      </g>
      <text x="8" y="36" className="fg-svg-hand" style={{ fill: 'var(--indigo)', fontSize: 17 }}>{NOTE[mode]}</text>
    </svg>
  );
}

export default function GateDial({ initialMode = 'key' }: { initialMode?: GateMode }) {
  const [mode, setMode] = useState<GateMode>(initialMode);
  const d = DETAIL[mode];

  return (
    <section id="gate" className="iw-wrap fg-plate" aria-labelledby="fg-gate-title">
      <PlateHead id="fg-gate-title" plate="Plate IV · The gate" title="Turn the dial to choose who gets in" />
      <div className="fg-gate">
        <div className="fg-dial" role="group" aria-label="Who gets in">
          <Dial mode={mode} />
          {MODES.map((m) => (
            <button
              key={m.mode}
              type="button"
              className={`fg-dial-btn fg-dial-${m.mode}`}
              aria-pressed={mode === m.mode}
              onClick={() => setMode(m.mode)}
            >
              {m.label}
            </button>
          ))}
        </div>
        <div className="fg-gate-body">
          <div key={mode} className="fg-gate-detail iw-soak" aria-live="polite">
            <span className="iw-label">{d.who}</span>
            <h3>{d.title}</h3>
            <p>{d.body}</p>
            <code>{d.code}</code>
          </div>
          <div className="fg-gate-art">
            <Gate mode={mode} />
          </div>
        </div>
      </div>
    </section>
  );
}
