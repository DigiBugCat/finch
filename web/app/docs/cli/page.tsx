import Link from 'next/link';

function Code({ children }: { children: string }) {
  return <pre className="docs-code"><code dangerouslySetInnerHTML={{ __html: children }} /></pre>;
}

export default function CliReference() {
  return (
    <>
      <h1>CLI reference</h1>
      <p className="docs-lede">
        Every finch command, grouped by what you do with it. finch runs on macOS and
        Linux, and every command takes <code>--json</code>, so an AI agent can drive the
        whole flow. The only human step is approving the login in a browser. Run{' '}
        <code>finch help</code> for the overview, or <code>finch &lt;command&gt; -h</code>{' '}
        for a single command&apos;s flags.
      </p>

      <div className="docs-note">
        <b>Driving finch with an agent?</b> Point it at{' '}
        <a href="/agents.md">/agents.md</a>, a step-by-step guide written for agents
        (the installed binary prints the same manual with <code>finch guide</code>).
        One paste does it: &ldquo;Read https://finchmcp.com/agents.md and use finch to
        publish my MCP server on http://127.0.0.1:8000 as notes. Show me the sign-in
        link when you get it. Run it as a background service, check it with finch test,
        then connect it to this agent.&rdquo;
      </div>

      <h2>The agent flow</h2>
      <Code>{`finch status --json                                   <span class="c"># what is set up already?</span>
finch login --start --json                            <span class="c"># show the human the link + code</span>
finch login --poll --json                             <span class="c"># every interval seconds until exit 0</span>
finch add notes --service http://127.0.0.1:8000 --json  <span class="c"># prints the public URL</span>
finch service install --json                          <span class="c"># keep it running</span>
finch test notes --json                               <span class="c"># non-zero exit if it does not answer</span>
finch connect notes --client claude-code              <span class="c"># wire it into an MCP client</span>`}</Code>

      <h2>Setup</h2>
      <div className="docs-table-wrap">
        <table>
          <thead>
            <tr><th>Command</th><th>What it does</th></tr>
          </thead>
          <tbody>
            <tr>
              <td><code>finch login --start [--hub URL]</code></td>
              <td>Start a login and return at once. Prints the sign-in link and a short code (JSON: <code>user_code</code>, <code>verification_uri_complete</code>, <code>expires_in</code>, <code>interval</code>) and saves the pending login to <code>~/.finch/login-pending.json</code> (mode 0600).</td>
            </tr>
            <tr>
              <td><code>finch login --poll</code></td>
              <td>Check the pending login once. Exit <code>0</code> when approved (the credential is saved and the pending file removed), <code>10</code> while it waits for approval, <code>11</code> once the code has expired. JSON: <code>{'{"status":"approved"|"pending"|"expired"}'}</code>. Until it resolves, every other command reports <code>APPROVAL_PENDING</code>, even when an older login is saved.</td>
            </tr>
            <tr>
              <td><code>finch login --cancel</code></td>
              <td>Drop a login started with <code>--start</code>. The saved login, if any, works again. JSON: <code>{'{"cancelled":true|false}'}</code>.</td>
            </tr>
            <tr>
              <td><code>finch login [--hub URL] [--headless]</code></td>
              <td>The same login in one blocking step: prints the link and code, opens a browser unless <code>--headless</code>, and waits until you approve. It has no <code>--json</code> form; scripts use <code>--start</code> and <code>--poll</code>.</td>
            </tr>
            <tr>
              <td><code>finch login --token -</code></td>
              <td>Log in with a token minted by <code>finch token</code>, read from stdin (or set <code>FINCH_CLI_TOKEN</code>). Passing the token as an argument still works but warns: it lands in the process table and shell history.</td>
            </tr>
            <tr>
              <td><code>finch add &lt;name&gt; --service &lt;url&gt; [--public]</code></td>
              <td>Enroll a service, add it to <code>finch.yml</code>, and print its public URL (JSON field <code>url</code>). The name becomes the URL segment: <code>&lt;slug&gt;.finchmcp.com/&lt;name&gt;/</code>. <code>--public</code> opens the endpoint to anyone, with no key.</td>
            </tr>
            <tr>
              <td><code>finch service install</code></td>
              <td>Run <code>finch run</code> as a login service that starts at login and restarts if it exits: a launchd LaunchAgent (<code>~/Library/LaunchAgents/com.finchmcp.finch.plist</code>) on macOS, a systemd user unit (<code>finch.service</code>) on Linux. Safe to run again. It exits <code>1</code> if <code>finch run</code> does not come up (the unit stays installed; the message names the log). On a headless Linux box, <code>sudo loginctl enable-linger $USER</code> keeps it running after you log out.</td>
            </tr>
            <tr>
              <td><code>finch service status</code> / <code>uninstall</code></td>
              <td>Report whether the service is installed and running, or stop and remove it. <code>uninstall</code> exits <code>1</code> and keeps the unit if finch could not be stopped.</td>
            </tr>
            <tr>
              <td><code>finch run [--config finch.yml]</code></td>
              <td>Serve every rule in <code>finch.yml</code> in the foreground. Auto-approves services while you are logged in.</td>
            </tr>
            <tr>
              <td><code>finch enroll &lt;name&gt; --ticket -</code></td>
              <td>One time, on a box with no CLI login: trade a one-shot enrollment ticket (stdin, or <code>FINCH_TICKET</code>) for a saved box credential. A logged-in box uses <code>finch add</code> instead.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        Setting up a second machine needs no browser. From a machine that is already
        logged in:
      </p>
      <Code>{`finch token | ssh user@newbox "finch login --token -"
ssh user@newbox "finch add api --service http://127.0.0.1:9000 && finch service install"`}</Code>

      <h2>Connect a client</h2>
      <div className="docs-table-wrap">
        <table>
          <thead>
            <tr><th>Command</th><th>What it does</th></tr>
          </thead>
          <tbody>
            <tr>
              <td><code>finch connect &lt;name&gt; --client claude-code</code></td>
              <td>Mints a <code>finch_</code> key scoped to the service, saves it to <code>~/.finch/connect/&lt;name&gt;.claude-code.json</code> (mode 0600), and adds the server to the current directory&apos;s Claude Code project with <code>claude mcp add-json</code>. The entry&apos;s <code>headersHelper</code> reads the key from that file, so the key never appears in a command line. Claude Code runs the helper only in a trusted workspace. Needs the <code>claude</code> CLI on <code>PATH</code>.</td>
            </tr>
            <tr>
              <td><code>finch connect &lt;name&gt; --client cursor</code></td>
              <td>Mints a key and merges the server into <code>~/.cursor/mcp.json</code>, keeping every other entry.</td>
            </tr>
            <tr>
              <td><code>finch connect &lt;name&gt; --client codex</code></td>
              <td>Mints a key and writes <code>[mcp_servers.&lt;name&gt;]</code> into <code>~/.codex/config.toml</code>, keeping the rest of the file.</td>
            </tr>
            <tr>
              <td><code>finch connect &lt;name&gt; --client json</code></td>
              <td>Mints a key and prints an <code>mcpServers</code> JSON snippet for any other client. This is the only mode that prints the key.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        Each connect creates its own key, labelled with the client and machine, so
        you can revoke one client with <code>finch keys revoke &lt;id&gt;</code> without
        touching the others. The client is checked before a key is minted, and a key
        whose setup fails is revoked again. A public service gets no key. Running
        connect again for Claude Code, Cursor or Codex replaces the entry and revokes
        the key the old entry used (listed as <code>revoked_key_ids</code> in{' '}
        <code>--json</code>), so re-running it rotates the key. Every Claude Code
        project on the machine connected to the same service shares the one headers
        file, so they all move to the new key.
      </p>

      <h2>Inspect</h2>
      <div className="docs-table-wrap">
        <table>
          <thead>
            <tr><th>Command</th><th>What it does</th></tr>
          </thead>
          <tbody>
            <tr>
              <td><code>finch status [--json]</code></td>
              <td>Whether you are logged in (<code>loggedIn</code>) or a login is waiting for approval (<code>login_pending</code>), what the local <code>finch.yml</code> serves, and whether the background service is installed and running. It always exits <code>0</code>; read the fields.</td>
            </tr>
            <tr>
              <td><code>finch fleet [--json]</code></td>
              <td>List every service in the account with its state (online, offline, pending). Alias: <code>finch ls</code>.</td>
            </tr>
            <tr>
              <td><code>finch guide</code></td>
              <td>Print the agent operating manual.</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>Endpoints</h2>
      <div className="docs-table-wrap">
        <table>
          <thead>
            <tr><th>Command</th><th>What it does</th></tr>
          </thead>
          <tbody>
            <tr>
              <td><code>finch test &lt;name&gt;</code></td>
              <td>List the service&apos;s MCP tools through the hub. Exits non-zero when the call fails, including when the server answers with an MCP error.</td>
            </tr>
            <tr>
              <td><code>finch call &lt;name&gt; &lt;tool&gt; [--args &apos;{'{...}'}&apos;]</code></td>
              <td>Invoke one MCP tool through the hub. <code>--args</code> takes a JSON object. A tool that reports an error exits <code>1</code>.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <Code>{`finch test notes
<span class="o">notes — 2 tool(s):</span>
<span class="o">  • search           Search notes</span>
<span class="o">  • read             Read one note</span>
finch call notes search --args '{"q":"finch"}'`}</Code>

      <h2>Keys and tokens</h2>
      <div className="docs-table-wrap">
        <table>
          <thead>
            <tr><th>Command</th><th>What it does</th></tr>
          </thead>
          <tbody>
            <tr>
              <td><code>finch keys mint &lt;label&gt; --service &lt;name&gt;</code></td>
              <td>Mint a client <code>finch_</code> key scoped to one service. The key prints once. <code>--all</code> scopes it to every service instead.</td>
            </tr>
            <tr>
              <td><code>finch keys list</code></td>
              <td>List client keys (id and label).</td>
            </tr>
            <tr>
              <td><code>finch keys revoke &lt;id&gt;</code></td>
              <td>Revoke a client key. Access stops immediately.</td>
            </tr>
            <tr>
              <td><code>finch token [--json | --login]</code></td>
              <td>Mint a fresh CLI token from a logged-in machine, for setting up another one without a browser. <code>--login</code> prints a ready-to-run <code>finch login</code> command that feeds the token on stdin.</td>
            </tr>
            <tr>
              <td><code>finch revoke-tokens</code></td>
              <td>De-authorize every CLI login, including the machine you run it on.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="docs-note">
        <b>Two kinds of credentials.</b> The CLI token is a tenant-admin credential
        (about 30 days) that the machine itself uses. <code>finch_</code> keys are what
        clients present to reach your services. See{' '}
        <Link href="/docs/auth">Keys &amp; auth</Link>.
      </div>

      <h2>Manage</h2>
      <div className="docs-table-wrap">
        <table>
          <thead>
            <tr><th>Command</th><th>What it does</th></tr>
          </thead>
          <tbody>
            <tr>
              <td><code>finch auth &lt;name&gt; public|key</code></td>
              <td>Set whether the public endpoint requires a <code>finch_</code> key. <code>public</code> opens it to anyone.</td>
            </tr>
            <tr>
              <td><code>finch rm &lt;name&gt;</code></td>
              <td>Remove a service from the account.</td>
            </tr>
            <tr>
              <td><code>finch approve &lt;name&gt;</code></td>
              <td>Clear a service&apos;s pending gate. Only needed when you are not logged in; <code>finch run</code> approves automatically otherwise.</td>
            </tr>
            <tr>
              <td><code>finch update [--force]</code></td>
              <td>Self-update the binary from the hub, then restart the running serve cleanly: through launchd or systemd when <code>finch service install</code> manages it. <code>--restart auto|service|self|none</code> controls how.</td>
            </tr>
            <tr>
              <td><code>finch domain ls</code></td>
              <td>List custom hostnames mapped to the account. <code>finch domain add &lt;hostname&gt;</code> and <code>finch domain rm &lt;hostname&gt;</code> manage them. See <Link href="/docs/domains">Domains</Link>.</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>JSON output and exit codes</h2>
      <p>
        Every command takes <code>--json</code>. Success payloads go to stdout and carry{' '}
        <code>&quot;schema_version&quot;:1</code>. Lists are wrapped in an object:{' '}
        <code>finch fleet --json</code> prints <code>{'{"schema_version":1,"services":[…]}'}</code>.
        Errors go to stderr as one line:
      </p>
      <Code>{`{"schema_version":1,"error":{"code":"NOT_LOGGED_IN","message":"not logged in","next":"finch login --start"}}`}</Code>
      <p>
        When <code>next</code> is present, it is the command to run next. Exit codes
        are the same everywhere:
      </p>
      <div className="docs-table-wrap">
        <table>
          <thead>
            <tr><th>Exit</th><th>Meaning</th><th>Error codes</th></tr>
          </thead>
          <tbody>
            <tr><td><code>0</code></td><td>OK</td><td></td></tr>
            <tr><td><code>1</code></td><td>Error</td><td><code>NOT_FOUND</code>, <code>UPSTREAM</code> (hub or MCP server failed), <code>INTERNAL</code> (a local problem)</td></tr>
            <tr><td><code>2</code></td><td>Usage: the command line was wrong</td><td><code>USAGE</code></td></tr>
            <tr><td><code>10</code></td><td>Waiting for login approval</td><td><code>APPROVAL_PENDING</code></td></tr>
            <tr><td><code>11</code></td><td>The login code expired</td><td><code>EXPIRED</code></td></tr>
            <tr><td><code>12</code></td><td>Not logged in, or the login was revoked</td><td><code>NOT_LOGGED_IN</code></td></tr>
          </tbody>
        </table>
      </div>
      <Code>{`finch status --json
<span class="o">{"schema_version":1,"account":"you@example.com","config":"/home/you/.finch/finch.yml",</span>
<span class="o"> "hub":"https://finchmcp.com","hub_reachable":true,</span>
<span class="o"> "ingress":[{"app_path":"notes","service":"http://127.0.0.1:8000"}],</span>
<span class="o"> "loggedIn":true,"login_pending":false,</span>
<span class="o"> "service":{"installed":true,"manager":"launchd","running":true,"unit":"…"},</span>
<span class="o"> "tenant":"user_2abc…","version":"1.7.0"}</span>`}</Code>

      <h2>finch.yml</h2>
      <p>
        <code>finch add</code> writes this file. It holds no secrets; credentials are
        saved separately under <code>~/.finch/</code>.
      </p>
      <Code>{`hub: https://finchmcp.com
box: this-box
ingress:
  - app_path: notes                  <span class="c"># becomes &lt;slug&gt;.finchmcp.com/notes/</span>
    service: http://127.0.0.1:8000`}</Code>

      <div className="docs-foot">
        <Link href="/docs/domains">← Domains</Link>
        <Link href="/docs">Quickstart →</Link>
      </div>
    </>
  );
}
