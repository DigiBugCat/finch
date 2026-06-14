import Link from 'next/link';

export default function Pricing() {
  return (
    <section className="sec sec-bg2" id="pricing">
      <div className="wrap">
        <div className="sec-head">
          <span className="sec-tag">PRICING</span>
          <h2>Start free. Grow your flock.</h2>
          <p>Your first device is free forever. Add more whenever you're ready.</p>
        </div>
        <div className="price-grid">
          <div className="price">
            <div className="price-name">Free</div>
            <div className="price-tag">For your first device</div>
            <div className="price-amt"><span className="n">$0</span><span className="per">forever</span></div>
            <ul className="price-feats">
              <li><span className="ck">✓</span> 1 device</li>
              <li><span className="ck">✓</span> Unlimited AI connections</li>
              <li><span className="ck">✓</span> One-tap links & keys</li>
              <li><span className="ck">✓</span> Community support</li>
            </ul>
            <Link className="btn btn-md btn-ghost" href="/sign-up">Start free</Link>
          </div>
          <div className="price feat">
            <div className="price-badge">MOST POPULAR</div>
            <div className="price-name">Plus</div>
            <div className="price-tag">For your whole setup</div>
            <div className="price-amt"><span className="n">$8</span><span className="per">/ month</span></div>
            <ul className="price-feats">
              <li><span className="ck">✓</span> Unlimited devices</li>
              <li><span className="ck">✓</span> OAuth sign-in for your tools</li>
              <li><span className="ck">✓</span> Activity history</li>
              <li><span className="ck">✓</span> Custom hub domain</li>
              <li><span className="ck">✓</span> Email support</li>
            </ul>
            <Link className="btn btn-md btn-amber" href="/sign-up">Get Plus</Link>
          </div>
          <div className="price">
            <div className="price-name">Flock</div>
            <div className="price-tag">For teams</div>
            <div className="price-amt"><span className="n">$20</span><span className="per">/ user / mo</span></div>
            <ul className="price-feats">
              <li><span className="ck">✓</span> Everything in Plus</li>
              <li><span className="ck">✓</span> Shared devices & roles</li>
              <li><span className="ck">✓</span> Per-teammate keys</li>
              <li><span className="ck">✓</span> Full audit log</li>
              <li><span className="ck">✓</span> Priority support</li>
            </ul>
            <Link className="btn btn-md btn-ghost" href="/sign-up">Talk to us</Link>
          </div>
        </div>
      </div>
    </section>
  );
}
