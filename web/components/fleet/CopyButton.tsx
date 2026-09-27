"use client";
// A small quiet "Copy" button for one string the page already shows (a URL or
// a finch command). It only writes to the clipboard; nothing on /fleet changes
// anything in the account.
import { useEffect, useState } from 'react';

type State = 'idle' | 'copied' | 'failed';

export default function CopyButton({ text, what }: { text: string; what: string }) {
  const [state, setState] = useState<State>('idle');

  useEffect(() => {
    if (state === 'idle') return;
    const t = setTimeout(() => setState('idle'), 2400);
    return () => clearTimeout(t);
  }, [state]);

  async function copy() {
    try {
      if (!navigator.clipboard) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(text);
      setState('copied');
    } catch {
      setState('failed');
    }
  }

  const label = state === 'copied' ? 'Copied' : state === 'failed' ? 'Select it to copy' : 'Copy';
  return (
    <button type="button" className="fl-copy" onClick={copy} aria-label={`Copy ${what}`}>
      <span aria-hidden="true">{label}</span>
      <span className="sr-only" role="status">
        {state === 'copied' ? `Copied ${what}` : state === 'failed' ? `Could not copy ${what}. Select the text to copy it.` : ''}
      </span>
    </button>
  );
}
