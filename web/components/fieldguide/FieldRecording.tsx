// Plate III: a plotter strip chart of one long streamed tools/call. The tape
// unrolls left to right (SMIL clip); reduced motion shows the whole tape.
import PlateHead from './PlateHead';

// One path for every event mark and one for the paper grid, computed once at
// module load (the same deterministic series the canvas draws).
function buildTicks(): string {
  let d = '';
  for (let j = 0; j < 135; j++) {
    const h =
      8 +
      Math.round(
        Math.abs(Math.sin(j * 1.7) * Math.cos(j * 0.37)) * 62 + (j % 17 === 0 ? 70 : 0) + (j > 128 ? 90 : 0),
      );
    d += `M${20 + j * 8} ${200 - h}h3v${h}h-3Z`;
  }
  return d;
}
function buildGrid(): string {
  let d = 'M20 200H1100';
  for (let x = 20; x <= 1100; x += 90) d += `M${x} 20V200`;
  return d;
}
const TICKS = buildTicks();
const GRID = buildGrid();

const AXIS: [number, string][] = [
  [16, '0'], [140, '30 s'], [268, '1 min'], [525, '2 min'], [782, '3 min'], [1039, '4 min'],
];

export default function FieldRecording() {
  return (
    <section className="iw-wrap fg-plate" aria-labelledby="fg-rec-title">
      <PlateHead
        id="fg-rec-title"
        plate="Plate III · A field recording"
        title="It streams for as long as your tool keeps talking"
        lede="Each mark is one event from a long tools/call: progress, partial results, the final answer. finch passes them through the moment they arrive, and there is no 30-second cutoff."
      />
      <figure className="fg-rec">
        <div className="fg-rec-meta">
          <span>POST /notes/mcp · tools/call reindex_notes · text/event-stream</span>
          <span>
            <span className="iw-blink fg-leaf" aria-hidden="true">●</span> 148 events · 4 min 12 s · done
          </span>
        </div>
        <svg
          viewBox="0 0 1120 250"
          width="1120"
          height="250"
          role="img"
          aria-label="Strip chart of streamed events over four minutes, passing a marker at 30 seconds where many proxies cut the connection"
        >
          <defs>
            <path id="fg-ticks" d={TICKS} />
            <clipPath id="fg-tape">
              <rect x="0" y="0" height="250" width="1120">
                <animate attributeName="width" values="20;1100;1100" keyTimes="0;0.8;1" dur="11s" repeatCount="indefinite" />
              </rect>
            </clipPath>
          </defs>
          <path d={GRID} fill="none" style={{ stroke: 'var(--line)' }} strokeWidth="1" />
          <g className="fg-motion" clipPath="url(#fg-tape)" style={{ fill: 'var(--indigo-wash)' }}>
            <use href="#fg-ticks" />
          </g>
          <g className="fg-still" style={{ fill: 'var(--indigo-wash)' }}>
            <use href="#fg-ticks" />
          </g>
          <g className="fg-motion">
            <circle cy="200" r="5" style={{ fill: 'var(--indigo)' }}>
              <animate attributeName="cx" values="20;1100;1100" keyTimes="0;0.8;1" dur="11s" repeatCount="indefinite" />
            </circle>
          </g>
          <line x1="149" y1="10" x2="149" y2="206" style={{ stroke: 'var(--vermilion)' }} strokeWidth="2" strokeDasharray="5 5" />
          <text x="160" y="30" className="fg-svg-hand fg-rec-note" style={{ fill: 'var(--vermilion)', fontSize: 18 }}>
            30 s · many proxies hang up here
          </text>
          <g className="fg-svg-sans fg-rec-axis" style={{ fill: 'var(--ink-muted)', fontSize: 12, fontWeight: 600 }}>
            {AXIS.map(([x, t]) => (
              <text key={t} x={x} y="222">{t}</text>
            ))}
          </g>
        </svg>
      </figure>
    </section>
  );
}
