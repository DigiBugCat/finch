import Link from 'next/link';

export default function Footer() {
  return (
    <footer>
      <div className="wrap">
        <div className="foot-grid">
          <div className="foot-brand">
            <a className="logo" href="#top"><span className="logo-mark">🐦</span> Finch</a>
            <p>The open roost for MCP services. Send a box home, hand over the endpoint, and let your agent reach the real world.</p>
          </div>
          <div className="foot-col">
            <h5>Product</h5>
            <a href="#how">How it works</a>
            <a href="#abilities">Abilities</a>
            <a href="#safety">Safety</a>
            <a href="#beta">Beta</a>
            <Link href="/dashboard">Dashboard</Link>
          </div>
          <div className="foot-col">
            <h5>Resources</h5>
            <a href="#">Docs</a>
            <a href="#">Build an ability</a>
            <a href="#faq">FAQ</a>
            <a href="#">Status</a>
          </div>
          <div className="foot-col">
            <h5>Company</h5>
            <a href="#">About</a>
            <a href="#">Blog</a>
            <a href="#">Privacy</a>
            <a href="#">Contact</a>
          </div>
        </div>
        <div className="foot-bot">
          <span>© 2026 Finch · finchmcp.com</span>
          <span>Made at dusk 🌙</span>
        </div>
      </div>
    </footer>
  );
}
