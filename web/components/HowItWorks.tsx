"use client";

// "How it works" flow visual — three stations (client → finch hub → your box),
// connected by live wires with a continuously travelling packet. Built from the
// site's card system (HTML/CSS, not SVG) so it inherits the real type, shadows
// and gradients — and CSS animation is SSR-safe (SMIL was not).
function FlowGraphic() {
  return (
    <div
      className="flow"
      role="img"
      aria-label="An MCP client sends a finch_-authenticated request to the finch hub on Cloudflare; the hub verifies and strips the key, then relays it down the outbound tunnel your box dialed out — no open ports — where the finch CLI serves the tool and streams the result back."
    >
      {/* 1 — client */}
      <div className="flow-stage">
        <div className="flow-card">
          <div className="flow-card-h">
            <span className="flow-ic">🤖</span>
            <span>MCP client<i>Claude · Cursor · any</i></span>
          </div>
          <div className="flow-line"><span className="flow-verb">POST</span><span className="mono">/printer/mcp</span></div>
          <div className="flow-key mono"><span className="flow-lock">🔑</span>Bearer finch_•••••</div>
        </div>
        <span className="flow-cap">your agent calls a tool</span>
      </div>

      {/* wire: request */}
      <div className="flow-wire" aria-hidden="true">
        <span className="flow-wire-label">request</span>
        <span className="flow-track"><span className="flow-packet" /></span>
      </div>

      {/* 2 — finch hub (centerpiece) */}
      <div className="flow-stage">
        <div className="flow-card flow-card--hub">
          <div className="flow-card-h">
            <span className="flow-ic flow-ic--brand">🐦</span>
            <span>finch hub<i>Cloudflare · global edge</i></span>
          </div>
          <div className="flow-checks">
            <span className="flow-chk">✓ key verified</span>
            <span className="flow-chk">✦ key stripped</span>
            <span className="flow-chk">→ routed</span>
          </div>
        </div>
        <span className="flow-cap">auth &amp; routing, out front</span>
      </div>

      {/* wire: outbound tunnel */}
      <div className="flow-wire flow-wire--out" aria-hidden="true">
        <span className="flow-wire-label flow-wire-label--green">outbound tunnel ↩ no open ports</span>
        <span className="flow-track flow-track--green"><span className="flow-packet flow-packet--green" /></span>
      </div>

      {/* 3 — your box: finch (the agent) is separate from your app */}
      <div className="flow-stage">
        <div className="flow-box">
          <div className="flow-box-h"><span>your box</span><i>Mac mini · Pi · server</i></div>

          {/* finch — the agent that dials out */}
          <div className="flow-term">
            <div className="flow-term-bar"><i /><i /><i /><span className="mono">finch · the agent</span></div>
            <div className="flow-term-body mono">
              <div><span className="flow-prompt">$</span> finch up<span className="flow-cursor" /></div>
              <div className="flow-term-ok"><span className="flow-live" /> dialed hub · online</div>
            </div>
          </div>

          {/* loopback: finch forwards to your local server */}
          <div className="flow-loop"><span /><em className="mono">↕ localhost:8000</em><span /></div>

          {/* your actual application — untouched */}
          <div className="flow-app">
            <span className="flow-ic flow-ic--app">🖨️</span>
            <span>printer-server.py<i>your MCP server · plain FastMCP</i></span>
          </div>
        </div>
        <span className="flow-cap">finch fronts your app. your code stays put</span>
      </div>
    </div>
  );
}

export default function HowItWorks() {
  function handleCopy(e: React.MouseEvent<HTMLButtonElement>) {
    const btn = e.currentTarget;
    const text = btn.getAttribute("data-copy") || "";
    navigator.clipboard.writeText(text);
    const original = btn.textContent;
    btn.textContent = "copied ✓";
    btn.classList.add("done");
    setTimeout(() => {
      btn.textContent = original;
      btn.classList.remove("done");
    }, 1200);
  }

  return (
    <section className="sec sec-bg2" id="how">
      <div className="wrap">
        <div className="sec-head">
          <span className="sec-tag">HOW IT WORKS</span>
          <h2>From cold box to live endpoint in a minute</h2>
          <p>One command up. One URL out. That's the whole loop.</p>
        </div>

        <FlowGraphic />

        <div className="steps">
          <div className="step">
            <div className="step-n"></div>
            <h3>Pick a box</h3>
            <p>Anything that stays on and runs a shell: a Mac mini, a Pi, a spare Linux box. If it can run a process, it can run Finch.</p>
          </div>
          <div className="step">
            <div className="step-n"></div>
            <h3>Connect it</h3>
            <p>Run one line. The box dials out to Finch and comes online. No port-forwarding, no firewall holes.</p>
            <div className="step-code">
              <code id="install-cmd">curl -fsSL finchmcp.com/install | sh</code>
              <button className="copybtn" data-copy="curl -fsSL finchmcp.com/install | sh" onClick={handleCopy}>Copy</button>
            </div>
          </div>
          <div className="step">
            <div className="step-n"></div>
            <h3>Hand off the URL</h3>
            <p>Each service gets its own MCP endpoint. Drop the URL into any client. Auth is already handled.</p>
            <div className="step-code">
              <code>maray.finchmcp.com/printer/mcp</code>
              <button className="copybtn" data-copy="https://maray.finchmcp.com/printer/mcp" onClick={handleCopy}>Copy</button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
