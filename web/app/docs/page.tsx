import type { Metadata } from 'next';
import { docsMetadata } from './meta';
import Link from 'next/link';
import Code from './code';

export const metadata: Metadata = docsMetadata('Quickstart', 'Put a local MCP server online with finch: install, log in, add the service, keep it running, test it and connect a client.');

export default function Quickstart() {
  return (
    <>
      <h1>Quickstart</h1>
      <p className="docs-lede">
        finch gives a server on your machine a stable https address. Your machine
        dials out to finch, so nothing on it listens and no ports open. This page
        starts from nothing: write a hello-world MCP server, then put it online and
        connect it to a client.
      </p>

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
      <p>Run it. It serves MCP over HTTP on your machine:</p>
      <Code>{`python server.py
<span class="o">Uvicorn running on http://127.0.0.1:8000</span>`}</Code>
      <p className="dim">
        Already have a server? Skip to step 2. finch works with any local HTTP app;
        for a web app or a REST API, see{' '}
        <Link href="/docs/services#web-apps">web apps and REST</Link>.
      </p>

      <h2>2. Install finch</h2>
      {/* Explicit https:// — a scheme-less host makes curl default to http://,
          which would pipe an unauthenticated cleartext response into sh. */}
      <Code>{`curl -fsSL https://finchmcp.com/install | sh`}</Code>
      <p>
        It runs on macOS and Linux and never asks for a password. Any machine that
        stays on and runs a shell can run finch: a laptop, a Mac mini, a Raspberry
        Pi, a VPS. Run <code>finch</code> on its own at any time to see every command.
      </p>

      <h2>3. Log in</h2>
      <Code>{`finch login
<span class="o">  To finish login, open this page on any device (your phone or laptop
  is fine — you do NOT need a browser on this machine):

      https://finchmcp.com/cli?code=ZDTJ-9W63

  and confirm this code:  ZDTJ-9W63

  Waiting for approval  ✓
finch: logged in as you@example.com at https://finchmcp.com (saved to /Users/you/.finch/cli.json)</span>`}</Code>
      <p>
        finch opens the sign-in page in your browser and waits. Sign in (or create a
        free account), check that the code matches, and approve it. You can also
        open the link on <strong>any other device</strong>: the machine you run this
        on doesn&apos;t need a browser or a screen. Over SSH, use{' '}
        <code>finch login --headless</code>, which skips the local browser and just
        prints the link.
      </p>
      <p>
        This is the only step that needs you. Everything after it runs without
        prompts and takes <code>--json</code>, so an agent can do the rest (see{' '}
        <a href="/agents.md">agents.md</a>).
      </p>

      <h2>4. Add the service</h2>
      <Code>{`finch add hello --service http://127.0.0.1:8000
<span class="o">finch: added "hello" → http://127.0.0.1:8000</span>
<span class="o">       public URL: https://sunny-wren-42.finchmcp.com/hello/mcp</span>`}</Code>
      <p>
        <code>hello</code> is the service name, and it becomes part of the URL. The
        first part, <code>sunny-wren-42</code>, is your <b>account address</b> (also
        called the slug): finch picks it for your account, and every service
        you publish lives under it. Callers need a key or a sign-in by default; see{' '}
        <Link href="/docs/acls">Access control</Link>.
      </p>
      <p>
        <code>finch add</code> records the service in <code>~/.finch/finch.yml</code>{' '}
        (or in <code>./finch.yml</code> if the current directory has one). The file
        holds no secrets. To point the service at a different port later, run the
        same command again with the new URL.
      </p>

      <h2>5. Keep it running</h2>
      <Code>{`finch service install
<span class="o">finch: installed /Users/you/Library/LaunchAgents/com.finchmcp.finch.plist (launchd) — serves /Users/you/.finch/finch.yml
       installed, running
       log: /Users/you/.finch/finch.log</span>`}</Code>
      <p>
        This runs finch in the background, starts it when you log in and restarts it
        if it stops: a launchd agent on macOS, a systemd user service on Linux. It
        serves every service in <code>finch.yml</code>. Run it again after you add
        or change a service. To serve in the foreground instead, for a quick try,
        run <code>finch run</code> and leave the terminal open.
      </p>

      <h2>6. Test it</h2>
      <Code>{`finch test hello
<span class="o">hello — 1 tool(s):
  • greet            Say hello.</span>
finch call hello greet --args '{"name": "world"}'
<span class="o">Hello, world!</span>`}</Code>
      <p>
        Both go out through finch and back to your machine, so a pass means the
        public address works end to end. If it fails, the message says which part
        didn&apos;t answer: finch, your machine, or your server.
      </p>

      <h2>7. Connect a client</h2>
      <Code>{`finch connect hello --client claude-code   <span class="c"># or cursor, codex</span>`}</Code>
      <p>
        <code>finch connect</code> makes a key for that one client and writes it into
        the client&apos;s settings, so you never copy a key by hand. Reload the
        client&apos;s MCP servers and <code>greet</code> is there.
      </p>
      <p>
        For claude.ai or ChatGPT, add the public URL as a custom connector instead:
        they sign you in to finch in the browser, with no key. For any other client,
        make a key and paste it in as a bearer token:
      </p>
      <Code>{`finch keys mint my-client --service hello
<span class="c"># the finch_ key is shown once; put it in your client now</span>`}</Code>

      <h2>See what&apos;s happening</h2>
      <Code>{`finch status          <span class="c"># this machine: login, services, background service</span>
finch fleet           <span class="c"># every service on your account, its state and URL</span>
finch logs hello      <span class="c"># recent calls: time, route, caller, status, duration</span>`}</Code>
      <p>
        To take a service down, <code>finch rm hello</code>. To remove finch from
        this machine entirely, <code>finch uninstall</code>; the{' '}
        <Link href="/docs/cli#remove">CLI reference</Link> lists what each one
        cleans up.
      </p>

      <div className="docs-note">
        <b>Driving finch with an agent?</b> Point it at{' '}
        <a href="/agents.md">/agents.md</a>, or run <code>finch guide</code> for the
        same steps from the installed binary. The agent does all of the above and
        shows you the sign-in link.
      </div>

      <h2>Where to next</h2>
      <div className="docs-cards">
        <Link className="docs-card" href="/docs/services">
          <h3>Services &amp; machines</h3>
          <p>finch.yml, web apps, running in the background, and adding more machines.</p>
        </Link>
        <Link className="docs-card" href="/docs/auth">
          <h3>Keys &amp; auth</h3>
          <p>Mint, list and revoke keys, and how finch checks them before your machine.</p>
        </Link>
        <Link className="docs-card" href="/docs/acls">
          <h3>Access control</h3>
          <p>Keys, OAuth and public services: who can reach what.</p>
        </Link>
        <Link className="docs-card" href="/docs/cli">
          <h3>CLI reference</h3>
          <p>Every command, with JSON output for scripts and agents.</p>
        </Link>
        <Link className="docs-card" href="/docs/privacy">
          <h3>Privacy &amp; data handling</h3>
          <p>What finch sees in transit, and the little it keeps.</p>
        </Link>
        <Link className="docs-card" href="/docs/aviarymcp">
          <h3>AviaryMCP</h3>
          <p>A Python SDK that serves one set of tools as MCP, REST and OpenAPI.</p>
        </Link>
      </div>
    </>
  );
}
