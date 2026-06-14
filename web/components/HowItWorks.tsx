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
          <h2>Live in under a minute</h2>
          <p>If you can copy and paste, you can use Finch. Here's the whole thing.</p>
        </div>
        <div className="steps">
          <div className="step">
            <div className="step-n"></div>
            <h3>Pick a device</h3>
            <p>Any computer that stays on works beautifully — a Mac mini, a Raspberry Pi, an old laptop on a shelf.</p>
          </div>
          <div className="step">
            <div className="step-n"></div>
            <h3>Wake it with one line</h3>
            <p>Paste a single command. Your device flies home, joins your flock, and starts chirping.</p>
            <div className="step-code">
              <code id="install-cmd">curl -fsSL finchmcp.com/start | sh</code>
              <button className="copybtn" data-copy="curl -fsSL finchmcp.com/start | sh" onClick={handleCopy}>Copy</button>
            </div>
          </div>
          <div className="step">
            <div className="step-n"></div>
            <h3>Hand the link to your AI</h3>
            <p>Copy your new web address into any AI app. That's it — your assistant can now use your device.</p>
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
