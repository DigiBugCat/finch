"use client";
import { useState } from 'react';
import { AGENT_PROMPT } from './prompt';

type State = 'idle' | 'copied' | 'failed';

const LABEL: Record<State, string> = {
  idle: 'Copy the agent prompt',
  copied: 'Copied. Paste it into your agent',
  failed: 'Could not copy. The prompt is under For agents',
};

export default function CopyPromptButton({ className = '' }: { className?: string }) {
  const [state, setState] = useState<State>('idle');

  async function copy() {
    try {
      if (!navigator.clipboard) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(AGENT_PROMPT);
      setState('copied');
    } catch {
      setState('failed');
    }
  }

  return (
    <button type="button" className={`iw-btn iw-btn-primary ${className}`.trim()} onClick={copy}>
      <span aria-live="polite">{LABEL[state]}</span>
    </button>
  );
}
