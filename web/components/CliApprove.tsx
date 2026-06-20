"use client";
// The browser side of `finch login`: the user confirms the short device code
// their CLI printed, and we approve it (mint + stamp a CLI token on the hub).
import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { UserButton } from '@clerk/nextjs';

export default function CliApprove() {
  const params = useSearchParams();
  const [code, setCode] = useState((params.get('code') || '').toUpperCase());
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const [msg, setMsg] = useState('');

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
        <h1>Authorize this device</h1>
        {state === 'done' ? (
          <>
            <p className="cli-sub">You're all set — your terminal is now logged in. You can close this tab and head back to it.</p>
            <div className="cli-ok">✓ Device approved</div>
          </>
        ) : (
          <>
            <p className="cli-sub">Confirm the code shown in your terminal, then approve.</p>
            <input
              className="cli-code"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="XXXX-XXXX"
              spellCheck={false}
              autoFocus
            />
            <button type="button" className="btn btn-lg btn-amber" onClick={approve} disabled={state === 'busy' || code.trim().length < 4}>
              {state === 'busy' ? 'Approving…' : 'Approve device'}
            </button>
            {state === 'error' && <div className="cli-err">{msg}</div>}
            <p className="set-hint dim" style={{ marginTop: 18 }}>
              Only approve a code you started yourself with <code className="mono">finch login</code>. It grants your terminal access to this account.
            </p>
          </>
        )}
      </div>
    </main>
  );
}
