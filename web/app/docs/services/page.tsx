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
finch run
<span class="o">✓ https://your-slug.finchmcp.com/printer/</span>`}</Code>
      <p>
        <code>finch add</code> writes or extends <code>finch.yml</code>. The file holds
        no secrets, so it is safe to commit. Credentials live on disk elsewhere, never
        in <code>finch.yml</code>.
      </p>

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
        services while you are logged in.
      </p>
      <Code>{`finch add printer --service http://127.0.0.1:8000
finch add scraper --service http://127.0.0.1:8001
finch run`}</Code>
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
              <td>A ticket was minted in the dashboard but no box has joined yet. It flips out of <code>invited</code> on the first real join.</td>
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
        A box on an older agent shows an <code>⬆</code> badge next to its version. Two
        ways to update it:
      </p>
      <p>
        <b>From the dashboard</b> — open the service and click <b>update now</b> on the
        box. The hub pushes an update command down the box&apos;s existing connection: the
        agent downloads the new binary from the hub, swaps it in place, and restarts
        itself — no SSH, no second process, about a second of downtime. The box comes
        back on the new version within a few seconds. (An offline box can&apos;t receive
        the push; the dashboard shows the command to run instead.)
      </p>
      <p>
        <b>On the box</b> — run:
      </p>
      <Code>{`finch update`}</Code>
      <p>
        Same swap, run locally. If a systemd service manages the agent it restarts
        cleanly; otherwise the process replaces itself in place. Either way the update
        is atomic — a failed download never touches the running binary.
      </p>

      <h2>Enrolling another box</h2>
      <p>
        You do not need <code>finch login</code> on every machine. Mint a ticket in the
        dashboard (Add box), then on the new box:
      </p>
      <Code>{`finch enroll printer --ticket &lt;ticket&gt;   <span class="c"># writes the credential, one time</span>
finch run                                <span class="c"># resumes ticketless thereafter</span>`}</Code>
      <p>
        Tickets are one-shot credentials. They are saved to disk by{' '}
        <code>enroll</code> and never appear in <code>finch.yml</code>.
      </p>
      <div className="docs-note">
        <b>Keep tickets off argv.</b> A ticket passed as a flag lands in shell history
        and process lists. Pipe it to stdin with <code>--ticket -</code>, or set{' '}
        <code>FINCH_TICKET</code>:
      </div>
      <Code>{`echo &lt;ticket&gt; | ssh newbox "finch enroll printer --ticket -"`}</Code>

      <h2>Provisioning a box from a logged-in box</h2>
      <p>
        From a box that is already logged in, you can set up another one with no human
        step at all. <code>finch token</code> mints a fresh, revocable CLI token; the
        browser step is only ever needed for your first box.
      </p>
      <Code>{`ssh user@newbox "finch login --token $(finch token)"
ssh user@newbox "finch add api --service http://127.0.0.1:9000 && finch run"`}</Code>

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
