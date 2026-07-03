export default function ValuePillars() {
  return (
    <section className="sec">
      <div className="wrap">
        <div className="sec-head">
          <span className="sec-tag">WHY FINCH</span>
          <h2>Your agent can reason. Give it somewhere to land.</h2>
          <p>A model in a chat window can't touch your hardware, your files, or your home network. Finch hands it a safe perch on a box you already own — no rented server, no public port.</p>
        </div>
        <div className="pillars">
          <div className="pillar">
            <div className="pillar-ic">🐦</div>
            <h3>Wake a box, keep it perched</h3>
            <p>Point Finch at any always-on box. It installs as a service, survives reboots, and re-homes itself on its own — so the perch is there whenever an agent calls.</p>
          </div>
          <div className="pillar">
            <div className="pillar-ic">🔗</div>
            <h3>A real URL, not localhost</h3>
            <p>Every server gets a stable, public MCP endpoint with TLS. Drop it into Claude, Cursor, or your own client and it just answers — from anywhere, no tunnel to babysit.</p>
          </div>
          <div className="pillar">
            <div className="pillar-ic">🔒</div>
            <h3>Authed at the door</h3>
            <p>Finch verifies every caller before a request ever touches your code. You hold the keys. Your box never opens a port to the internet. Ever.</p>
          </div>
        </div>
      </div>
    </section>
  );
}
