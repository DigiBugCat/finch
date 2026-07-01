"use client";
// The browser side of `finch login`: the user approves the short device code
// their CLI printed and the hub mints + stamps a CLI token. The code MAY be
// pre-filled from ?code= (one-click UX from verification_uri_complete), but a
// prefilled link alone grants NOTHING: approval still requires a Clerk-signed-in
// session, a deliberate Approve click, and the displayed initiator IP/UA context
// so the user can confirm it's their own box (the anti-phishing binding).
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { UserButton, useUser } from '@clerk/nextjs';

type Origin = { found: boolean; reqIp?: string; reqUa?: string; ageSeconds?: number } | null;

export default function CliApprove() {
  const { user } = useUser();
  // Seed the code from ?code= (pre-filled one-click link). This auto-runs the
  // describe/initiator-context step below; the user still clicks Approve.
  const params = useSearchParams();
  const initialCode = (params.get('code') || '').toUpperCase();
  const [code, setCode] = useState(initialCode);
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const [msg, setMsg] = useState('');
  const [origin, setOrigin] = useState<Origin>(null);   // initiator context for the typed code
  const seq = useRef(0);

  // The account the minted token will act as. Orgs are disabled during beta,
  // so this is always the personal account.
  const account = `${user?.primaryEmailAddress?.emailAddress || user?.username || 'your account'} (personal)`;

  // When a full code is typed, look up WHERE it was started so the user can tell
  // it's their own box (not an attacker-initiated code they were sent).
  useEffect(() => {
    const c = code.trim();
    setOrigin(null);
    if (c.replace(/[^A-Z0-9]/g, '').length < 8) return;
    const mine = ++seq.current;
    const t = setTimeout(async () => {
      try {
        const r = await fetch('/api/finch/cli-describe', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ userCode: c }),
        });
        const j = await r.json();
        if (mine === seq.current) setOrigin(j);
      } catch { /* ignore */ }
    }, 300);
    return () => clearTimeout(t);
  }, [code]);

  async function approve() {
    setState('busy'); setMsg('');
    try {
      // Send the email we already resolved client-side (useUser). On staging the
      // server can't look it up — ctx.userId is the forced DEFAULT_TENANT id, not
      // the real Clerk user — so the client value is what makes the box's account
      // label work. It's a cosmetic label shown only on the approver's own box.
      const email = user?.primaryEmailAddress?.emailAddress || user?.username || '';
      const r = await fetch('/api/finch/cli-approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userCode: code.trim(), email }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'could not approve');
      setState('done');
    } catch (e: any) {
      setState('error'); setMsg(e.message || 'failed');
    }
  }

  return (
    <main className="cli-page">
      <div className="cli-nav">
        <a className="logo" href="/"><span className="logo-mark">🐦</span> Finch</a>
        <UserButton />
      </div>
      <div className="cli-box">
        <span className="eyebrow">🔑 Connect the finch CLI</span>
        <h1>Authorize a device</h1>
        {state === 'done' ? (
          <>
            <p className="cli-sub">Your terminal is now logged in to <b>{account}</b>. Close this tab and head back to it.</p>
            <div className="cli-ok">✓ Device approved</div>
          </>
        ) : (
          <>
            <p className="cli-sub">Type the code your terminal printed after <code className="mono">finch login</code>, then approve.</p>
            <input
              className="cli-code"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="XXXX-XXXX"
              spellCheck={false}
              autoComplete="off"
              autoFocus
            />
            {origin && (origin.found
              ? <div className="cli-origin">
                  <div className="cli-origin-h">This login was started from:</div>
                  <div className="cli-origin-d mono">{origin.reqIp || 'unknown IP'} · {(origin.reqUa || 'unknown client').slice(0, 60)}</div>
                  <div className="cli-origin-age dim">{origin.ageSeconds != null ? `${origin.ageSeconds}s ago` : ''} — approve only if that's the box where you ran <code className="mono">finch login</code>.</div>
                </div>
              : <div className="cli-err">No active login for that code — check it or run <code className="mono">finch login</code> again.</div>)}
            <div className="cli-grant">This grants a CLI token (~30 days) acting as <b>{account}</b>.</div>
            <button type="button" className="btn btn-lg btn-amber" onClick={approve} disabled={state === 'busy' || !origin?.found}>
              {state === 'busy' ? 'Approving…' : 'Approve device'}
            </button>
            {state === 'error' && <div className="cli-err">{msg}</div>}
            <div className="cli-warn">
              ⚠️ Only approve a code <b>you</b> just started with <code className="mono">finch login</code> on a device you control.
              If someone sent you this code, do not approve it — it would give <i>their</i> terminal access to your account.
              You can revoke all CLI tokens anytime in Settings → CLI access.
            </div>
          </>
        )}
      </div>
    </main>
  );
}
