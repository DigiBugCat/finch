// Plate VI: the sighting log, the one Chalkboard instrument on the page. It
// shows the per-call record finch keeps (the hub's RecentCall: time, route,
// caller, status and duration, filed under its service) exactly the way
// `finch logs <name>` prints it for the account owner: the same five columns
// in the same order (TIME, STATUS, TOOK, CALLER, ROUTE; agent/core
// cli_lifecycle.go runLogs), and nothing else under the command. A call
// refused for a missing or wrong key is never recorded, so the log shows none.
// That bodies are not kept is a handwritten note beside the output, not a
// column, because the CLI has no such column.
import Link from 'next/link';
import PlateHead from './PlateHead';

// Caller labels as the hub stores them: a key's label (finch connect labels a
// key "<client> on <machine>"), a label you chose with `finch keys mint`, or
// oauth:<user id> for a connector that signed in.
const CALLERS = ['claude-code on studio', 'oauth:user_2mXf8Q', 'cursor on studio', 'claude-code on studio', 'nightly-script'];
const TOOK = [212, 48, 1340, 96, 3870, 61, 530];
const DAY = '2026-09-27';
const T0 = 14 * 3600 + 2 * 60 + 5; // 14:02:05
export const LOG_ROWS = 7;
export const LOG_COMMAND = 'finch logs notes';

const pad = (n: number) => String(n).padStart(2, '0');
const clock = (secs: number) => `${pad(Math.floor(secs / 3600))}:${pad(Math.floor(secs / 60) % 60)}:${pad(secs % 60)}`;

/** One call as `finch logs` prints it, column by column. */
export type LogRow = { time: string; status: string; took: string; caller: string; route: string };

/** The columns `finch logs` prints, in its order. */
export const LOG_COLUMNS: { key: keyof LogRow; label: string }[] = [
  { key: 'time', label: 'Time' },
  { key: 'status', label: 'Status' },
  { key: 'took', label: 'Took' },
  { key: 'caller', label: 'Caller' },
  { key: 'route', label: 'Route' },
];

/** The rows the plate shows: calls to the notes service, newest first. */
export function logRows(): LogRow[] {
  const rows: LogRow[] = [];
  for (let k = 0; k < LOG_ROWS; k++) {
    rows.push({
      // The CLI prints each call's time in local time, date first.
      time: `${DAY} ${clock(T0 - k * 37 - ((k * 13) % 11))}`,
      status: '200',
      took: `${TOOK[k]}ms`,
      caller: CALLERS[k % CALLERS.length],
      route: '/notes/mcp',
    });
  }
  return rows;
}

export default function SightingLog() {
  const rows = logRows();
  return (
    <section className="iw-wrap fg-plate" aria-labelledby="fg-log-title">
      <PlateHead
        id="fg-log-title"
        plate="Plate VI · The sighting log"
        title="Everything finch writes down"
        lede={
          <>
            This is the whole record of a call, and <code className="fg-inline-code">{LOG_COMMAND}</code> shows it to you.
            Bodies pass through and are never stored. Traffic is encrypted on both hops, and Cloudflare decrypts it
            at its edge to route it, so finch is not end-to-end encrypted.{' '}
            <Link href="/docs/privacy" className="fg-strong-link">The full privacy boundary</Link>
          </>
        }
      />
      <div className="fg-log iw-night iw-grain">
        <div className="fg-log-top">
          <span className="fg-log-cmd">$ {LOG_COMMAND}</span>
          <span className="iw-label iw-label-indigo">notes · last {LOG_ROWS} calls</span>
        </div>
        {/* Only on narrow screens, where the table scrolls: the columns past
            Took are off-screen. */}
        <span className="fg-log-swipe" aria-hidden="true">swipe sideways for every column →</span>
        <div className="fg-log-scroll" role="region" aria-label="Sighting log, scrolls sideways" tabIndex={0}>
          <table>
            <caption className="sr-only">Example of the recent calls finch logs notes lists for the notes service</caption>
            <colgroup>
              {LOG_COLUMNS.map((c) => <col key={c.key} className={`fg-c-${c.key}`} />)}
            </colgroup>
            <thead>
              <tr>
                {LOG_COLUMNS.map((c) => <th key={c.key} scope="col">{c.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.time}>
                  {LOG_COLUMNS.map((c) => (
                    <td key={c.key} className={c.key === 'status' ? 'fg-leaf' : undefined}>{r[c.key]}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <span className="fg-log-note">
          Five fields per call, and that is all of it: no request or response bodies. Calls refused for a missing
          or wrong key are not logged.
        </span>
      </div>
    </section>
  );
}
