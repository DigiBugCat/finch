export default function ValuePillars() {
  return (
    <section className="sec">
      <div className="wrap">
        <div className="sec-head">
          <span className="sec-tag">WHY FINCH</span>
          <h2>Skip the auth stack.</h2>
          <p>Your MCP server already works on localhost. Making it safely reachable from anywhere is the part nobody wants to build.</p>
        </div>
        <div className="ba">
          <div className="ba-card ba-before">
            <div className="ba-h"><span className="ba-tag">WITHOUT FINCH</span></div>
            <ul className="ba-list">
              <li><span className="ba-x">✗</span>Rent and patch a VPS</li>
              <li><span className="ba-x">✗</span>Open a port or babysit a tunnel</li>
              <li><span className="ba-x">✗</span>Set up TLS and renew certs</li>
              <li><span className="ba-x">✗</span>Write an auth layer yourself</li>
              <li><span className="ba-x">✗</span>Issue, rotate, and revoke keys by hand</li>
              <li><span className="ba-x">✗</span>Track who can reach what</li>
            </ul>
          </div>
          <div className="ba-card ba-after">
            <div className="ba-h"><span className="ba-tag ba-tag-ok">WITH FINCH</span></div>
            <div className="ba-term mono">
              <div><span className="ba-prompt">$</span> fastmcp run server.py</div>
              <div><span className="ba-prompt">$</span> finch add . --service localhost:8000</div>
              <div className="ba-ok">✓ https://you.finchmcp.com/notes/mcp</div>
            </div>
            <ul className="ba-list">
              <li><span className="ba-ck">✓</span>Public URL with TLS</li>
              <li><span className="ba-ck">✓</span>Auth checked before anything reaches your box</li>
              <li><span className="ba-ck">✓</span>Keys and access managed in one dashboard</li>
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}
