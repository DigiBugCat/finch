import type { Metadata } from 'next';
import { docsMetadata } from '../meta';
import Link from 'next/link';
import Code from '../code';

export const metadata: Metadata = docsMetadata('Services & machines', 'How finch services and machines fit together: finch.yml, web apps, running in the background, updating, and adding machines.');

export default function ServicesAndMachines() {
  return (
    <>
      <h1>Services &amp; machines</h1>
      <p className="docs-lede">
        A service is a local app you publish with finch. A machine is a computer
        running finch that serves it. This page covers how the two fit together,
        what lives in <code>finch.yml</code>, and how to change, remove and update
        things later.
      </p>

      <h2>The model</h2>
      <p>
        A <b>service</b> is a local HTTP app: usually an MCP server, but a web app or
        a REST API works too. finch publishes it at{' '}
        <code>https://&lt;account address&gt;.finchmcp.com/&lt;name&gt;/</code>. Your{' '}
        <b>account address</b> (the slug, such as <code>sunny-wren-42</code>) is
        picked by finch for your account; the <b>name</b> is what you pass to{' '}
        <code>finch add</code>.
      </p>
      <p>
        A <b>machine</b> is any Mac or Linux computer running finch. It dials out to
        finch, so nothing on it listens and no ports open. One finch process on a
        machine serves every service in its <code>finch.yml</code>.
      </p>

      <h2>Adding a service</h2>
      <p>Start your app locally first, then:</p>
      <Code>{`finch add printer --service http://127.0.0.1:8000
<span class="o">finch: added "printer" → http://127.0.0.1:8000</span>
<span class="o">       public URL: https://sunny-wren-42.finchmcp.com/printer/mcp</span>
finch service install
finch test printer`}</Code>
      <p>
        <code>finch add</code> records the service in <code>finch.yml</code> and
        prints its public URL (the <code>url</code> field with <code>--json</code>).
        The name becomes part of the URL: letters and digits, with <code>-</code>,{' '}
        <code>_</code> or <code>.</code> between them, up to 63 characters. Case
        matters in the URL, so lowercase names are easiest to share. <code>finch.yml</code> holds no secrets; each service&apos;s
        credential is saved separately under <code>~/.finch/</code>.
      </p>
      <p>
        By default callers need a <code>finch_</code> key or an OAuth sign-in. Add{' '}
        <code>--public</code> to let anyone with the URL in;{' '}
        <code>finch auth printer key</code> closes it again.
      </p>

      <h3>Changing a service&apos;s port</h3>
      <p>
        Run <code>finch add</code> again with the same name and the new URL. finch
        updates that service&apos;s entry in <code>finch.yml</code>; the public URL
        stays the same. Then restart the background service so it picks up the
        change:
      </p>
      <Code>{`finch add printer --service http://127.0.0.1:9000
finch service install`}</Code>

      <h2 id="web-apps">Web apps and REST APIs</h2>
      <p>
        By default finch forwards only the MCP endpoint:{' '}
        <code>/printer/mcp</code> reaches <code>/mcp</code> on your app, and every
        other path is refused. That keeps the rest of your local app private. For a
        web app, a REST API or a public page, add <code>--forward-all</code> so
        every path under the service is forwarded:
      </p>
      <Code>{`finch add demo --service http://127.0.0.1:3000 --public --forward-all
<span class="c"># https://sunny-wren-42.finchmcp.com/demo/about → http://127.0.0.1:3000/about</span>`}</Code>
      <p>
        The app is served under <code>/demo/</code>, so links and assets in it should
        use relative paths (or know their base path). Streamed responses pass
        through as they are written.
      </p>

      <h2>Running in the background</h2>
      <p>
        <code>finch run</code> serves in the foreground and stops when the terminal
        closes. To keep your services up across logouts and reboots, install finch
        as a background service:
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
        starts at login, restarts finch if it exits, and serves the{' '}
        <code>finch.yml</code> that <code>finch add</code> wrote.
      </p>
      <p>
        Running <code>install</code> again is safe, and it is how you apply a change
        to <code>finch.yml</code>: it restarts the service. Stop any{' '}
        <code>finch run</code> you started in a terminal first, since only one finch
        per machine can serve. <code>install</code> waits about 20 seconds for every
        service to connect, and if one doesn&apos;t, it exits with an error that says
        why when it knows.
      </p>
      <div className="docs-note">
        <b>Headless Linux machine?</b> A systemd user service stops when you log out
        unless lingering is on. Turn it on once with{' '}
        <code>sudo loginctl enable-linger $USER</code> so finch starts at boot and keeps
        running with nobody logged in. <code>finch service install</code> tells you when
        it is off.
      </div>

      <h2>finch.yml</h2>
      <p>
        <code>finch add</code> writes this file for you, at{' '}
        <code>~/.finch/finch.yml</code> unless the current directory already has a{' '}
        <code>finch.yml</code>.
      </p>
      <Code>{`hub: https://finchmcp.com
box: studio                          <span class="c"># this machine's name</span>
ingress:
  - app_path: printer                <span class="c"># the service name: sunny-wren-42.finchmcp.com/printer/</span>
    service: http://127.0.0.1:8000   <span class="c"># where the app runs on this machine</span>
  - app_path: demo
    service: http://127.0.0.1:3000
    forward_all: true                <span class="c"># forward every path, not just /mcp</span>`}</Code>
      <p>
        <code>hub</code> is where the machine connects. <code>box</code> names this
        machine (it defaults to the hostname). Each <code>ingress</code> entry is one
        service: its name (<code>app_path</code>), the local URL it forwards to
        (<code>service</code>), and optionally <code>forward_all</code>.
      </p>

      <h2>Several services on one machine</h2>
      <p>
        Run <code>finch add</code> once per service, then{' '}
        <code>finch service install</code> once to serve them all:
      </p>
      <Code>{`finch add printer --service http://127.0.0.1:8000
finch add scraper --service http://127.0.0.1:8001
finch service install`}</Code>

      <h2 id="remove">Removing a service</h2>
      <Code>{`finch rm printer`}</Code>
      <p>
        This removes the service from your account, deletes its entry from{' '}
        <code>finch.yml</code> and deletes its credential on this machine. Its public
        URL stops answering. If finch runs in the background,{' '}
        <code>finch service install</code> restarts it without the removed service.
        Keys scoped to that service stay on your account until you revoke them, and
        would work again if you re-add the same name; list and revoke them with{' '}
        <code>finch keys list</code> and <code>finch keys revoke</code>.
      </p>
      <p>
        To take finch off a machine altogether, run <code>finch uninstall</code>. See{' '}
        <Link href="/docs/cli#remove">Remove finch</Link> for exactly what it cleans up.
      </p>

      <h2>States</h2>
      <p>
        <code>finch fleet</code> lists every service on your account with its state
        and public URL:
      </p>
      <div className="docs-table-wrap">
        <table>
          <thead>
            <tr><th>State</th><th>Meaning</th></tr>
          </thead>
          <tbody>
            <tr>
              <td><code>online</code></td>
              <td>A machine serving it is connected. Requests flow.</td>
            </tr>
            <tr>
              <td><code>offline</code></td>
              <td>No machine serving it is connected right now. The address stays yours, and it comes back when a machine reconnects.</td>
            </tr>
            <tr>
              <td><code>pending</code></td>
              <td>A machine joined without your login (with a one-time ticket) and the service is waiting for approval. <code>finch approve &lt;name&gt;</code> approves it. A logged-in machine never needs this.</td>
            </tr>
            <tr>
              <td><code>invited</code></td>
              <td>The service exists but no machine has served it yet.</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>When something is down</h2>
      <p>
        If a machine loses its connection, its services show as <code>offline</code>.
        Nothing is deleted and nothing needs reinstalling: finch reconnects on its own.
        While a service is offline, callers get a <code>503</code>, but a client that
        hasn&apos;t signed in yet still gets the sign-in challenge, so a claude.ai or
        ChatGPT connector can finish setting up and work once the machine is back.
      </p>
      <p>
        If the machine is connected but your app isn&apos;t running, callers get a{' '}
        <code>502</code> that names the service and never shows the local address:
      </p>
      <Code>{`{"error":"finch reached the machine, but the local service isn't answering","service":"printer"}`}</Code>
      <p>
        Start the app, then check it with <code>finch test printer</code>.{' '}
        <code>finch logs printer</code> shows the recent calls and their status.
      </p>

      <h2>Keeping finch up to date</h2>
      <Code>{`finch update
<span class="o">finch 1.8.0 is already the latest</span>`}</Code>
      <p>
        When a newer version exists, <code>finch update</code> downloads it, swaps the
        binary in place and restarts the background service on it. When you already
        have the latest, it says so and changes nothing; <code>--force</code>{' '}
        reinstalls anyway. A failed download never touches the binary you are running.
      </p>

      <h2>Adding another machine</h2>
      <p>
        Only your first machine needs the browser step. From a machine that is
        already logged in, <code>finch token</code> makes a fresh login you can pipe
        to another one:
      </p>
      <Code>{`finch token | ssh you@pi "finch login --token -"
ssh you@pi "finch add sensors --service http://127.0.0.1:9000 && finch service install"`}</Code>
      <div className="docs-note">
        <b>Keep the token out of command lines.</b> It can manage your whole account
        for about 30 days, and a token passed as an argument lands in shell history
        and process lists. Pipe it into <code>--token -</code>, or set{' '}
        <code>FINCH_CLI_TOKEN</code>.
      </div>

      <h2>Checking on things</h2>
      <Code>{`finch status --json     <span class="c"># this machine: logged in? what does finch.yml serve? URLs</span>
finch fleet --json      <span class="c"># every service on the account, its state and URL</span>
finch logs printer      <span class="c"># recent calls to one service</span>`}</Code>
      <p>
        See the <Link href="/docs/cli">CLI reference</Link> for every command and its
        JSON output.
      </p>

      <div className="docs-foot">
        <Link href="/docs">← Quickstart</Link>
        <Link href="/docs/auth">Keys &amp; auth →</Link>
      </div>
    </>
  );
}
