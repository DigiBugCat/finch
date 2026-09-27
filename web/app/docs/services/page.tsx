import Link from 'next/link';

function Code({ children }: { children: string }) {
  return <pre className="docs-code"><code dangerouslySetInnerHTML={{ __html: children }} /></pre>;
}

export default function ServicesAndBoxes() {
  return (
    <>
      <h1>Services &amp; boxes</h1>
      <p className="docs-lede">
        A service is a local HTTP app you expose through Finch. A box is a machine
        running the Finch agent. This page explains how the two fit together, what
        lives in <code>finch.yml</code>, and how to add more boxes.
      </p>

      <h2>The model</h2>
      <p>
        A <b>service</b> is any local HTTP app: an MCP server, a web app, any HTTP or
        WebSocket app. Finch publishes it at{' '}
        <code>https://&lt;slug&gt;.finchmcp.com/&lt;app_path&gt;/</code>. The service URL
        must be http(s).
      </p>
      <p>
        A <b>box</b> is a machine running the Finch agent. It dials out to the hub, so
        nothing listens on the box and no ports open. One <code>finch run</code> process
        serves every rule in <code>finch.yml</code>.
      </p>

      <h2>Adding a service</h2>
      <p>Your service must already be running locally, then:</p>
      <Code>{`finch add printer --service http://127.0.0.1:8000
<span class="o">finch: added "printer" → http://127.0.0.1:8000</span>
<span class="o">       public URL: https://your-slug.finchmcp.com/printer/mcp</span>
finch service install
finch test printer`}</Code>
      <p>
        <code>finch add</code> writes or extends <code>finch.yml</code> and prints the
        public URL (the <code>url</code> field with <code>--json</code>). The file holds
        no secrets, so it is safe to commit. Credentials live on disk elsewhere, never
        in <code>finch.yml</code>.
      </p>
      <p>
        By default callers need a <code>finch_</code> key or an OAuth sign-in. Add{' '}
        <code>--public</code> to open the endpoint to anyone with the URL, for a public
        website or a demo; <code>finch auth printer key</code> closes it again.
      </p>

      <h2>Running in the background</h2>
      <p>
        <code>finch run</code> serves in the foreground and stops when the terminal
        closes. To keep a service up across logouts and reboots, install finch as a
        login service:
      </p>
      <Code>{`finch service install      <span class="c"># launchd on macOS, systemd --user on Linux</span>
finch service status       <span class="c"># installed? running?</span>
finch service uninstall    <span class="c"># stop and remove it</span>`}</Code>
      <p>
        On macOS this writes a LaunchAgent at{' '}
        <code>~/Library/LaunchAgents/com.finchmcp.finch.plist</code> and logs to{' '}
        <code>~/.finch/finch.log</code> (moved to <code>finch.log.1</code> when a start finds it over
        10 MiB). On Linux it writes a systemd user unit,{' '}
        <code>finch.service</code>; read its log with{' '}
        <code>journalctl --user -u finch.service</code>. Either way it needs no root,
        starts at login, restarts <code>finch run</code> if it exits, and serves the{' '}
        <code>finch.yml</code> that <code>finch add</code> wrote. Running{' '}
        <code>install</code> again is safe, for example after moving the binary. Stop any{' '}
        <code>finch run</code> you started in a terminal first, since only one serve per
        machine can hold the relay; <code>install</code> exits with an error when{' '}
        <code>finch run</code> does not come up, and says why when it knows.
      </p>
      <div className="docs-note">
        <b>Headless Linux box?</b> A systemd user service stops when you log out unless
        lingering is on. Enable it once with{' '}
        <code>sudo loginctl enable-linger $USER</code> so finch starts at boot and keeps
        running with nobody logged in. <code>finch service install</code> tells you when
        it is off.
      </div>

      <h2>finch.yml</h2>
      <Code>{`hub: https://finchmcp.com
box: this-box
ingress:
  - app_path: printer                <span class="c"># becomes &lt;slug&gt;.finchmcp.com/printer/</span>
    service: http://127.0.0.1:8000`}</Code>
      <p>
        <code>hub</code> is where the box connects. <code>box</code> names this machine.
        Each <code>ingress</code> entry maps a public path (<code>app_path</code>) to a
        local URL (<code>service</code>).
      </p>

      <h2>Multiple services</h2>
      <p>
        Run <code>finch add</code> once per service. Each call appends an ingress rule,
        and one <code>finch run</code> process fronts them all. It auto-approves new
        services while you are logged in. A running serve reads <code>finch.yml</code>{' '}
        when it starts, so after adding a service run <code>finch service install</code>{' '}
        again (it restarts the service) or restart your <code>finch run</code>.
      </p>
      <Code>{`finch add printer --service http://127.0.0.1:8000
finch add scraper --service http://127.0.0.1:8001
finch service install`}</Code>
      <p>To remove a service:</p>
      <Code>{`finch rm printer`}</Code>

      <h2>States</h2>
      <div className="docs-table-wrap">
        <table>
          <thead>
            <tr><th>State</th><th>Meaning</th></tr>
          </thead>
          <tbody>
            <tr>
              <td><code>online</code></td>
              <td>The box holds a live connection to the hub and the service is approved. Requests flow.</td>
            </tr>
            <tr>
              <td><code>offline</code></td>
              <td>No box for this service is currently connected. The endpoint stays registered.</td>
            </tr>
            <tr>
              <td><code>pending</code></td>
              <td>A box joined but the service is not approved yet. Clear it with <code>finch approve &lt;app_path&gt;</code>, or just be logged in: <code>finch run</code> approves automatically.</td>
            </tr>
            <tr>
              <td><code>invited</code></td>
              <td>The service was enrolled but no box has joined yet. It flips out of <code>invited</code> on the first real join.</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>When a box goes offline</h2>
      <p>
        If a box loses its connection, its endpoint is marked <code>offline</code>.
        Nothing is deleted and nothing needs re-installing: the agent reconnects on its
        own, and the service goes back to <code>online</code> when it does.
      </p>

      <h2>Keeping boxes up to date</h2>
      <p>
        Run this on the box:
      </p>
      <Code>{`finch update`}</Code>
      <p>
        The agent downloads the new binary from the hub and swaps it in place. When{' '}
        <code>finch service install</code> manages the serve, launchd or systemd
        restarts it cleanly on the new version; otherwise restart your{' '}
        <code>finch run</code>. Either way the update is atomic: a failed download never
        touches the running binary.
      </p>

      <h2>Enrolling another box</h2>
      <p>
        You do not need the browser step on every machine. From a box that is already
        logged in, you can set up another one with no human step at all.{' '}
        <code>finch token</code> mints a fresh, revocable CLI token; the browser
        approval is only ever needed for your first box.
      </p>
      <div className="docs-note">
        <b>Keep the CLI token off argv.</b> It is a tenant-admin credential, and a
        token passed as a flag lands in shell history and process lists. Pipe it into{' '}
        <code>--token -</code>, or set <code>FINCH_CLI_TOKEN</code>.
      </div>
      <Code>{`finch token | ssh user@newbox "finch login --token -"
ssh user@newbox "finch add api --service http://127.0.0.1:9000 && finch service install"`}</Code>

      <h2>Inspecting state</h2>
      <Code>{`finch status --json     <span class="c"># am I logged in? what does finch.yml serve?</span>
finch fleet --json      <span class="c"># every service + its state (online/offline/pending)</span>`}</Code>
      <p>
        Both print JSON you can parse in a script. See the{' '}
        <Link href="/docs/cli">CLI reference</Link> for every command.
      </p>

      <div className="docs-foot">
        <Link href="/docs">← Quickstart</Link>
        <Link href="/docs/auth">Keys &amp; auth →</Link>
      </div>
    </>
  );
}
