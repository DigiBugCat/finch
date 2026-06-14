"use client";

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
        <div className="steps">
          <div className="step">
            <div className="step-n"></div>
            <h3>Pick a box</h3>
            <p>Anything that stays on and runs a shell — a Mac mini, a Pi, a spare Linux box. If it can hold a process, it can hold a roost.</p>
          </div>
          <div className="step">
            <div className="step-n"></div>
            <h3>Bring it home</h3>
            <p>Run one line. The box dials out to Finch, joins your flock, and starts chirping — no port-forwarding, no firewall holes.</p>
            <div className="step-code">
              <code id="install-cmd">curl -fsSL finchmcp.com/install | sh</code>
              <button className="copybtn" data-copy="curl -fsSL finchmcp.com/install | sh" onClick={handleCopy}>Copy</button>
            </div>
          </div>
          <div className="step">
            <div className="step-n"></div>
            <h3>Hand off the URL</h3>
            <p>Each ability publishes its own MCP endpoint. Drop the URL into any client and your agent is holding the tool — auth already handled.</p>
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
