"use client";
// Plate V's instrument: an agent session typing itself out, with the phone
// approval sliding in while `finch login --poll` waits. The server (and any
// viewer who prefers reduced motion) gets the finished session; the loop only
// runs on the client while the plate is on screen.
import { useEffect, useRef, useState } from 'react';
import { BirdMark } from './Bird';
import { EXAMPLE_URL, INSTALL_ONE_LINER } from './prompt';
import { useAnimate } from './useMotion';

type Kind = 'cmd' | 'out' | 'ok' | 'hand';
export type SessionLine = { text: string; kind: Kind };

// What an agent following agents.md really types and reads back. Every command
// must match the shared CLI contract (see prompt.ts); every JSON line is the
// CLI's real output, trimmed with … where fields are left out, in the order
// the CLI prints them ("schema_version" first, then alphabetical; objects
// nested inside, like each tool, are Go maps, so fully alphabetical). 'hand'
// lines are the agent talking to you, not CLI output.
export const SESSION: SessionLine[] = [
  { text: `$ ${INSTALL_ONE_LINER}`, kind: 'cmd' },
  { text: 'finch: installed to /usr/local/bin/finch', kind: 'out' },
  { text: '$ finch login --start --json', kind: 'cmd' },
  { text: '{"schema_version":1,"expires_in":600,"interval":3,"user_code":"QKTM-8FWD",…}', kind: 'out' },
  { text: 'Open finchmcp.com/cli and approve QKTM-8FWD', kind: 'hand' },
  { text: '$ finch login --poll --json', kind: 'cmd' },
  { text: '{"schema_version":1,"account":"you@example.com","status":"approved"}', kind: 'out' },
  { text: '$ finch add notes --service http://127.0.0.1:8000 --json', kind: 'cmd' },
  { text: `{"schema_version":1,…,"url":"${EXAMPLE_URL}"}`, kind: 'out' },
  { text: '$ finch service install --json', kind: 'cmd' },
  { text: '{"schema_version":1,…,"installed":true,…,"running":true,…}', kind: 'out' },
  { text: '$ finch test notes --json', kind: 'cmd' },
  { text: '{"schema_version":1,"ok":true,"service":"notes","tools":[{"description":"…","name":"search_notes"},…]}', kind: 'out' },
  { text: '$ finch connect notes --client claude-code --json', kind: 'cmd' },
  { text: `{"schema_version":1,"client":"claude-code",…,"name":"notes",…,"url":"${EXAMPLE_URL}"}`, kind: 'out' },
  { text: 'notes is live and connected. Reload MCP servers to use it.', kind: 'hand' },
];

// The loop opens with the install and `finch login --start` already typed, so
// the terminal is never a mostly empty box; the next beat is the agent asking
// you to approve, which is when the phone slides in. It rests a few beats on
// the finished session before it starts over.
export const FIRST_STEP = SESSION.findIndex((l) => l.kind === 'hand');
const LAST_STEP = SESSION.length + 3;
const STEP_MS = 650;
// The phone slides in while the agent waits on the login and stays until the
// session is done; its button turns green once the poll comes back approved.
const PHONE_FROM = SESSION.findIndex((l) => l.kind === 'hand') + 1;
const APPROVED_AT = SESSION.findIndex((l) => l.text.includes('"status":"approved"')) + 1;

export default function AgentSession() {
  const ref = useRef<HTMLDivElement>(null);
  const animate = useAnimate(ref);
  const [step, setStep] = useState(FIRST_STEP);

  useEffect(() => {
    if (!animate) return;
    setStep(FIRST_STEP);
    const id = setInterval(() => setStep((s) => (s >= LAST_STEP ? FIRST_STEP : s + 1)), STEP_MS);
    return () => clearInterval(id);
  }, [animate]);

  const at = animate ? step : SESSION.length;
  const typedCount = Math.min(at, SESSION.length);
  const phoneShown = at >= PHONE_FROM;
  const approved = at >= APPROVED_AT;

  // Only the lines typed so far are laid out, then the cursor. The terminal
  // window has a fixed height (landing.css), so typing never shifts the page:
  // lines fill it from the top and, once it is full, the oldest slide off the
  // top the way a real terminal scrolls. Viewers who prefer reduced motion
  // get the whole finished session at its natural height instead.
  const lines = SESSION.slice(0, typedCount).map((l, i) => (
    <span key={i} className={`fg-term-${l.kind}${animate ? ' fg-rowin' : ''}`}>
      {l.text}
    </span>
  ));
  lines.push(<span key="cursor" className="iw-blink fg-term-cursor">▍</span>);

  return (
    <div className="fg-session" ref={ref}>
      <div className="fg-term" role="group" aria-label="Example agent session">
        <div className="fg-term-bar">agent session · ~/notes-server</div>
        {/* The whole transcript for assistive tech; the typed copy is decoration. */}
        <pre className="sr-only">{SESSION.map((l) => l.text).join('\n')}</pre>
        <div className="fg-term-window" aria-hidden="true">
          <div className="fg-term-lines">{lines}</div>
        </div>
      </div>
      {/* Decorative: the approval step is already in the transcript above. */}
      <div className={`fg-phone${phoneShown ? ' is-shown' : ''}`} aria-hidden="true">
        <div className="fg-phone-screen">
          <BirdMark width={34} height={26} />
          <span className="fg-phone-q">Authorize this machine?</span>
          <span className="fg-phone-code">QKTM-8FWD</span>
          <span className="fg-phone-warn">Only approve a code you just asked for.</span>
          <span className={`fg-phone-approve${approved ? ' is-approved' : ''}`}>
            {approved ? 'Approved ✓' : 'Approve'}
          </span>
        </div>
      </div>
    </div>
  );
}
