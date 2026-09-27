import type { Metadata } from 'next';
import { docsMetadata } from '../meta';
import Link from 'next/link';
import Code from '../code';

export const metadata: Metadata = docsMetadata('CLI reference', 'Every finch command, its flags, JSON output and exit codes.');

export default function CliReference() {
  return (
    <>
      <h1>CLI reference</h1>
      <p className="docs-lede">
        Every finch command, grouped by what you do with it. finch runs on macOS and
        Linux. Run <code>finch</code> on its own for the list of commands, and{' '}
        <code>finch help &lt;command&gt;</code> (or <code>finch &lt;command&gt; -h</code>)
        for one command&apos;s usage, flags and an example.
      </p>

      <div className="docs-note">
        <b>Driving finch with an agent?</b> Point it at{' '}
        <a href="/agents.md">/agents.md</a>, a step-by-step guide written for agents
        (the installed binary prints a copy with <code>finch guide</code>). Every
        command below takes <code>--json</code>, so the only step that needs you is
        approving the login. One paste does it: &ldquo;Read https://finchmcp.com/agents.md
        and use finch to publish my MCP server on http://127.0.0.1:8000 as notes. Show
        me the sign-in link when you get it. Run it as a background service, check it
        with finch test, then connect it to this agent.&rdquo;
      </div>

      <h2>By hand, start to finish</h2>
      <Code>{`finch login                                     <span class="c"># opens the sign-in page and waits</span>
finch add notes --service http://127.0.0.1:8000   <span class="c"># prints the public URL</span>
finch service install                           <span class="c"># keep it running in the background</span>
finch test notes                                <span class="c"># does it answer through finch?</span>
finch connect notes --client claude-code        <span class="c"># add it to your MCP client</span>`}</Code>

      <h2>Set up</h2>
      <div className="docs-table-wrap">
        <table>
          <thead>
            <tr><th>Command</th><th>What it does</th></tr>
          </thead>
          <tbody>
            <tr>
              <td><code>finch login</code></td>
              <td>Log this machine in to your account. Prints a link and a short code, opens the link in your browser and waits until you approve it. You can approve on any device, such as your phone. <code>--headless</code> skips the local browser (use it over SSH). <code>--hub URL</code> logs in to another finch hub.</td>
            </tr>
            <tr>
              <td><code>finch add &lt;name&gt; --service &lt;url&gt;</code></td>
              <td>Publish the local app at <code>&lt;url&gt;</code> as <code>&lt;name&gt;</code>: add it to your account and to <code>finch.yml</code>, and print its public URL (JSON field <code>url</code>). The name becomes the URL segment, <code>&lt;account address&gt;.finchmcp.com/&lt;name&gt;/</code>, lowercased and with each run of other characters turned into <code>-</code> (<code>My_API.v1</code> is published as <code>my-api-v1</code>; see <Link href="/docs/services#names">names</Link>). Running it again for a name this machine already serves updates that service&apos;s local URL instead of adding a second service, and restarts the background service if it is running.</td>
            </tr>
            <tr>
              <td><code>&nbsp;&nbsp;--public</code></td>
              <td>Let anyone with the URL in, with no key. Change it later with <code>finch auth</code>.</td>
            </tr>
            <tr>
              <td><code>&nbsp;&nbsp;--forward-all</code></td>
              <td>Forward every path under <code>/&lt;name&gt;/</code> to the app, for a web app or REST API. Without it finch forwards only <code>/&lt;name&gt;/mcp</code>. See <Link href="/docs/services#web-apps">Web apps and REST APIs</Link>.</td>
            </tr>
            <tr>
              <td><code>finch service install</code></td>
              <td>Run finch in the background: it starts at login and restarts if it exits. A launchd LaunchAgent (<code>~/Library/LaunchAgents/com.finchmcp.finch.plist</code>) on macOS, a systemd user unit (<code>finch.service</code>) on Linux. Safe to run again, and running it again is how you apply changes to <code>finch.yml</code>. It waits for every service to connect and exits <code>1</code> if finch does not come up or a service has not connected within about 20 seconds; the unit stays installed and the message says why. On a headless Linux machine, <code>sudo loginctl enable-linger $USER</code> keeps it running after you log out.</td>
            </tr>
            <tr>
              <td><code>finch service status</code> / <code>uninstall</code></td>
              <td>Say whether the background service is installed and running, or stop and remove it. <code>uninstall</code> exits <code>1</code> and keeps the unit if finch could not be stopped.</td>
            </tr>
            <tr>
              <td><code>finch run [--config finch.yml]</code></td>
              <td>Serve every service in <code>finch.yml</code> in the foreground, until you press Ctrl-C.</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>Log in from a script or agent</h2>
      <p>
        Plain <code>finch login</code> waits for you and has no <code>--json</code>{' '}
        form. Scripts and agents split it in two, so they can show you the link and
        keep working:
      </p>
      <div className="docs-table-wrap">
        <table>
          <thead>
            <tr><th>Command</th><th>What it does</th></tr>
          </thead>
          <tbody>
            <tr>
              <td><code>finch login --start</code></td>
              <td>Start a login and return at once. Prints the sign-in link and code (JSON: <code>user_code</code>, <code>verification_uri_complete</code>, <code>expires_in</code>, <code>interval</code>) and saves the pending login to <code>~/.finch/login-pending.json</code> (mode 0600).</td>
            </tr>
            <tr>
              <td><code>finch login --poll</code></td>
              <td>Check the pending login once. Exit <code>0</code> when approved, <code>10</code> while it waits, <code>11</code> once the code has expired. JSON: <code>{'{"status":"approved"|"pending"|"expired"}'}</code>. Until it resolves, every other command reports <code>APPROVAL_PENDING</code>, even when an older login is saved.</td>
            </tr>
            <tr>
              <td><code>finch login --cancel</code></td>
              <td>Drop a login started with <code>--start</code>. The saved login, if any, works again. JSON: <code>{'{"cancelled":true|false}'}</code>.</td>
            </tr>
            <tr>
              <td><code>finch login --token -</code></td>
              <td>Log in with a token from <code>finch token</code>, read from stdin (or set <code>FINCH_CLI_TOKEN</code>). A token passed as an argument works but warns: it lands in the process list and shell history.</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>Connect a client</h2>
      <div className="docs-table-wrap">
        <table>
          <thead>
            <tr><th>Command</th><th>What it does</th></tr>
          </thead>
          <tbody>
            <tr>
              <td><code>finch connect &lt;name&gt; --client claude-code</code></td>
              <td>Makes a <code>finch_</code> key scoped to the service, saves it to <code>~/.finch/connect/&lt;name&gt;.claude-code.json</code> (mode 0600), and adds the server to the current directory&apos;s Claude Code project with <code>claude mcp add-json</code>. The entry&apos;s <code>headersHelper</code> reads the key from that file, so the key never appears in a command line. Claude Code runs the helper only in a trusted workspace. Needs the <code>claude</code> CLI on <code>PATH</code>.</td>
            </tr>
            <tr>
              <td><code>finch connect &lt;name&gt; --client cursor</code></td>
              <td>Makes a key and adds the server to <code>~/.cursor/mcp.json</code>, keeping every other entry.</td>
            </tr>
            <tr>
              <td><code>finch connect &lt;name&gt; --client codex</code></td>
              <td>Makes a key and writes <code>[mcp_servers.&lt;name&gt;]</code> into <code>~/.codex/config.toml</code>, keeping the rest of the file.</td>
            </tr>
            <tr>
              <td><code>finch connect &lt;name&gt; --client json</code></td>
              <td>Makes a key and prints an <code>mcpServers</code> JSON snippet for any other client. This is the only mode that prints the key.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        Each connect makes its own key, labelled with the client and machine, so
        you can revoke one client with <code>finch keys revoke &lt;id&gt;</code> without
        touching the others. The client is checked before a key is made, and a key
        whose setup fails is revoked again. A public service gets no key. Running
        connect again for Claude Code, Cursor or Codex replaces the entry and revokes
        the key the old entry used (listed as <code>revoked_key_ids</code> in{' '}
        <code>--json</code>), so re-running it rotates the key. Every Claude Code
        project on the machine connected to the same service shares the one key
        file, so they all move to the new key.
      </p>

      <h2>See what&apos;s happening</h2>
      <div className="docs-table-wrap">
        <table>
          <thead>
            <tr><th>Command</th><th>What it does</th></tr>
          </thead>
          <tbody>
            <tr>
              <td><code>finch status</code></td>
              <td>This machine at a glance: whether you are logged in (<code>logged_in</code>; <code>loggedIn</code> is kept for older scripts) or a login is waiting for approval (<code>login_pending</code>), which services its <code>finch.yml</code> serves and their public URLs (<code>url</code>, when logged in and finch answers), and whether the background service is installed and running. It always exits <code>0</code>; read the fields.</td>
            </tr>
            <tr>
              <td><code>finch fleet</code></td>
              <td>Every service on your account, with its state (online, offline, pending) and public URL (<code>url</code>). Alias: <code>finch ls</code>.</td>
            </tr>
            <tr>
              <td><code>finch logs &lt;name&gt;</code></td>
              <td>Recent calls to a service: time, route, caller, status and duration. <code>--limit N</code> sets how many. This is the whole call record finch keeps; request and response bodies are never stored (see <Link href="/docs/privacy">Privacy</Link>).</td>
            </tr>
            <tr>
              <td><code>finch version</code></td>
              <td>The installed version and platform.</td>
            </tr>
            <tr>
              <td><code>finch guide</code></td>
              <td>Print the step-by-step guide for agents.</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>Test a service</h2>
      <div className="docs-table-wrap">
        <table>
          <thead>
            <tr><th>Command</th><th>What it does</th></tr>
          </thead>
          <tbody>
            <tr>
              <td><code>finch test &lt;name&gt;</code></td>
              <td>Open an MCP session with the service through finch and list its tools. Exits non-zero when that fails, and the message says which part failed. If your server refuses the session with HTTP 406, or a 400 that mentions the session, it starts with &ldquo;the server rejected the MCP handshake&rdquo; and quotes the answer. Other refusals name the status or the error, as &ldquo;&lt;name&gt; answered tools/list with HTTP &lt;status&gt;&rdquo; or &ldquo;&lt;name&gt; answered tools/list with an MCP error&rdquo; followed by the answer, even when it was the opening handshake your server refused. A 401 says your MCP server asks for its own credentials, and a 5xx reads &ldquo;&lt;name&gt; did not answer through finch&rdquo;.</td>
            </tr>
            <tr>
              <td><code>finch call &lt;name&gt; &lt;tool&gt; [--args &apos;{'{...}'}&apos;]</code></td>
              <td>Call one MCP tool through finch. <code>--args</code> takes a JSON object. A tool that reports an error exits <code>1</code>.</td>
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
              <td>Make a <code>finch_</code> key for a client, scoped to one service. The key prints once. <code>--all</code> scopes it to every service instead.</td>
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
              <td><code>finch token [--login]</code></td>
              <td>Make a fresh login token on a logged-in machine, to set up another machine without a browser. <code>--login</code> prints a ready-to-run <code>finch login</code> command that feeds the token on stdin.</td>
            </tr>
            <tr>
              <td><code>finch revoke-tokens</code></td>
              <td>Log out every machine, including the one you run it on.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="docs-note">
        <b>Two kinds of credentials.</b> The login token (about 30 days) is what a
        machine uses to manage your account: add services, make keys, revoke access.{' '}
        <code>finch_</code> keys are what clients present to reach your services. See{' '}
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
              <td>Choose whether callers need a <code>finch_</code> key (or OAuth sign-in). <code>public</code> lets anyone in.</td>
            </tr>
            <tr>
              <td><code>finch rm &lt;name&gt;</code></td>
              <td>Remove a service: from your account, from this machine&apos;s <code>finch.yml</code>, and its credential on this machine.</td>
            </tr>
            <tr>
              <td><code>finch update [--force]</code></td>
              <td>Update finch to the latest version and restart the background service on it. When you already have the latest it says so (&ldquo;finch 1.8.0 is already the latest&rdquo;) and downloads nothing; <code>--force</code> reinstalls anyway. <code>--restart auto|service|self|none</code> controls the restart.</td>
            </tr>
            <tr>
              <td><code>finch domain ls</code></td>
              <td>List custom hostnames on your account; <code>finch domain add &lt;hostname&gt;</code> and <code>finch domain rm &lt;hostname&gt;</code> manage them. Custom hostnames don&apos;t serve traffic yet; see <Link href="/docs/domains">Domains</Link>.</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2 id="remove">Remove finch</h2>
      <Code>{`finch uninstall`}</Code>
      <p>
        <code>finch uninstall</code> takes finch off this machine and prints each
        step as it goes. It:
      </p>
      <ul>
        <li>stops and removes the background service;</li>
        <li>revokes the keys this machine made with <code>finch connect</code>, and removes the client entries finch added to Claude Code, Cursor and Codex. A machine set up before finch 1.8 kept no record of its keys, so there it revokes none and lists the keys that carry this machine&apos;s name for you to check; logged out or offline, it revokes none and says so;</li>
        <li>deletes this machine&apos;s login, service credentials and <code>finch.yml</code> from <code>~/.finch/</code>.</li>
      </ul>
      <p>
        It never deletes the <code>finch</code> binary itself; it prints the command
        that does. Your account and services stay; <code>finch rm &lt;name&gt;</code>{' '}
        removes a service, and <code>finch revoke-tokens</code> logs out every other
        machine. With <code>--json</code> it reports each step.
      </p>

      <h2>Less common</h2>
      <div className="docs-table-wrap">
        <table>
          <thead>
            <tr><th>Command</th><th>What it does</th></tr>
          </thead>
          <tbody>
            <tr>
              <td><code>finch enroll &lt;name&gt; --ticket -</code></td>
              <td>On a machine with no login: trade a one-time ticket (stdin, or <code>FINCH_TICKET</code>) for a credential that serves one service. A logged-in machine uses <code>finch add</code> instead.</td>
            </tr>
            <tr>
              <td><code>finch approve &lt;name&gt;</code></td>
              <td>Approve a service that a machine enrolled with a ticket, which waits as <code>pending</code> until you do. Run it from a logged-in machine. Services you add with <code>finch add</code> never need it.</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>JSON output and exit codes</h2>
      <p>
        Every command takes <code>--json</code>. Success payloads go to stdout and carry{' '}
        <code>&quot;schema_version&quot;:1</code>. Lists are wrapped in an object:{' '}
        <code>finch fleet --json</code> prints <code>{'{"schema_version":1,"services":[…]}'}</code>.
        Field names are snake_case. Errors go to stderr as one line:
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
            <tr><td><code>1</code></td><td>Error</td><td><code>NOT_FOUND</code>, <code>UPSTREAM</code> (finch or your server failed), <code>INTERNAL</code> (a local problem)</td></tr>
            <tr><td><code>2</code></td><td>Usage: the command line was wrong</td><td><code>USAGE</code></td></tr>
            <tr><td><code>10</code></td><td>Waiting for login approval</td><td><code>APPROVAL_PENDING</code></td></tr>
            <tr><td><code>11</code></td><td>The login code expired</td><td><code>EXPIRED</code></td></tr>
            <tr><td><code>12</code></td><td>Not logged in, or the login was revoked</td><td><code>NOT_LOGGED_IN</code></td></tr>
          </tbody>
        </table>
      </div>
      <Code>{`finch status --json
<span class="o">{"schema_version":1,"account":"you@example.com","config":"/Users/you/.finch/finch.yml",</span>
<span class="o"> "hub":"https://finchmcp.com","hub_reachable":true,</span>
<span class="o"> "ingress":[{"app_path":"notes","service":"http://127.0.0.1:8000",</span>
<span class="o">   "url":"https://sunny-wren-42.finchmcp.com/notes/mcp"}],</span>
<span class="o"> "loggedIn":true,"logged_in":true,"login_pending":false,</span>
<span class="o"> "service":{"installed":true,"manager":"launchd","running":true,…},</span>
<span class="o"> "version":"1.8.0",…}</span>`}</Code>

      <h2>finch.yml</h2>
      <p>
        <code>finch add</code> writes this file (at <code>~/.finch/finch.yml</code>{' '}
        unless the current directory has a <code>finch.yml</code>). It holds no
        secrets; credentials are saved separately under <code>~/.finch/</code>.
      </p>
      <Code>{`hub: https://finchmcp.com
box: studio                          <span class="c"># this machine's name</span>
ingress:
  - app_path: notes                  <span class="c"># the service name: sunny-wren-42.finchmcp.com/notes/</span>
    service: http://127.0.0.1:8000
  - app_path: demo
    service: http://127.0.0.1:3000
    forward_all: true                <span class="c"># set by --forward-all</span>`}</Code>

      <div className="docs-foot">
        <Link href="/docs/domains">← Domains</Link>
        <Link href="/docs/privacy">Privacy &amp; data handling →</Link>
      </div>
    </>
  );
}
