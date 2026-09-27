// Plate II: the band (a service's permanent address, read like a bird ring)
// and the migration strip (the finch hops networks; the address stays put).
import type { CSSProperties } from 'react';
import { Bird } from './Bird';
import PlateHead from './PlateHead';

const f = (token: string): CSSProperties => ({ fill: `var(--${token})` });

// The address, split into the parts the anatomy labels. Shown exactly as
// written, never case-transformed: the service path is case-sensitive, so a
// reader who copies the ring must get a URL that works.
const SEGMENTS: { text: string; label: string; kind: 'bracket' | 'muted' }[] = [
  { text: 'maray', label: 'your account', kind: 'bracket' },
  { text: '.finchmcp.com', label: 'the relay', kind: 'muted' },
  { text: '/notes', label: 'the name you chose', kind: 'bracket' },
  { text: '/mcp', label: 'where clients connect', kind: 'bracket' },
];
const ADDRESS = SEGMENTS.map((s) => s.text).join('');

const STOPS = [
  { place: 'Home Wi-Fi', when: '09:12 · connected in 0.8 s' },
  { place: 'Café, after the lid closed', when: '13:40 · reconnected in 1.4 s' },
  { place: 'Phone hotspot', when: '17:05 · reconnected in 2.1 s' },
];

function Rivet() {
  return (
    <svg className="fg-rivet" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <circle cx="9" cy="9" r="7" style={{ fill: '#b98533' }} />
      <circle cx="9" cy="9" r="2.5" style={{ fill: '#8a5a12' }} />
    </svg>
  );
}

function Band() {
  return (
    <figure className="fg-band-fig">
      <div className="fg-band iw-grain">
        <Rivet />
        <span className="fg-band-addr">{ADDRESS}</span>
        <Rivet />
      </div>
      {/* Wide screens: labels hang off brackets under each part. A transparent
          copy of the address in the same type gives every bracket its true
          width, so the anatomy lines up at any size. */}
      <div className="fg-band-anatomy" aria-hidden="true">
        <span className="fg-rivet-space" />
        <span className="fg-band-addr fg-band-ghost">
          {SEGMENTS.map((s) => (
            <span key={s.text} className={`fg-seg fg-seg-${s.kind}`}>
              {s.text}
              <em>{s.label}</em>
            </span>
          ))}
        </span>
        <span className="fg-rivet-space" />
      </div>
      {/* Narrow screens (and screen readers everywhere): the same anatomy as a list. */}
      <figcaption className="fg-band-legend">
        <dl>
          {SEGMENTS.map((s) => (
            <div key={s.text}>
              <dt><code>{s.text}</code></dt>
              <dd>{s.label}</dd>
            </div>
          ))}
        </dl>
      </figcaption>
    </figure>
  );
}

function Migration() {
  return (
    <figure className="fg-migration">
      <div className="fg-migration-plate iw-grain">
        <svg
          viewBox="0 0 1120 250"
          width="1120"
          height="250"
          role="img"
          aria-label="Migration strip: the finch hops from home Wi-Fi to a café to a phone hotspot while the address stays the same"
        >
          <rect width="1120" height="250" style={f('sky')} />
          <g filter="url(#iw-wash)">
            <path style={f('indigo-wash')} d="M-20 170 C 200 130, 400 140, 560 160 S 900 130, 1140 150 L1140 270 L-20 270Z" />
          </g>
          <g filter="url(#iw-gouache)">
            <path style={f('sage')} d="M-20 200 C 200 176, 420 180, 600 198 S 960 180, 1140 192 L1140 270 L-20 270Z" />
            <rect x="138" y="150" width="54" height="36" style={f('surface-raised')} />
            <path d="M130 153 L165 128 L200 153Z" style={f('indigo')} />
            <rect x="157" y="160" width="14" height="12" style={f('ochre')} />
            <path d="M520 150 C 540 126, 600 126, 620 150Z" style={f('blush')} />
            <rect x="568" y="150" width="4" height="40" style={f('indigo')} />
            <rect x="548" y="172" width="44" height="6" style={f('indigo')} />
            <rect x="946" y="128" width="30" height="56" rx="6" style={f('indigo')} />
            <rect x="951" y="136" width="20" height="36" rx="2" style={f('sky')} />
          </g>
          <path
            id="fg-route"
            fill="none"
            style={{ stroke: 'var(--indigo)' }}
            strokeWidth="1.25"
            strokeDasharray="3 7"
            strokeLinecap="round"
            d="M165 118 C 300 30, 440 30, 570 112 C 700 30, 840 30, 961 110"
          />
          <g className="fg-motion">
            <g>
              <animateMotion
                dur="10s"
                repeatCount="indefinite"
                keyPoints="0;0;0.5;0.5;1;1;0"
                keyTimes="0;0.14;0.3;0.48;0.64;0.84;1"
                calcMode="spline"
                keySplines=".4 0 .2 1;.4 0 .2 1;.4 0 .2 1;.4 0 .2 1;.4 0 .2 1;.4 0 .2 1"
              >
                <mpath href="#fg-route" />
              </animateMotion>
              <Bird fill="var(--vermilion)" painted transform="scale(1.1)" />
            </g>
          </g>
          <g className="fg-still">
            <Bird fill="var(--vermilion)" transform="translate(570 112) scale(1.1)" />
          </g>
          <text x="330" y="44" className="fg-svg-hand fg-scale-text" style={{ ...f('indigo'), fontSize: 17 }}>
            reconnects on its own
          </text>
        </svg>
      </div>
      <figcaption className="fg-migration-stops">
        {STOPS.map((s) => (
          <div key={s.place}>
            <span className="fg-stop-place">{s.place}</span>
            <span className="fg-stop-when">{s.when}</span>
            <span className="fg-stop-ok">✓ maray.finchmcp.com/notes/mcp</span>
          </div>
        ))}
      </figcaption>
    </figure>
  );
}

export default function BandPlate() {
  return (
    <section id="band" className="iw-wrap fg-plate" aria-labelledby="fg-band-title">
      <PlateHead
        id="fg-band-title"
        plate="Plate II · The band"
        title="Every service gets a band it keeps for life"
        lede="Birders ring a bird once and know it wherever it lands. finch does the same for your server: one address that survives restarts, reboots and new networks."
      />
      <Band />
      <Migration />
    </section>
  );
}
