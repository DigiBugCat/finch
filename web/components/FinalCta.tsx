import Link from 'next/link';

export default function FinalCta() {
  return (
    <section className="final">
      <div className="wrap">
        <div className="final-card">
          <h2>Bring your boxes home.</h2>
          <p>Run one line, hand off the URL, and watch it start chirping. Free while we're in beta — no card, no rented servers, no open ports.</p>
          <div className="final-cta">
            <Link className="btn btn-lg btn-amber" href="/sign-up">Get started →</Link>
            <a className="btn btn-lg btn-ghost" href="#how">See how it works</a>
          </div>
        </div>
      </div>
    </section>
  );
}
