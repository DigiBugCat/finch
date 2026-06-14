export default function Safety() {
  return (
    <section className="sec" id="safety">
      <div className="wrap">
        <div className="sec-head">
          <span className="sec-tag">SAFETY</span>
          <h2>Outbound-only, auth-first, by construction.</h2>
          <p>Security isn&apos;t a setting in Finch — it&apos;s the wiring. Here&apos;s what you get for free, on every endpoint.</p>
        </div>
        <div className="safety-grid">
          <div className="safety">
            <div className="safety-ic">🚪</div>
            <h4>Auth at the door</h4>
            <p>Every caller is verified by Finch before a single request reaches your box.</p>
          </div>
          <div className="safety">
            <div className="safety-ic">🕳️</div>
            <h4>No open ports</h4>
            <p>Your box dials out — it never accepts connections. Runs behind home NAT, CGNAT, any firewall — zero inbound setup.</p>
          </div>
          <div className="safety">
            <div className="safety-ic">🔑</div>
            <h4>You hold the keys</h4>
            <p>Mint access, see who&apos;s holding it, revoke in one tap. Keys are shown once, then masked.</p>
          </div>
          <div className="safety">
            <div className="safety-ic">🏡</div>
            <h4>Private by design</h4>
            <p>Your data stays on your box. Finch routes the request — it never sees or stores what flows through.</p>
          </div>
        </div>
      </div>
    </section>
  );
}
