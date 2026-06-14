import Link from 'next/link';

export default function Hero() {
  return (
    <section className="hero">
      <div className="wrap hero-grid">
        <div className="hero-copy">
          <span className="eyebrow">🌙 <b>New</b> · the cozy home for your AI&apos;s tools</span>
          <h1>Your AI, meet<br />the <span className="soft">real world.</span></h1>
          <p className="hero-sub">Finch turns any spare computer — a Mac mini, a Raspberry Pi, that laptop in the closet — into a safe, always-on helper your AI can actually use. No servers. No wiring. No open ports.</p>
          <div className="hero-cta">
            <Link className="btn btn-lg btn-amber" href="/sign-up">Start free →</Link>
            <a className="btn btn-lg btn-ghost" href="#how">See how it works</a>
          </div>
          <div className="hero-trust">
            <span><i>✓</i> Works with Claude, Cursor &amp; any MCP app</span>
            <span><i>✓</i> Free for your first device</span>
            <span><i>✓</i> Your keys, your data</span>
          </div>
        </div>

        <div className="preview-stage">
          <div className="float float-1"><span className="fi">🔒</span> Authed at the door</div>
          <div className="float float-2"><span className="fi">●</span> 3 chirping</div>
          <div className="preview">
            <div className="pv-top">
              <span className="pv-dot"></span><span className="pv-dot"></span><span className="pv-dot"></span>
              <span className="pv-title">🐦 Finch</span>
              <span className="pv-host mono">maray.finchmcp.com</span>
            </div>
            <div className="pv-head">
              <div>
                <h4>Your flock, this evening 🌙</h4>
                <div className="pv-sub"><b className="green">3 chirping</b> · 1 resting</div>
              </div>
              <div className="pv-perch"><i></i><i></i><i></i><i></i><i></i></div>
            </div>
            <div className="pv-rows">
              <div className="pv-row">
                <span className="pv-av">🐦</span><span className="pv-id">web-scraper</span>
                <span className="pv-pill on"><span className="d"></span>chirping</span>
                <span className="pv-url"><span>…/web-scraper/mcp</span><b>Copy</b></span>
              </div>
              <div className="pv-row">
                <span className="pv-av">🐦</span><span className="pv-id">transcribe</span>
                <span className="pv-pill on"><span className="d"></span>chirping</span>
                <span className="pv-url"><span>…/transcribe/mcp</span><b>Copy</b></span>
              </div>
              <div className="pv-row">
                <span className="pv-av">🐦</span><span className="pv-id">embeddings</span>
                <span className="pv-pill on"><span className="d"></span>chirping</span>
                <span className="pv-url"><span>…/embeddings/mcp</span><b>Copy</b></span>
              </div>
              <div className="pv-row">
                <span className="pv-av off">🐦</span><span className="pv-id" style={{ color: 'var(--dim)' }}>finance-tools</span>
                <span className="pv-pill off">resting</span>
                <span className="pv-url" style={{ opacity: '.5' }}><span>—</span></span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
