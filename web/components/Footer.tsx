import Link from 'next/link';

export default function Footer() {
  return (
    <footer>
      <div className="wrap">
        <div className="foot-grid">
          <div className="foot-brand">
            <a className="logo" href="#top"><span className="logo-mark">🐦</span> Finch</a>
            <p>Secure public endpoints for your MCP services, hosted on your own boxes.</p>
          </div>
          <div className="foot-col">
            <h5>Product</h5>
            <a href="#how">How it works</a>
            <a href="#abilities">Abilities</a>
            <a href="#safety">Safety</a>
            <a href="#pricing">Pricing</a>
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
          <span>© finchmcp.com</span>
        </div>
      </div>
    </footer>
  );
}
