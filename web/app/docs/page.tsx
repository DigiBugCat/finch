import Link from 'next/link';

function Code({ children }: { children: string }) {
  return <pre className="docs-code"><code dangerouslySetInnerHTML={{ __html: children }} /></pre>;
}

export default function Quickstart() {
  return (
    <>
      <h1>Quickstart</h1>
      <p className="docs-lede">
        Finch turns a local service into a secure public endpoint. Your box dials out
        to the Finch hub, so nothing listens and no ports open. This page starts from
        zero: write a hello-world MCP server, then put it online.
      </p>

      <div className="docs-note">
        <b>Starting a new Python service?</b>{' '}
        <Link href="/docs/aviarymcp">AviaryMCP</Link> defines each tool once and
        generates MCP, REST, and OpenAPI while managing Finch registration and
        first-run approval. Its public release candidate is available on PyPI.
      </div>

      <h2>1. Write an MCP server</h2>
      <p>
        Any MCP server works. The fastest way to get one is{' '}
        <a href="https://gofastmcp.com" target="_blank" rel="noreferrer">FastMCP</a>:
      </p>
      <Code>{`pip install fastmcp`}</Code>
      <p>Save this as <code>server.py</code>:</p>
      <Code>{`from fastmcp import FastMCP

mcp = FastMCP("hello")

@mcp.tool
def greet(name: str) -> str:
    """Say hello."""
    return f"Hello, {name}!"

if __name__ == "__main__":
    mcp.run(transport="http", port=8000)`}</Code>
      <p>Run it. It serves MCP over HTTP on localhost:</p>
      <Code>{`python server.py
<span class="o">Uvicorn running on http://127.0.0.1:8000</span>`}</Code>
      <p className="dim">
        Already have a server? Skip to step 2. Finch fronts any local HTTP service,
        MCP or not.
      </p>

      <h2>2. Install Finch</h2>
      <Code>{`curl -fsSL finchmcp.com/install | sh`}</Code>
      <p>Works on macOS and Linux. Anything that stays on and runs a shell can run Finch.</p>

      <h2>3. Log in</h2>
      <Code>{`finch login
<span class="o">  To finish login, open this page on any device (your phone or laptop
  is fine — you do NOT need a browser on this machine):

      https://finchmcp.com/cli?code=ZDTJ-9W63

  and confirm this code:  ZDTJ-9W63

  Waiting for approval… ✓ logged in as you@example.com</span>`}</Code>
      <p>
        Finch prints a link and a code, then waits. Open the link on{' '}
        <strong>any device</strong> — the box you run this on doesn&apos;t need a browser
        or even a screen, so a headless server (a Mini, a Pi, a VPS) logs in fine:
        open the link on your phone, confirm the code, and the waiting box gets its
        credential. This is the only human step; every other command is
        non-interactive and supports <code>--json</code>. On a screenless box reached
        over SSH, use <code>finch login --headless</code> — same flow, but it skips
        the (pointless) local browser and flushes the link straight to your terminal.
      </p>
      <p>
        Fully unattended (CI, imaging a fleet) with no human at all? Mint a one-shot
        ticket on a machine that&apos;s already logged in with <code>finch token</code>{' '}
        (or in the dashboard under <em>Add box</em>) and hand it to the new box:{' '}
        <code>finch run --ticket -</code>. For a single box you&apos;re setting up
        yourself, <code>finch login</code> from your phone is the easy path.
      </p>

      <h2>4. Add the service</h2>
      <Code>{`finch add hello --service http://127.0.0.1:8000`}</Code>
      <p>
        This writes <code>finch.yml</code> next to your project. It holds no secrets,
        so you can commit it.
      </p>

      <h2>5. Run</h2>
      <Code>{`finch run
<span class="o">✓ https://your-slug.finchmcp.com/hello/</span>`}</Code>
      <p>
        Your server is now public, with auth checked at the edge. One <code>finch run</code>{' '}
        process serves every rule in <code>finch.yml</code>. An MCP server answers
        at <code>/hello/mcp</code>.
      </p>
      <p>Check it end to end from another terminal:</p>
      <Code>{`finch test hello
<span class="o">hello — 1 tool(s):
  • greet            Say hello.</span>
finch call hello greet --args '{"name": "world"}'
<span class="o">Hello, world!</span>`}</Code>

      <h2>6. Connect a client</h2>
      <p>
        Mint a key, then add the URL to any MCP client (Claude, Cursor, anything that
        speaks MCP) with the key as a bearer token:
      </p>
      <Code>{`finch keys mint my-claude --service hello
<span class="c"># the finch_ key is shown once; store it in your client</span>`}</Code>
      <div className="docs-note">
        <b>Driving Finch with an agent?</b> Run <code>finch guide</code>. It prints a
        self-contained manual an agent can read once and then operate the CLI end to end.
      </div>

      <h2>Where to next</h2>
      <div className="docs-cards">
        <Link className="docs-card" href="/docs/services">
          <h3>Services &amp; boxes</h3>
          <p>How services, boxes, and finch.yml fit together, and enrolling more boxes.</p>
        </Link>
        <Link className="docs-card" href="/docs/aviarymcp">
          <h3>AviaryMCP</h3>
          <p>Build one Python tool surface for MCP, REST, and OpenAPI with native Finch enrollment.</p>
        </Link>
        <Link className="docs-card" href="/docs/auth">
          <h3>Keys &amp; auth</h3>
          <p>Mint, list, and revoke access. How auth is checked before your box.</p>
        </Link>
        <Link className="docs-card" href="/docs/acls">
          <h3>Access control</h3>
          <p>Grant different users and agents access to different services.</p>
        </Link>
        <Link className="docs-card" href="/docs/cli">
          <h3>CLI reference</h3>
          <p>Every command, with JSON output for scripting.</p>
        </Link>
      </div>
    </>
  );
}
