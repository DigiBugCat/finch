import Link from 'next/link';

export default function Beta() {
  return (
    <section className="sec sec-bg2" id="beta">
      <div className="wrap">
        <div className="sec-head">
          <span className="sec-tag">BETA</span>
          <h2>Free during beta.</h2>
          <p>Finch is in beta. It&apos;s free to use right now — paid plans come later.</p>
        </div>
        <div style={{ textAlign: 'center' }}>
          <Link className="btn btn-lg btn-amber" href="/sign-up">Get started →</Link>
        </div>
      </div>
    </section>
  );
}
