import Link from 'next/link';

export default function FinalCta() {
  return (
    <section className="final">
      <div className="wrap">
        <div className="final-card">
          <h2>Bring your devices home.</h2>
          <p>Wake your first device, hand the link to your AI, and watch it start chirping. Free to begin — no card, no servers, no fuss.</p>
          <div className="final-cta">
            <Link className="btn btn-lg btn-amber" href="/sign-up">Start free →</Link>
            <a className="btn btn-lg btn-ghost" href="#how">See how it works</a>
          </div>
        </div>
      </div>
    </section>
  );
}
