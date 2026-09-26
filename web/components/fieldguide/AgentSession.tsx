"use client";
// Plate V's instrument: an agent session typing itself out, with the phone
// approval sliding in while `finch login --poll` waits. The server (and any
// viewer who prefers reduced motion) gets the finished session; the loop only
// runs on the client while the plate is on screen.
import { useEffect, useRef, useState } from 'react';
import { BirdMark } from './Bird';
import { INSTALL_ONE_LINER } from './prompt';
import { useAnimate } from './useMotion';

type Kind = 'cmd' | 'out' | 'ok' | 'hand';
export type SessionLine = { text: string; kind: Kind };

// Every command here must match the shared CLI contract (see prompt.ts).
export const SESSION: SessionLine[] = [
  { text: `$ ${INSTALL_ONE_LINER}`, kind: 'cmd' },
  { text: 'installed finch 1.4.0 to ~/.local/bin', kind: 'out' },
  { text: '$ finch login --start --json', kind: 'cmd' },
  { text: '{"schema_version":1,"user_code":"QKTM-8FWD","expires_in":900,…}', kind: 'out' },
  { text: 'Open finchmcp.com/cli and approve QKTM-8FWD', kind: 'hand' },
  { text: '$ finch login --poll --json', kind: 'cmd' },
  { text: '{"schema_version":1,"status":"approved","account":"maray"}', kind: 'out' },
  { text: '$ finch add notes --service http://127.0.0.1:8000', kind: 'cmd' },
  { text: '$ finch service install', kind: 'cmd' },
  { text: '✓ started, and set to start at login', kind: 'ok' },
  { text: '$ finch test notes', kind: 'cmd' },
  { text: '✓ 4 tools: search_notes, read_note, write_note, list_tags', kind: 'ok' },
  { text: '$ finch connect notes --client claude-code', kind: 'cmd' },
  { text: '✓ added notes to Claude Code', kind: 'ok' },
];

const LAST_STEP = 17; // a few beats of rest on the finished session, then loop
const STEP_MS = 650;

export default function AgentSession() {
  const ref = useRef<HTMLDivElement>(null);
  const animate = useAnimate(ref);
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (!animate) return;
    setStep(0);
    const id = setInterval(() => setStep((s) => (s >= LAST_STEP ? 0 : s + 1)), STEP_MS);
    return () => clearInterval(id);
  }, [animate]);

  const at = animate ? step : SESSION.length;
  const shown = SESSION.slice(0, Math.min(at, SESSION.length));
  const phoneShown = at >= 5 && at <= 16;
  const approved = at >= 7;

  return (
    <div className="fg-session" ref={ref}>
      <div className="fg-term" role="group" aria-label="Example agent session">
        <div className="fg-term-bar">agent session · ~/notes-server</div>
        {/* The whole transcript for assistive tech; the typed copy is decoration. */}
        <pre className="sr-only">{SESSION.map((l) => l.text).join('\n')}</pre>
        <div className="fg-term-scroll" aria-hidden="true">
          <div className="fg-term-lines">
            {shown.map((l, i) => (
              <span key={i} className={`fg-term-${l.kind}${animate ? ' fg-rowin' : ''}`}>{l.text}</span>
            ))}
            <span className="iw-blink fg-term-cursor">▍</span>
          </div>
        </div>
      </div>
      {/* Decorative: the approval step is already in the transcript above. */}
      <div className={`fg-phone${phoneShown ? ' is-shown' : ''}`} aria-hidden="true">
        <div className="fg-phone-screen">
          <BirdMark width={34} height={26} />
          <span className="fg-phone-q">Let a CLI sign in as maray?</span>
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
