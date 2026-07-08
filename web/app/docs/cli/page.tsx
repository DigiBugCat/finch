import Link from 'next/link';

function Code({ children }: { children: string }) {
  return <pre className="docs-code"><code dangerouslySetInnerHTML={{ __html: children }} /></pre>;
}

export default function CliReference() {
  return (
    <>
      <h1>CLI reference</h1>
      <p className="docs-lede">
        Every finch command, grouped by what you do with it. All commands are
        non-interactive except the one-time browser approval in <code>finch login</code>.
        Run <code>finch help</code> for the flag-level reference, or{' '}
        <code>finch &lt;command&gt; -h</code> for a single command&apos;s flags.
      </p>

      <div className="docs-note">
        <b>Driving finch with an agent?</b> <code>finch guide</code> prints a complete,
        self-contained operating manual. Point an agent at it once and it can run the
        whole loop: serve, test, grant and revoke access.
      </div>

      <h2>Setup</h2>
      <div className="docs-table-wrap">
        <table>
          <thead>
            <tr><th>Command</th><th>What it does</th></tr>
          </thead>
          <tbody>
            <tr>
              <td><code>finch login [--hub URL] [--token t]</code></td>
              <td>Log in. With no token it opens the browser to approve a short code. With <code>--token</code> it uses a token minted by <code>finch token</code>, no browser.</td>
            </tr>
            <tr>
              <td><code>finch add &lt;app_path&gt; --service &lt;url&gt;</code></td>
              <td>Enroll a service and append an ingress rule to <code>finch.yml</code>. The <code>app_path</code> becomes the URL segment: <code>&lt;slug&gt;.finchmcp.com/&lt;app_path&gt;/</code>.</td>
            </tr>
            <tr>
              <td><code>finch run [--config finch.yml]</code></td>
              <td>Serve every ingress rule in <code>finch.yml</code>. Auto-approves services while you are logged in.</td>
            </tr>
            <tr>
              <td><code>finch enroll &lt;app_path&gt; --ticket &lt;t&gt;</code></td>
              <td>One-time: trade a dashboard ticket for a saved box credential. Use <code>--ticket -</code> to read the ticket from stdin, or set <code>FINCH_TICKET</code>.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        Enrolling a second box needs no browser. From a box that is already logged in:
      </p>
      <Code>{`ssh user@newbox "finch login --token $(finch token)"
ssh user@newbox "finch add api --service http://127.0.0.1:9000 && finch run"`}</Code>

      <h2>Inspect</h2>
      <div className="docs-table-wrap">
        <table>
          <thead>
            <tr><th>Command</th><th>What it does</th></tr>
          </thead>
          <tbody>
            <tr>
              <td><code>finch status [--json]</code></td>
              <td>Show whether you are logged in (and to which tenant), and what the local <code>finch.yml</code> serves.</td>
            </tr>
            <tr>
              <td><code>finch fleet [--json]</code></td>
              <td>List every service in the account with its state (online, offline, pending). Alias: <code>finch ls</code>.</td>
            </tr>
            <tr>
              <td><code>finch guide</code></td>
              <td>Print the full agent operating manual.</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>Keys and tokens</h2>
      <div className="docs-table-wrap">
        <table>
          <thead>
            <tr><th>Command</th><th>What it does</th></tr>
          </thead>
          <tbody>
            <tr>
              <td><code>finch token [--json | --login]</code></td>
              <td>Mint a fresh CLI token from an authed box, for provisioning a new box without a browser. <code>--login</code> prints a ready-to-run <code>finch login</code> command.</td>
            </tr>
            <tr>
              <td><code>finch keys mint &lt;label&gt; --service &lt;id&gt;</code></td>
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
              <td><code>finch revoke-tokens</code></td>
              <td>De-authorize every CLI login, including the box you run it on. Every box must <code>finch login</code> again.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="docs-note">
        <b>Two kinds of credentials.</b> The CLI token is a tenant-admin credential
        (about 30 days) that the box itself uses. <code>finch_</code> keys are what
        clients present to reach your services. See{' '}
        <Link href="/docs/auth">Keys &amp; auth</Link>.
      </div>

      <h2>Endpoints</h2>
      <div className="docs-table-wrap">
        <table>
          <thead>
            <tr><th>Command</th><th>What it does</th></tr>
          </thead>
          <tbody>
            <tr>
              <td><code>finch test &lt;service&gt;</code></td>
              <td>List the service&apos;s MCP tools through the hub. A quick does-it-work check.</td>
            </tr>
            <tr>
              <td><code>finch call &lt;service&gt; &lt;tool&gt; [--args &apos;{'{...}'}&apos;]</code></td>
              <td>Invoke one MCP tool through the hub. <code>--args</code> takes a JSON object.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <Code>{`finch test printer
<span class="o">printer — 2 tool(s):</span>
<span class="o">  • echo             Echo the input back</span>
<span class="o">  • print            Send a document to the printer</span>
finch call printer echo --args '{"text":"hi"}'
<span class="o">hi</span>`}</Code>

      <h2>Manage</h2>
      <div className="docs-table-wrap">
        <table>
          <thead>
            <tr><th>Command</th><th>What it does</th></tr>
          </thead>
          <tbody>
            <tr>
              <td><code>finch rm &lt;service&gt;</code></td>
              <td>Remove a service from the account.</td>
            </tr>
            <tr>
              <td><code>finch approve &lt;app_path&gt;</code></td>
              <td>Clear a service&apos;s pending gate. Only needed when you are not logged in; <code>finch run</code> approves automatically otherwise.</td>
            </tr>
            <tr>
              <td><code>finch auth &lt;app_path&gt; public|key</code></td>
              <td>Set whether the public endpoint requires a <code>finch_</code> key. <code>public</code> makes it an open webpage.</td>
            </tr>
            <tr>
              <td><code>finch update [--force]</code></td>
              <td>Self-update the binary from the hub and restart the running serve cleanly. <code>--restart auto|service|self|none</code> controls how.</td>
            </tr>
            <tr>
              <td><code>finch domain ls</code></td>
              <td>List custom hostnames mapped to the account. <code>finch domain add &lt;hostname&gt;</code> and <code>finch domain rm &lt;hostname&gt;</code> manage them. See <Link href="/docs/domains">Domains</Link>.</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>JSON output</h2>
      <p>
        <code>--json</code> is supported on <code>add</code>, <code>token</code>,{' '}
        <code>status</code>, <code>fleet</code>, <code>keys</code>, <code>test</code>,
        and <code>call</code>. Use it for scripting and agents.
      </p>
      <Code>{`finch status --json
<span class="o">{</span>
<span class="o">  "loggedIn": true,</span>
<span class="o">  "hub": "https://finchmcp.com",</span>
<span class="o">  "tenant": "your-slug",</span>
<span class="o">  "config": "finch.yml",</span>
<span class="o">  "ingress": [{ "app_path": "printer", "service": "http://127.0.0.1:8000" }]</span>
<span class="o">}</span>`}</Code>

      <h2>finch.yml</h2>
      <p>
        <code>finch add</code> writes this file. It holds no secrets; credentials are
        saved separately under <code>~/.finch/</code>.
      </p>
      <Code>{`hub: https://finchmcp.com
box: this-box
ingress:
  - app_path: printer                <span class="c"># becomes &lt;slug&gt;.finchmcp.com/printer/</span>
    service: http://127.0.0.1:8000`}</Code>

      <div className="docs-foot">
        <Link href="/docs/domains">← Domains</Link>
        <Link href="/docs">Quickstart →</Link>
      </div>
    </>
  );
}
