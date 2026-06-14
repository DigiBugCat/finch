export default function Safety() {
  return (
    <section className="sec" id="safety">
      <div className="wrap">
        <div className="sec-head">
          <span className="sec-tag">SAFETY</span>
          <h2>Built so you never have to worry.</h2>
          <p>Security isn&apos;t a setting in Finch — it&apos;s the foundation. Here&apos;s what&apos;s handled for you, always.</p>
        </div>
        <div className="safety-grid">
          <div className="safety">
            <div className="safety-ic">🚪</div>
            <h4>Auth at the door</h4>
            <p>Every caller is verified by Finch before a single request reaches your device.</p>
          </div>
          <div className="safety">
            <div className="safety-ic">🕳️</div>
            <h4>No open ports</h4>
            <p>Your device dials out — it never accepts connections. Works behind any home wifi, no setup.</p>
          </div>
          <div className="safety">
            <div className="safety-ic">🔑</div>
            <h4>You hold the keys</h4>
            <p>Hand out access, see who has it, and revoke it in one tap. Keys are shown once, then masked.</p>
          </div>
          <div className="safety">
            <div className="safety-ic">🏡</div>
            <h4>Private by design</h4>
            <p>Your data stays on your devices. Finch routes the request — it never keeps your stuff.</p>
          </div>
        </div>
      </div>
    </section>
  );
}
