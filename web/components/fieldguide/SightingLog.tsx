// Plate VI: the sighting log, the one Chalkboard instrument on the page. It
// shows the per-call record finch keeps (the hub's RecentCall: time, route,
// caller, status and duration, filed under its service), the way
// `finch logs <name>` lists it for the account owner. A call refused for a
// missing or wrong key is never recorded, so the log shows none, and the body
// column is there only to show that it is not kept.
import Link from 'next/link';
import PlateHead from './PlateHead';

// Caller labels as the hub stores them: a key's label (finch connect labels a
// key "<client> on <machine>"), a label you chose with `finch keys mint`, or
// oauth:<user id> for a connector that signed in.
const CALLERS = ['claude-code on studio', 'oauth:user_2mXf8Q', 'cursor on studio', 'claude-code on studio', 'nightly-script'];
const TOOK = [212, 48, 1340, 96, 3870, 61, 530];
const T0 = 14 * 3600 + 2 * 60 + 5; // 14:02:05
export const LOG_ROWS = 7;
export const LOG_COMMAND = 'finch logs notes';

const pad = (n: number) => String(n).padStart(2, '0');
const clock = (secs: number) => `${pad(Math.floor(secs / 3600))}:${pad(Math.floor(secs / 60) % 60)}:${pad(secs % 60)}`;

export type LogRow = { time: string; route: string; caller: string; status: string; took: string };

/** The rows the plate shows: calls to the notes service, newest first. */
export function logRows(): LogRow[] {
  const rows: LogRow[] = [];
  for (let k = 0; k < LOG_ROWS; k++) {
    rows.push({
      time: clock(T0 - k * 37 - ((k * 13) % 11)),
      route: '/notes/mcp',
      caller: CALLERS[k % CALLERS.length],
      status: '200',
      took: `${TOOK[k]} ms`,
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
            Caller (and the struck-out body, the privacy point) are off-screen. */}
        <span className="fg-log-swipe" aria-hidden="true">swipe sideways for every column →</span>
        <div className="fg-log-scroll" role="region" aria-label="Sighting log, scrolls sideways" tabIndex={0}>
          <table>
            <caption className="sr-only">Example of the recent calls finch logs notes lists for the notes service</caption>
            <colgroup>
              <col className="fg-c-time" />
              <col className="fg-c-route" />
              <col className="fg-c-caller" />
              <col className="fg-c-status" />
              <col className="fg-c-took" />
              <col />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Route</th>
                <th scope="col">Caller</th>
                <th scope="col">Status</th>
                <th scope="col">Took</th>
                <th scope="col">Body</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.time}>
                  <td>{r.time}</td>
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
        <span className="fg-log-note">
          Five fields per call, and that is all of it. Calls refused for a missing or wrong key are not logged.
        </span>
      </div>
    </section>
  );
}
