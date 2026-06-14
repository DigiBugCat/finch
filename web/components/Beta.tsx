import Link from 'next/link';

export default function Beta() {
  return (
    <section className="sec sec-bg2" id="beta">
      <div className="wrap">
        <div className="sec-head">
          <span className="sec-tag">BETA</span>
          <h2>It&apos;s early. It&apos;s free. Come build.</h2>
          <p>Finch is in open beta and free while we&apos;re here — no card, no tiers, no per-seat math. The flock is small. Paid plans land eventually, but everyone who flies in now is an early bird, and early birds get kept that way.</p>
        </div>
        <div className="final-card" style={{ maxWidth: 680, margin: '0 auto', textAlign: 'left' }}>
          <div className="split-list">
            <div className="split-item"><span className="ck">✓</span><div><b>Free for the whole beta</b><span>Bring as many boxes as you want. No device cap, no usage meter, no upsell nag.</span></div></div>
            <div className="split-item"><span className="ck">✓</span><div><b>Early-bird pricing, grandfathered</b><span>When paid plans land, the beta flock locks in early-supporter pricing and keeps it. You were here first; we remember.</span></div></div>
            <div className="split-item"><span className="ck">✓</span><div><b>A direct line to the builders</b><span>File a sharp edge and watch it get filed down. You&apos;re shaping what Finch becomes — not waiting on a roadmap.</span></div></div>
          </div>
          <div className="final-cta" style={{ marginTop: 28, justifyContent: 'flex-start' }}>
            <Link className="btn btn-lg btn-amber" href="/sign-up">Join the beta →</Link>
          </div>
          <p style={{ marginTop: 14, fontSize: 13.5, color: 'var(--dim2)' }}>No pricing page yet. That&apos;s on purpose.</p>
        </div>
      </div>
    </section>
  );
}
