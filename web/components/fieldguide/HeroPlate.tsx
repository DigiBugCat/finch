// Plate I: the hero panorama. A tools/call leaves a Claude signpost, the
// finch carries it down the wire to the house, the window glows, and the
// answer streams back up as a line of beads. Pure SVG + SMIL + CSS: no JS.
// Reduced motion shows the still group (the finch perched mid-wire) instead
// of the animated one; see .fg-motion / .fg-still in landing.css.
import type { CSSProperties } from 'react';
import { Bird, BirdShape, BIRD_VIEWBOX } from './Bird';
import CopyPromptButton from './CopyPromptButton';

const f = (token: string): CSSProperties => ({ fill: `var(--${token})` });
const draw = (len: number, delay: number) =>
  ({ '--len': String(len), animationDelay: `${delay}ms` }) as CSSProperties;
const soak = (delay: number): CSSProperties => ({ animationDelay: `${delay}ms` });

const HOME_WIRE = 'fg-wire-home';
const CLIENT_WIRE = 'fg-wire-claude';

// Streamed answer beads: [start, end] as fractions of the 7 s loop. The first
// six run house -> relay, the last six relay -> Claude.
const HOME_BEADS: [string, string][] = [
  ['0.42', '0.56'], ['0.45', '0.59'], ['0.48', '0.62'], ['0.51', '0.65'], ['0.54', '0.68'], ['0.57', '0.71'],
];
const CLIENT_BEADS: [string, string][] = [
  ['0.56', '0.66'], ['0.59', '0.69'], ['0.62', '0.72'], ['0.65', '0.75'], ['0.68', '0.78'], ['0.71', '0.81'],
];

function Bead({ wire, start, end }: { wire: string; start: string; end: string }) {
  return (
    <circle r="4.5" opacity="0">
      <animateMotion dur="7s" repeatCount="indefinite" keyPoints="0;0;1;1" keyTimes={`0;${start};${end};1`} calcMode="linear">
        <mpath href={`#${wire}`} />
      </animateMotion>
      <animate attributeName="opacity" values="0;1;0" keyTimes={`0;${start};${end}`} dur="7s" repeatCount="indefinite" calcMode="discrete" />
    </circle>
  );
}

function CarryingFinch() {
  return (
    <>
      <Bird fill="var(--vermilion)" painted transform="scale(1.5)" />
      <path d="M21 -30 L30 -27 L21 -24Z" style={f('ochre')} />
    </>
  );
}

function Panorama() {
  return (
    <svg
      className="fg-hero-svg"
      viewBox="0 0 1440 600"
      width="1440"
      height="600"
      role="img"
      aria-label="Animated painted landscape. A request travels from a Claude signpost to the finch relay; a red finch flies it down a wire to a small house; the window glows; the answer streams back up the wire as a line of beads."
    >
      <rect width="1440" height="600" style={f('sky')} />
      <g filter="url(#iw-wash)">
        <path className="fg-soak" style={{ ...f('indigo-wash'), ...soak(100) }} d="M-20 330 C 200 270, 420 262, 640 300 S 1060 250, 1460 290 L1460 620 L-20 620Z" />
      </g>
      <g filter="url(#iw-gouache)">
        <path className="fg-soak" style={{ ...f('sage'), ...soak(300) }} d="M-20 400 C 220 350, 470 356, 700 392 S 1150 360, 1460 380 L1460 620 L-20 620Z" />
        <path className="fg-soak" style={{ ...f('sage-deep'), ...soak(500) }} d="M-20 470 C 150 420, 330 420, 520 470 S 900 530, 1100 520 L1100 620 L-20 620Z" />
        <path className="fg-soak" style={{ ...f('sage'), ...soak(550) }} d="M960 480 C 1100 410, 1260 392, 1460 420 L1460 620 L960 620Z" />
        <rect x="210" y="388" width="96" height="56" style={f('surface-raised')} />
        <path d="M198 392 L258 350 L318 392Z" style={f('indigo')} />
        <rect x="240" y="402" width="26" height="20" style={f('ochre')} />
        <rect x="830" y="170" width="150" height="52" rx="3" style={f('indigo-wash')} />
        <rect x="1150" y="300" width="96" height="34" rx="3" style={f('surface-raised')} />
        <rect x="1262" y="250" width="96" height="34" rx="3" style={f('surface-raised')} />
        <rect x="1330" y="330" width="104" height="34" rx="3" style={f('surface-raised')} />
      </g>

      {/* the window glow while the house works on the request */}
      <rect className="fg-motion" x="240" y="402" width="26" height="20" style={{ fill: '#fbe3a6' }} opacity="0">
        <animate attributeName="opacity" values="0;0;0.95;0.95;0;0" keyTimes="0;0.36;0.40;0.56;0.64;1" dur="7s" repeatCount="indefinite" />
      </rect>

      {/* wires and posts */}
      <g fill="none" style={{ stroke: 'var(--indigo)' }} strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
        <path d="M290 362 L290 330" />
        <path d="M905 222 L905 380" />
        <path d="M1198 334 L1198 420" />
        <path d="M1310 284 L1310 400" />
        <path d="M1382 364 L1382 440" />
        <rect x="830" y="170" width="150" height="52" rx="3" />
        <path id={HOME_WIRE} className="fg-draw" style={draw(640, 700)} d="M290 330 C 470 330, 660 230, 830 196" />
        <path id={CLIENT_WIRE} className="fg-draw" style={draw(240, 1000)} d="M980 196 C 1050 200, 1100 290, 1150 317" />
        <path className="fg-draw" style={draw(300, 1100)} d="M980 196 C 1080 196, 1180 250, 1262 267" />
        <path className="fg-draw" style={draw(400, 1200)} d="M980 196 C 1100 210, 1240 330, 1330 347" />
      </g>
      <g className="fg-svg-sans" style={f('ink')}>
        <text x="848" y="202" style={{ fontSize: 14 }}>finchmcp.com</text>
        <text x="1174" y="322">Claude</text>
        <text x="1287" y="272">Cursor</text>
        <text x="1350" y="352">ChatGPT</text>
      </g>

      {/* motion: the request, the finch, the streamed answer */}
      <g className="fg-motion">
        <circle r="6" style={f('indigo')}>
          <animateMotion dur="7s" repeatCount="indefinite" keyPoints="1;1;0;0" keyTimes="0;0.02;0.17;1" calcMode="linear">
            <mpath href={`#${CLIENT_WIRE}`} />
          </animateMotion>
          <animate attributeName="opacity" values="1;0" keyTimes="0;0.17" dur="7s" repeatCount="indefinite" calcMode="discrete" />
        </circle>
        <g>
          <animateMotion
            dur="7s"
            repeatCount="indefinite"
            keyPoints="1;1;0;0;1;1"
            keyTimes="0;0.17;0.36;0.62;0.84;1"
            calcMode="spline"
            keySplines=".4 0 .2 1;.4 0 .2 1;.4 0 .2 1;.4 0 .2 1;.4 0 .2 1"
          >
            <mpath href={`#${HOME_WIRE}`} />
          </animateMotion>
          <CarryingFinch />
          {/* the request, held in the beak on the way down */}
          <circle cx="30" cy="-24" r="5" style={f('indigo')} opacity="0">
            <animate attributeName="opacity" values="0;1;0" keyTimes="0;0.17;0.36" dur="7s" repeatCount="indefinite" calcMode="discrete" />
          </circle>
        </g>
        <g style={f('ochre')}>
          {HOME_BEADS.map(([s, e]) => <Bead key={`h${s}`} wire={HOME_WIRE} start={s} end={e} />)}
          {CLIENT_BEADS.map(([s, e]) => <Bead key={`c${s}`} wire={CLIENT_WIRE} start={s} end={e} />)}
        </g>
      </g>
      <g className="fg-still">
        <g transform="translate(560 262)">
          <CarryingFinch />
        </g>
      </g>

      {/* annotations */}
      <g className="fg-hero-anno fg-svg-hand" style={{ ...f('indigo'), fontSize: 19 }}>
        <text x="96" y="262" className="fg-soak" style={soak(1600)}>your machine</text>
        <text x="96" y="286" className="fg-soak" style={{ ...soak(1700), fontSize: 16, fill: 'var(--ink-muted)' }}>localhost:8000, no open port</text>
        <text x="560" y="150" className="fg-soak" style={soak(1900)}>finch carries the request down</text>
        <text x="1090" y="150" className="fg-soak" style={soak(2100)}>your agents</text>
      </g>
      <g className="fg-hero-anno" fill="none" style={{ stroke: 'var(--indigo)' }} strokeWidth="1.25" strokeLinecap="round">
        <path className="fg-draw" style={draw(90, 1650)} d="M170 296 C 190 320, 220 336, 246 346" />
        <path className="fg-draw" style={draw(90, 1950)} d="M700 158 C 740 162, 772 176, 798 196" />
      </g>
    </svg>
  );
}

function Legend() {
  return (
    <div className="fg-hero-legend">
      <span className="iw-label">Reading the plate</span>
      <ul>
        <li>
          <svg width="14" height="14" aria-hidden="true"><circle cx="7" cy="7" r="6" style={f('indigo')} /></svg>
          <span>A tools/call from Claude, with its key</span>
        </li>
        <li>
          <svg width="22" height="16" viewBox={BIRD_VIEWBOX} aria-hidden="true"><g style={f('vermilion')}><BirdShape /></g></svg>
          <span>finch, with the key already taken off</span>
        </li>
        <li>
          <svg width="22" height="10" aria-hidden="true">
            <circle cx="4" cy="5" r="3.5" style={f('ochre')} />
            <circle cx="12" cy="5" r="3.5" style={f('ochre')} />
            <circle cx="20" cy="5" r="1.8" style={f('ochre')} />
          </svg>
          <span>The answer, streamed back as it is written</span>
        </li>
      </ul>
    </div>
  );
}

export default function HeroPlate() {
  return (
    <section id="top" className="fg-hero" aria-labelledby="fg-hero-title">
      <div className="fg-hero-plate iw-grain">
        <Panorama />
      </div>
      <div className="fg-hero-below">
        <div className="fg-hero-sheet">
          <div className="fg-hero-eyebrow iw-label">
            <span className="iw-label-indigo">Plate I</span>
            <span>Free</span>
            <span>macOS and Linux</span>
            <span>MIT</span>
          </div>
          <h1 id="fg-hero-title">Localhost, with a front door.</h1>
          <p>
            finch gives the MCP server on your Mac or Linux machine a stable https address, with keys or
            OAuth at the door. Your machine calls out to finch, so nothing on it is left open.
          </p>
          <div className="fg-hero-actions">
            <CopyPromptButton />
            <a href="#agents" className="fg-strong-link">Or install it by hand</a>
          </div>
        </div>
        <Legend />
      </div>
    </section>
  );
}
