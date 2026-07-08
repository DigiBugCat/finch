import Link from 'next/link';
import { Show } from '@clerk/nextjs';

export default function Hero() {
  return (
    <section className="hero">
      <div className="wrap hero-grid">
        <div className="hero-copy">
          <span className="eyebrow">🌙 Now in <b>beta</b> · free during beta</span>
          <h1>Turn any MCP service into<br />a <span className="soft">secure public endpoint.</span></h1>
          <p className="hero-sub">Point Finch at a Mac mini, a Pi, or the server humming under your desk. You write the tool logic. Finch handles auth, routing, and hosting. Outbound-only: nothing listens, no ports to open.</p>
          <div className="hero-cta">
            <Show when="signed-out">
              <Link className="btn btn-lg btn-amber" href="/sign-up">Get started →</Link>
            </Show>
            <Show when="signed-in">
              <Link className="btn btn-lg btn-amber" href="/dashboard">Open dashboard →</Link>
            </Show>
            <a className="btn btn-lg btn-ghost" href="#how">See how it works</a>
          </div>
          <div className="hero-trust">
            <span><i>✓</i> Speaks MCP: Claude, Cursor, any client</span>
            <span><i>✓</i> One command to set up</span>
            <span><i>✓</i> Your keys, your box, your data</span>
          </div>
        </div>

        <div className="preview-stage">
          <div className="float float-1"><span className="fi">🔒</span> Authed at the door</div>
          <div className="float float-2"><span className="fi">●</span> 3 online</div>
          <div className="preview">
            <div className="pv-top">
              <span className="pv-dot"></span><span className="pv-dot"></span><span className="pv-dot"></span>
              <span className="pv-title">🐦 Finch</span>
              <span className="pv-host mono">maray.finchmcp.com</span>
            </div>
            <div className="pv-head">
              <div>
                <h4>Your services</h4>
                <div className="pv-sub"><b className="green">3 online</b> · 1 offline</div>
              </div>
              <div className="pv-perch"><i></i><i></i><i></i><i></i><i></i></div>
            </div>
            <div className="pv-rows">
              <div className="pv-row">
                <span className="pv-av">🐦</span><span className="pv-id">web-scraper</span>
                <span className="pv-pill on"><span className="d"></span>online</span>
                <span className="pv-url"><span>…/web-scraper/mcp</span><b>Copy</b></span>
              </div>
              <div className="pv-row">
                <span className="pv-av">🐦</span><span className="pv-id">transcribe</span>
                <span className="pv-pill on"><span className="d"></span>online</span>
                <span className="pv-url"><span>…/transcribe/mcp</span><b>Copy</b></span>
              </div>
              <div className="pv-row">
                <span className="pv-av">🐦</span><span className="pv-id">embeddings</span>
                <span className="pv-pill on"><span className="d"></span>online</span>
                <span className="pv-url"><span>…/embeddings/mcp</span><b>Copy</b></span>
              </div>
              <div className="pv-row">
                <span className="pv-av off">🐦</span><span className="pv-id" style={{ color: 'var(--dim)' }}>finance-tools</span>
                <span className="pv-pill off">offline</span>
                <span className="pv-url" style={{ opacity: '.5' }}><span>—</span></span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
