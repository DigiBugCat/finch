import Link from 'next/link';

export default function FlockSplit() {
  return (
    <section className="sec sec-bg2">
      <div className="wrap split">
        <div>
          <span className="sec-tag">THE FLOCK</span>
          <h2>One cozy place to watch them all.</h2>
          <p className="lede">A calm dashboard, not a control room. See who's awake at a glance, grab any link in a tap, and add a device in under a minute.</p>
          <div className="split-list">
            <div className="split-item"><span className="ck">✓</span><div><b>Ambient health</b><span>The perch meter glows green for every device that's online. Read your whole flock in half a second.</span></div></div>
            <div className="split-item"><span className="ck">✓</span><div><b>One-tap links</b><span>Copy any MCP address straight into your AI app — masked when it's a secret, full when you copy.</span></div></div>
            <div className="split-item"><span className="ck">✓</span><div><b>Honest states</b><span>Chirping, resting, or just invited — Finch always tells you the truth about what's online.</span></div></div>
          </div>
          <div style={{ marginTop: '30px' }}><Link className="btn btn-lg btn-ghost" href="/dashboard">Open the dashboard →</Link></div>
        </div>
        <div className="split-visual">
          <div className="pv-top">
            <span className="pv-dot"></span><span className="pv-dot"></span><span className="pv-dot"></span>
            <span className="pv-title">🐦 Finch</span><span className="pv-host mono">your flock</span>
          </div>
          <div className="pv-head">
            <div><h4>Your flock, this evening 🌙</h4><div className="pv-sub"><b className="green">4 chirping</b> · 2 resting · <b className="amber">1 invited</b></div></div>
            <div className="pv-perch"><i></i><i></i><i></i><i></i><i></i></div>
          </div>
          <div className="pv-rows">
            <div className="pv-row"><span className="pv-av">🐦</span><span className="pv-id">thermal-printer</span><span className="pv-pill on"><span className="d"></span>in use</span><span className="pv-url"><span>…/printer/mcp</span><b>Copy</b></span></div>
            <div className="pv-row"><span className="pv-av">🐦</span><span className="pv-id">web-scraper</span><span className="pv-pill on"><span className="d"></span>chirping</span><span className="pv-url"><span>…/scraper/mcp</span><b>Copy</b></span></div>
            <div className="pv-row"><span className="pv-av">🐦</span><span className="pv-id">embeddings</span><span className="pv-pill on"><span className="d"></span>chirping</span><span className="pv-url"><span>…/embeddings/mcp</span><b>Copy</b></span></div>
            <div className="pv-row"><span className="pv-av off">🐦</span><span className="pv-id" style={{ color: 'var(--dim)' }}>nightly-backups</span><span className="pv-pill off">resting</span><span className="pv-url" style={{ opacity: '.5' }}><span>—</span></span></div>
          </div>
        </div>
      </div>
    </section>
  );
}
