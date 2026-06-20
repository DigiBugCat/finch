"use client";
// The browser side of `finch login`: the user TYPES the short device code their
// CLI printed and approves it (the hub mints + stamps a CLI token). We do NOT
// auto-fill the code from the URL — a one-click prefilled link is the phishing
// vector (an attacker starts the flow and sends a victim the link). Requiring a
// typed code + showing exactly which account is being granted is the binding.
import { useState } from 'react';
import { UserButton, useUser, useOrganization } from '@clerk/nextjs';

export default function CliApprove() {
  const { user } = useUser();
  const { organization } = useOrganization();
  const [code, setCode] = useState('');
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const [msg, setMsg] = useState('');

  // The account the minted token will act as (org if active, else personal).
  const account = organization?.name
    ? `${organization.name} (organization)`
    : `${user?.primaryEmailAddress?.emailAddress || user?.username || 'your account'} (personal)`;

  async function approve() {
    setState('busy'); setMsg('');
    try {
      const r = await fetch('/api/finch/cli-approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userCode: code.trim() }),
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
            <div className="cli-grant">This grants a CLI token (~30 days) acting as <b>{account}</b>.</div>
            <button type="button" className="btn btn-lg btn-amber" onClick={approve} disabled={state === 'busy' || code.trim().length < 4}>
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
