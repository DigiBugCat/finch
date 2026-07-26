"use client";
// Roost — tiny SVG chart primitives (area chart + sparkline).

import { useId } from 'react';

const MAX_CHART_POINTS = 2_048;

function finiteDimension(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

/** Keep a corrupt or unexpectedly large state payload from producing invalid
 * SVG coordinates or a multi-megabyte path. The chart is a visual summary, so
 * evenly sampling oversized series preserves the time range while bounding
 * render work. */
function chartSamples(values: unknown): number[] {
  if (!Array.isArray(values) || values.length === 0) return [];
  const count = Math.min(values.length, MAX_CHART_POINTS);
  return Array.from({ length: count }, (_, index) => {
    const sourceIndex = count === values.length
      ? index
      : Math.round((index * (values.length - 1)) / (count - 1));
    const value = values[sourceIndex];
    return typeof value === "number" && Number.isFinite(value)
      ? Math.max(0, value)
      : 0;
  });
}

// AreaChart — smooth-ish line + gradient fill area chart.
// values: number[]; renders responsively (width 100%), fixed height `h`.
export function AreaChart({ values, w = 640, h = 150, color = "#f2b443", grid = true, area = true }: any) {
  // Hooks must run before every early return so an empty series can become
  // non-empty on a later dashboard poll without changing hook order.
  const gid = "g" + useId();
  const samples = chartSamples(values);
  if (samples.length === 0) return null;

  const width = finiteDimension(w, 640);
  const height = finiteDimension(h, 150);
  const max = samples.reduce((highest, value) => Math.max(highest, value), 0) * 1.18 || 1;
  const n = samples.length;
  const X = (i: number) => +(n === 1 ? width / 2 : (i / (n - 1)) * width).toFixed(2);
  const Y = (v: number) => +(height - (v / max) * height).toFixed(2);
  const pts = samples.map((v: number, i: number) => [X(i), Y(v)]);
  const line = pts.map((p: number[], i: number) => `${i ? "L" : "M"}${p[0]},${p[1]}`).join(" ");
  const fill = `${line} L${width},${height} L0,${height} Z`;
  const gridY = [0.25, 0.5, 0.75].map((f) => +(height * f).toFixed(1));

  return (
    <svg className="chart-svg" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" style={{ width: "100%", height }}>
      <defs>
        <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.30" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {grid && gridY.map((y, i) => (
        <line key={i} x1="0" x2={width} y1={y} y2={y} stroke="#3f3725" strokeWidth="1" strokeDasharray="2 6" opacity="0.7" vectorEffect="non-scaling-stroke" />
      ))}
      {area && <path d={fill} fill={`url(#${gid})`} />}
      <path d={line} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

// Sparkline — compact AreaChart, no gridlines.
export function Sparkline({ values, h = 34, color = "#f2b443", area = true }: any) {
  return <AreaChart values={values} w={160} h={h} color={color} grid={false} area={area} />;
}
