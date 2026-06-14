"use client";
// Roost — tiny SVG chart primitives (area chart + sparkline).

import { useId } from 'react';

// AreaChart — smooth-ish line + gradient fill area chart.
// values: number[]; renders responsively (width 100%), fixed height `h`.
export function AreaChart({ values, w = 640, h = 150, color = "#f2b443", grid = true, area = true }: any) {
  if (!values || !values.length) return null;
  const max = Math.max(...values) * 1.18 || 1;
  const n = values.length;
  const X = (i: number) => +((i / (n - 1)) * w).toFixed(2);
  const Y = (v: number) => +(h - (v / max) * h).toFixed(2);
  const pts = values.map((v: number, i: number) => [X(i), Y(v)]);
  const line = pts.map((p: number[], i: number) => `${i ? "L" : "M"}${p[0]},${p[1]}`).join(" ");
  const fill = `${line} L${w},${h} L0,${h} Z`;
  const gid = "g" + useId();
  const gridY = [0.25, 0.5, 0.75].map((f) => +(h * f).toFixed(1));

  return (
    <svg className="chart-svg" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: "100%", height: h }}>
      <defs>
        <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.30" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {grid && gridY.map((y, i) => (
        <line key={i} x1="0" x2={w} y1={y} y2={y} stroke="#3f3725" strokeWidth="1" strokeDasharray="2 6" opacity="0.7" vectorEffect="non-scaling-stroke" />
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
