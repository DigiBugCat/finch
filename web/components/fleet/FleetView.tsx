// The /fleet instrument: a read-only view of one account, in Chalkboard. It
// renders only a FleetView (components/fleet/model.ts), never the hub's raw
// state, so a key's value, a key's last digits, emails and call bodies have no
// way onto the page. Nothing here changes the account: each action is shown as
// the finch command to run, with a Copy button.
import type { ReactNode } from 'react';
import CopyButton from './CopyButton';
import FleetClock from './FleetClock';
import {
  cmd,
  type FleetCall,
  type FleetKey,
  type FleetMachine,
  type FleetService,
  type FleetView as View,
} from './model';
import { AGENT_PROMPT, INSTALL_ONE_LINER } from '@/components/fieldguide/prompt';

/** One finch command, shown verbatim with a Copy button. */
export function Command({ command, what }: { command: string; what?: string }) {
  return (
    <div className="fl-cmd">
      <code>{command}</code>
      <CopyButton text={command} what={what ?? `the command ${command}`} />
    </div>
  );
}

function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

function osName(os: string): string {
  if (os === 'darwin') return 'macOS';
  if (os === 'linux') return 'Linux';
  return os;
}

function Status({ status }: { status: FleetService['status'] }) {
  const text = status === 'online' ? 'Online' : status === 'waiting' ? 'Waiting for approval' : 'Offline';
  return (
    <span className={`fl-status fl-status-${status}`}>
      <span aria-hidden="true">{status === 'online' ? '●' : '○'}</span> {text}
    </span>
  );
}

function Machine({ m, latest }: { m: FleetMachine; latest: string }) {
  const state = m.online ? 'online' : m.pending ? 'waiting for approval' : `offline, last seen ${m.lastSeen}`;
  return (
    <li className="fl-machine">
      <span className="fl-machine-name">{m.name || 'unnamed machine'}</span>
      <span className={m.online ? 'fl-ok' : 'fl-muted'}>
        <span aria-hidden="true">{m.online ? '● ' : '○ '}</span>
        {state}
      </span>
      <span className="fl-muted">
        {[osName(m.os), m.version ? `finch ${m.version}` : ''].filter(Boolean).join(' · ')}
      </span>
      {m.outdated && m.version && (
        <span className="fl-tag">{latest ? `${latest} is out` : 'update available'}</span>
      )}
    </li>
  );
}

function Calls({ calls, id }: { calls: FleetCall[]; id: string }) {
  if (!calls.length) {
    return (
      <p className="fl-empty-line">
        No calls yet. <code>{cmd.test(id)}</code> makes one.
      </p>
    );
  }
  return (
    <table className="fl-calls">
      <caption className="sr-only">Recent calls to {id}, newest first</caption>
      <thead>
        <tr>
          <th scope="col">Time (UTC)</th>
          <th scope="col">Route</th>
          <th scope="col">Caller</th>
          <th scope="col">Status</th>
          <th scope="col">Took</th>
        </tr>
      </thead>
      <tbody>
        {calls.map((c, i) => (
          <tr key={`${c.ts}-${i}`}>
            <td data-label="Time"><time dateTime={c.ts ? new Date(c.ts).toISOString() : undefined} title={c.ago}>{c.time}</time></td>
            <td data-label="Route" className="fl-route">{c.route}</td>
            <td data-label="Caller">{c.caller}</td>
            <td data-label="Status" className={c.ok ? 'fl-ok' : 'fl-bad'}>{c.status || '—'}</td>
            <td data-label="Took">{c.took}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ServiceCard({ svc, latest }: { svc: FleetService; latest: string }) {
  const headingId = `svc-${svc.id}`;
  return (
    <article className="fl-card fl-svc" aria-labelledby={headingId}>
      <header className="fl-svc-head">
        <h3 id={headingId}>{svc.id}</h3>
        <Status status={svc.status} />
      </header>
      {svc.label !== svc.id && <p className="fl-muted">{svc.label}</p>}

      <div className="fl-field">
        <span className="iw-label">Public URL</span>
        {svc.url ? (
          <div className="fl-cmd fl-url">
            <code>{svc.url}</code>
            <CopyButton text={svc.url} what={`the URL for ${svc.id}`} />
          </div>
        ) : (
          <p className="fl-muted">Your account address isn&apos;t assigned yet, so there is no URL to show.</p>
        )}
      </div>

      <div className="fl-field">
        <span className="iw-label">Who can call it</span>
        <p>
          {svc.auth === 'public'
            ? 'Anyone with the URL. No key or sign-in needed.'
            : 'Callers need a finch key, or your own OAuth sign-in (claude.ai connectors use this).'}
        </p>
      </div>

      <div className="fl-field">
        <span className="iw-label">Machines</span>
        {svc.machines.length ? (
          <ul className="fl-machines">
            {svc.machines.map((m, i) => <Machine key={`${m.name}-${i}`} m={m} latest={latest} />)}
          </ul>
        ) : (
          <p className="fl-muted">
            No machine has connected yet. On the machine that runs it, <code>finch service install</code> keeps it
            connected.
          </p>
        )}
        {svc.machines.some((m) => !m.online && !m.pending) && (
          <p className="fl-hint">
            On an offline machine, <code>{cmd.serviceStatus()}</code> says whether finch is running there.
          </p>
        )}
      </div>

      <div className="fl-field">
        <span className="iw-label">Recent calls</span>
        <Calls calls={svc.calls} id={svc.id} />
      </div>

      <div className="fl-field">
        <span className="iw-label">From a terminal</span>
        <ul className="fl-actions">
          <li><span>Every recent call</span><Command command={cmd.logs(svc.id)} /></li>
          <li><span>Check it answers</span><Command command={cmd.test(svc.id)} /></li>
          <li><span>Connect it to Claude Code</span><Command command={cmd.connect(svc.id)} /></li>
          {svc.auth === 'public' ? (
            <li><span>Require a key or sign-in</span><Command command={cmd.auth(svc.id, 'key')} /></li>
          ) : (
            <li><span>Open it to anyone</span><Command command={cmd.auth(svc.id, 'public')} /></li>
          )}
          <li><span>Remove it</span><Command command={cmd.rm(svc.id)} /></li>
        </ul>
      </div>
    </article>
  );
}

function reachText(k: FleetKey): string {
  if (k.reach === 'all') return 'every service';
  return k.reach.length ? k.reach.join(', ') : 'no services';
}

function Keys({ keys, firstService }: { keys: FleetKey[]; firstService: string }) {
  return (
    <section className="fl-section" aria-labelledby="fl-keys">
      <h2 id="fl-keys">Keys</h2>
      <p className="fl-lede">
        A key lets a client that can&apos;t sign in call your services. finch shows a key once, when you mint it, and
        keeps only a fingerprint, so this list has labels, never values.
      </p>
      {keys.length ? (
        <ul className="fl-keys">
          {keys.map((k) => (
            <li key={k.id} className="fl-card fl-key">
              <div className="fl-key-meta">
                <span className="fl-key-label">{k.label}</span>
                <span className="fl-muted">
                  Reaches {reachText(k)} · created {k.created || 'earlier'}
                  {k.expires ? ` · expires ${k.expires}` : ''}
                </span>
              </div>
              <Command command={cmd.revoke(k.id)} what={`the command to revoke ${k.label}`} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="fl-empty-line">
          No keys. Clients that support OAuth, like claude.ai, sign in instead.
        </p>
      )}
      {firstService && (
        <div className="fl-mint">
          <span>Make a key for one service</span>
          <Command command={cmd.mint(firstService)} />
        </div>
      )}
    </section>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="fl-step">
      <span className="fl-step-n" aria-hidden="true">{n}</span>
      <div>
        <p className="fl-step-title">{title}</p>
        {children}
      </div>
    </li>
  );
}

/** A new account with nothing published: how to get the first service up. */
export function FirstRun() {
  return (
    <section className="fl-card fl-first" aria-labelledby="fl-first">
      <span className="iw-label iw-label-indigo">First flight</span>
      <h2 id="fl-first">Nothing published yet</h2>
      <p className="fl-lede">
        Your account is ready. Publish an MCP server from your Mac or Linux machine by hand, or hand the whole job
        to an agent. This page fills in as soon as your first service connects.
      </p>
      <div className="fl-first-cols">
        <div>
          <h3>By hand</h3>
          <ol className="fl-steps">
            <Step n={1} title="Install finch">
              <Command command={INSTALL_ONE_LINER} what="the install command" />
            </Step>
            <Step n={2} title="Sign in from the terminal">
              <p className="fl-muted">It opens your browser and waits for you to approve.</p>
              <Command command="finch login" />
            </Step>
            <Step n={3} title="Publish your server and keep it running">
              <Command command="finch add notes --service http://127.0.0.1:8000" />
              <Command command="finch service install" />
            </Step>
          </ol>
        </div>
        <div>
          <h3>With an agent</h3>
          <p className="fl-muted">
            Paste this into Claude Code, Codex or Cursor. It reads the manual, shows you the sign-in link, and does
            the rest.
          </p>
          <blockquote className="fl-prompt">{AGENT_PROMPT}</blockquote>
          <CopyButton text={AGENT_PROMPT} what="the agent prompt" />
          <p className="fl-muted fl-manual">
            The manual it reads: <a href="/agents.md">agents.md</a>
          </p>
        </div>
      </div>
    </section>
  );
}

function Address({ view }: { view: View }) {
  return (
    <section className="fl-card fl-address" aria-labelledby="fl-address">
      <h2 id="fl-address" className="iw-label">Account address</h2>
      {view.address && view.slug ? (
        <>
          <p className="fl-address-host">
            <code>{view.address}</code>
          </p>
          <p>
            This is your account address. Its first part, <b>{view.slug}</b>, is your slug: finch assigned it when you
            signed up. Every service you publish gets a URL under it, like{' '}
            <code>{`${view.base || `https://${view.address}`}/notes/mcp`}</code>, and that URL stays the same across
            restarts, reboots and networks.
          </p>
        </>
      ) : (
        <p>finch hasn&apos;t assigned your account address yet. Reload this page in a moment.</p>
      )}
    </section>
  );
}

function UpdateHint({ view }: { view: View }) {
  const n = view.oldMachines.length;
  if (!n) return null;
  return (
    <section className="fl-update" aria-labelledby="fl-update">
      <h2 id="fl-update" className="iw-label">Update available</h2>
      <p>
        {view.latestAgent ? `finch ${view.latestAgent} is out. ` : ''}
        {plural(n, 'machine')} still {n === 1 ? 'runs' : 'run'} an older version:{' '}
        {view.oldMachines.map((m, i) => (
          <span key={`${m.service}-${m.machine}-${i}`}>
            {i ? ', ' : ''}
            <b>{m.machine}</b> ({m.service}, {m.version})
          </span>
        ))}
        . On each one, run:
      </p>
      <Command command={cmd.update()} />
    </section>
  );
}

/** The whole instrument for one account. */
export default function FleetView({ view }: { view: View }) {
  const online = view.services.filter((s) => s.status === 'online').length;
  return (
    <>
      <header className="fl-head">
        <div className="fl-head-top">
          <span className="iw-label iw-label-indigo">
            {view.slug ? `${view.slug} · ` : ''}your fleet · read only
          </span>
          <FleetClock readAt={view.readAt} />
        </div>
        <h1>Your fleet</h1>
        <p className="fl-lede">
          Everything finch knows about your account, read from the hub when this page loaded. Nothing here changes
          anything: each action is a finch command you run on a machine. <a href="/fleet">Reload</a> for the
          latest.
        </p>
      </header>

      <Address view={view} />
      <UpdateHint view={view} />

      {view.services.length ? (
        <section className="fl-section" aria-labelledby="fl-services">
          <h2 id="fl-services">Services</h2>
          <p className="fl-lede">
            {plural(view.services.length, 'service')}, {online} online. Bodies of calls pass through finch and are
            never stored; the call list is the whole record.
          </p>
          <div className="fl-svcs">
            {view.services.map((s) => <ServiceCard key={s.id} svc={s} latest={view.latestAgent} />)}
          </div>
        </section>
      ) : (
        <FirstRun />
      )}

      {(view.keys.length > 0 || view.services.length > 0) && (
        <Keys keys={view.keys} firstService={view.services[0]?.id ?? ''} />
      )}
    </>
  );
}

/** Shown when the hub can't be read. */
export function FleetUnavailable({ message }: { message: string }) {
  return (
    <section className="fl-card fl-first" aria-labelledby="fl-down">
      <span className="iw-label iw-label-indigo">Your fleet</span>
      <h1 id="fl-down">finch couldn&apos;t read your fleet just now</h1>
      <p className="fl-lede">{message}</p>
      <p>
        <a href="/fleet">Try again</a>. From a terminal, this shows the same list:
      </p>
      <Command command={cmd.fleet()} />
    </section>
  );
}
