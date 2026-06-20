"use client";
// "Test in chat" — a chat window on the appliance detail. An LLM (Workers AI)
// calls THIS appliance's MCP tools so you can confirm it works without leaving
// the dashboard. Relays via the web's service auth — no finch_ key needed.
import { useEffect, useRef, useState } from 'react';
import { Card, SectionLabel } from '@/components/dash/primitives';

type Item =
  | { kind: 'msg'; role: 'user' | 'assistant'; content: string; err?: boolean }
  | { kind: 'tool'; tool: string; args: any; result: string };

export function ChatPanel({ appliance, online }: { appliance: string; online: boolean }) {
  const [items, setItems] = useState<Item[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const hist = useRef<{ role: string; content: string }[]>([]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items, busy]);

  async function send() {
    const t = input.trim();
    if (!t || busy) return;
    setInput('');
    setItems((m) => [...m, { kind: 'msg', role: 'user', content: t }]);
    hist.current.push({ role: 'user', content: t });
    setBusy(true);
    try {
      const r = await fetch('/api/finch/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ appliance, messages: hist.current }),
      });
      const j = await r.json();
      const add: Item[] = (j.trace || []).map((x: any) => ({ kind: 'tool', tool: x.tool, args: x.args, result: x.result }));
      if (j.error) {
        add.push({ kind: 'msg', role: 'assistant', content: '⚠️ ' + j.error, err: true });
      } else {
        add.push({ kind: 'msg', role: 'assistant', content: j.reply || '(no reply)' });
        hist.current.push({ role: 'assistant', content: j.reply || '' });
      }
      setItems((m) => [...m, ...add]);
    } catch (e: any) {
      setItems((m) => [...m, { kind: 'msg', role: 'assistant', content: '⚠️ ' + (e.message || 'failed'), err: true }]);
    }
    setBusy(false);
  }

  return (
    <Card className="connect-card chatd-card">
      <SectionLabel hint="ask an LLM to use this appliance's tools — a live check it works">test in chat</SectionLabel>

      {!online ? (
        <div className="url-pending mono big-pending">🌙 resting — start the box to chat with its tools.</div>
      ) : (
        <div className="chatd-win">
          <div className="chatd-winbar">
            <span className="chatd-wintitle">🐦 Assistant</span>
            <span className="chatd-winmeta mono">Workers AI · gemma · calls {appliance}'s tools</span>
          </div>

          <div className="chatd-log" ref={logRef}>
            {items.length === 0 && (
              <div className="chatd-empty">Ask anything — the model will call <b className="mono">{appliance}</b>'s tools to answer.</div>
            )}
            {items.map((it, i) =>
              it.kind === 'tool' ? (
                <div key={i} className="chatd-tool mono">
                  <span className="chatd-toolname">🔧 {it.tool}</span>
                  <span className="chatd-toolargs">{JSON.stringify(it.args || {})}</span>
                  <span className="chatd-toolres">→ {it.result}</span>
                </div>
              ) : (
                <div key={i} className={`chatd-line ${it.role}`}>
                  <span className="chatd-ava">{it.role === 'user' ? '🧑' : '🐦'}</span>
                  <div className={`chatd-bub ${it.err ? 'err' : ''}`}>{it.content}</div>
                </div>
              ),
            )}
            {busy && (
              <div className="chatd-line assistant">
                <span className="chatd-ava">🐦</span>
                <div className="chatd-bub"><span className="chatd-dots" /></div>
              </div>
            )}
          </div>

          <div className="chatd-composer">
            <input
              className="chatd-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
              placeholder={`Message ${appliance}…`}
            />
            <button type="button" className="chatd-send" onClick={send} disabled={busy || !input.trim()} aria-label="Send">↑</button>
          </div>
        </div>
      )}
    </Card>
  );
}
