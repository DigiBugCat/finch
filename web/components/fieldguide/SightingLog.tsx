"use client";
// Plate VI: the sighting log, the one Chalkboard instrument on the page. It
// shows the per-call record finch keeps (the worker's RecentCall: time, route,
// caller, status and latency, filed under its service); a new call arrives
// every 1.7 s while the plate is on screen and motion is allowed. A call the
// relay turns away before relaying it (no key, a bad key) is never recorded,
// so the log shows none.
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import PlateHead from './PlateHead';
import { useAnimate } from './useMotion';

const SERVICES = ['notes', 'notes', 'printer', 'notes', 'scraper'];
// The route is the whole request path, so one service can log several.
const ROUTES: Record<string, string[]> = {
  notes: ['/notes/mcp'],
  printer: ['/printer/mcp'],
  scraper: ['/scraper/mcp', '/scraper/api/fetch'],
};
// Caller labels as the relay stores them: a key's label, or oauth:<user id>.
const CALLERS = ['claude-code', 'cursor', 'oauth:user_2mXf8Q', 'claude-code', 'nightly-script'];
const T0 = 14 * 3600 + 2 * 60 + 5; // 14:02:05
const ROWS = 7;

const pad = (n: number) => String(n).padStart(2, '0');
const clock = (secs: number) => `${pad(Math.floor(secs / 3600))}:${pad(Math.floor(secs / 60) % 60)}:${pad(secs % 60)}`;

export type LogRow = { idx: number; time: string; svc: string; route: string; caller: string; status: string; took: string };

/** The deterministic rows the log shows at a given tick (newest first). */
export function logRows(tick: number): LogRow[] {
  const rows: LogRow[] = [];
  for (let k = 0; k < ROWS; k++) {
    const idx = tick + 40 - k;
    const svc = SERVICES[idx % 5];
    const routes = ROUTES[svc];
    rows.push({
      idx,
      time: clock(T0 + idx * 3),
      svc,
      route: routes[idx % routes.length],
      caller: CALLERS[(idx * 3) % 5],
      status: '200',
      took: `${40 + ((idx * 97) % 900)} ms`,
    });
  }
  return rows;
}

export default function SightingLog() {
  const ref = useRef<HTMLDivElement>(null);
  const animate = useAnimate(ref);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!animate) return;
    const id = setInterval(() => setTick((t) => t + 1), 1700);
    return () => clearInterval(id);
  }, [animate]);

  const rows = logRows(tick);

  return (
    <section className="iw-wrap fg-plate" aria-labelledby="fg-log-title">
      <PlateHead
        id="fg-log-title"
        plate="Plate VI · The sighting log"
        title="Everything finch writes down"
        lede={
          <>
            This is the whole record of a call. Bodies pass through and are never stored. Traffic is encrypted on
            both hops, and Cloudflare decrypts it at its edge to route it, so finch is not end-to-end encrypted.{' '}
            <Link href="/docs/privacy" className="fg-strong-link">The full privacy boundary</Link>
          </>
        }
      />
      <div className="fg-log iw-night iw-grain" ref={ref}>
        <div className="fg-log-top">
          <span className="iw-label iw-label-indigo">maray · notes · live</span>
          <span className="fg-log-clock">
            <span className="iw-blink fg-leaf" aria-hidden="true">●</span> recording · {clock(T0 + (tick + 40) * 3 + 1)}
          </span>
        </div>
        {/* Only on narrow screens, where the table scrolls: the columns past
            Caller (and the struck-out body, the privacy point) are off-screen. */}
        <span className="fg-log-swipe" aria-hidden="true">swipe sideways for every column →</span>
        <div className="fg-log-scroll" role="region" aria-label="Sighting log, scrolls sideways" tabIndex={0}>
          <table>
            <caption className="sr-only">Example per-call log for the notes service</caption>
            <colgroup>
              <col className="fg-c-time" />
              <col className="fg-c-svc" />
              <col className="fg-c-route" />
              <col className="fg-c-caller" />
              <col className="fg-c-status" />
              <col className="fg-c-took" />
              <col />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Service</th>
                <th scope="col">Route</th>
                <th scope="col">Caller</th>
                <th scope="col">Status</th>
                <th scope="col">Took</th>
                <th scope="col">Body</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, k) => (
                <tr key={r.idx} className={k === 0 && animate ? 'fg-rowin' : undefined}>
                  <td>{r.time}</td>
                  <td>{r.svc}</td>
                  <td>{r.route}</td>
                  <td>{r.caller}</td>
                  <td className="fg-leaf">{r.status}</td>
                  <td>{r.took}</td>
                  <td className="fg-not-kept">not kept</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <span className="fg-log-note">six columns, and that is all of it. Calls turned away at the door are not logged.</span>
      </div>
    </section>
  );
}
