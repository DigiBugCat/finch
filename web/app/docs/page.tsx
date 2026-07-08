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
        to the Finch hub, so nothing listens and no ports open. This page takes you
        from a fresh box to a URL you can paste into Claude or Cursor.
      </p>

      <h2>1. Install</h2>
      <Code>{`curl -fsSL finchmcp.com/install | sh`}</Code>
      <p>Works on macOS and Linux. Anything that stays on and runs a shell can run Finch.</p>

      <h2>2. Log in</h2>
      <Code>{`finch login`}</Code>
      <p>
        Opens a browser once to approve a short code. This is the only human step;
        every other command is non-interactive and supports <code>--json</code>.
      </p>

      <h2>3. Add your service</h2>
      <p>Your service must be running locally over HTTP, for example an MCP server on port 8000.</p>
      <Code>{`finch add printer --service http://127.0.0.1:8000`}</Code>
      <p>
        This writes <code>finch.yml</code> next to your project. It holds no secrets,
        so you can commit it.
      </p>

      <h2>4. Run</h2>
      <Code>{`finch run
<span class="o">✓ https://your-slug.finchmcp.com/printer/</span>`}</Code>
      <p>
        One process serves every rule in <code>finch.yml</code>. An MCP server answers
        at <code>/printer/mcp</code>.
      </p>

      <h2>5. Connect a client</h2>
      <p>
        Mint a key, then add the URL to any MCP client with the key as a bearer token:
      </p>
      <Code>{`finch keys mint my-claude --service printer
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
