import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Run your own finch | finch docs',
  description:
    'Deploy your own finch hub and website on Cloudflare with your own Clerk sign-in, and point the finch CLI at them.',
};

const REPO = 'https://github.com/DigiBugCat/finch';
const GUIDE = `${REPO}/blob/main/docs/self-host.md`;
const COUPLING = `${REPO}/blob/main/docs/self-host-coupling.md`;

/** A code block rendered as plain text, so placeholders like <slug> survive. */
function Code({ children }: { children: string }) {
  return (
    <pre className="docs-code">
      <code>{children}</code>
    </pre>
  );
}

export default function SelfHost() {
  return (
    <>
      <h1>Run your own finch</h1>
      <p className="docs-lede">
        Everything behind finchmcp.com is in the open-source repository: the hub, this
        website and the CLI. This guide deploys the hub and website on your own
        Cloudflare account, with your own Clerk sign-in, and points the{' '}
        <code>finch</code> CLI at them.
      </p>

      <div className="docs-note">
        <b>A self-hosted hub serves one account.</b> Every service you publish lives under
        one hub hostname, at <code>https://finch.example.dev/&lt;service&gt;/mcp</code>.
        The layout finchmcp.com uses, where each account gets its own subdomain, is tied to
        the finchmcp.com name in the code today. The changes needed to run it on another
        domain are listed in the <a href={COUPLING}>coupling checklist</a>. This
        single-account mode is how finch&apos;s own staging deployment runs.
      </div>

      <h2>What you deploy</h2>
      <div className="docs-table-wrap">
        <table>
          <thead>
            <tr><th>Piece</th><th>What it does</th></tr>
          </thead>
          <tbody>
            <tr>
              <td>Hub</td>
              <td>A Cloudflare Worker with three Durable Objects. It relays calls, checks keys, serves the CLI&apos;s API and the <code>/install</code> script. Source: <code>worker/</code>.</td>
            </tr>
            <tr>
              <td>Website</td>
              <td>A Cloudflare Worker running Next.js. Sign-in and the <code>finch login</code> approval page, plus the landing page and docs. Source: <code>web/</code>.</td>
            </tr>
            <tr>
              <td>Clerk</td>
              <td>Your sign-in, and the OAuth server for MCP clients that sign in instead of using a key.</td>
            </tr>
            <tr>
              <td>Release binaries</td>
              <td>What <code>/install</code> and <code>finch update</code> download: this repository&apos;s GitHub releases, or an R2 bucket you fill.</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>Before you start</h2>
      <ul>
        <li>A Cloudflare account. finchmcp.com runs on Workers Paid; the free plan&apos;s daily request limits are low for a relay.</li>
        <li>A Clerk account, Node 22, and <code>npx wrangler login</code> done once.</li>
        <li>
          Two hostnames: one for the hub (<code>finch.example.dev</code>) and one for the
          website (<code>example.dev</code>). Workers Custom Domains create the DNS records
          and certificates, so no wildcard DNS is needed. Your <code>workers.dev</code>{' '}
          subdomain works too.
        </li>
        <li>The repository, checked out at a release tag so the hub matches the published binaries:</li>
      </ul>
      <Code>{`git clone ${REPO} && cd finch
git checkout v1.8.0`}</Code>

      <h2>1. Set up Clerk</h2>
      <ol>
        <li>
          Create an application. A <b>development instance</b> is simplest for one person:
          it works on any origin. A production instance needs DNS on your domain; see the
          Clerk note under <a href="#limitations">Known limitations</a>.
        </li>
        <li>
          <b>Restrict sign-ups</b> to your email, or turn them off once your user exists. This
          step is required: development instances accept anyone by default, and a stranger who
          can sign in can log a CLI in to your hub, register your hub&apos;s own hostname to
          their account with <code>finch domain add</code>, and receive every call made to it.
          The <code>VANITY_SUFFIXES</code> and <code>VANITY_TENANT</code> settings below close
          the same hole in the hub. Do both.
        </li>
        <li>Create your user and copy its ID (<code>user_…</code>). It becomes your finch account ID.</li>
        <li>
          For MCP clients that sign in with OAuth (such as claude.ai custom connectors), open
          OAuth applications, turn on <b>dynamic client registration</b>, and set the default
          scopes for dynamically registered clients to <code>openid email profile</code>.
        </li>
        <li>Note the publishable key, the secret key, and the <b>Frontend API URL</b>.</li>
      </ol>

      <h2>2. Deploy the hub</h2>
      <p>
        Add a <code>selfhost</code> environment to <code>worker/wrangler.jsonc</code>. The full
        block, with every binding and migration it must repeat, is in the{' '}
        <a href={`${GUIDE}#2-configure-the-hub`}>self-hosting guide on GitHub</a>. The
        settings that are yours:
      </p>
      <div className="docs-table-wrap">
        <table>
          <thead>
            <tr><th>Setting</th><th>What it does</th></tr>
          </thead>
          <tbody>
            <tr><td><code>DEV</code> = <code>&quot;1&quot;</code></td><td>Turns on single-account mode. Keys, OAuth and machine tokens are checked exactly as in production.</td></tr>
            <tr><td><code>DEFAULT_TENANT</code></td><td>Your Clerk user ID. Every call on the hub host belongs to this account.</td></tr>
            <tr><td><code>WEB_URL</code></td><td>Your website origin. <code>finch login</code> sends you to <code>&lt;WEB_URL&gt;/cli</code>.</td></tr>
            <tr><td><code>CLERK_ISSUER</code></td><td>Clerk&apos;s Frontend API URL. Turns on OAuth sign-in for MCP clients.</td></tr>
            <tr><td><code>VANITY_SUFFIXES</code></td><td>Your hub hostname (<code>finch.example.dev</code>). Required on your own domain: with <code>VANITY_TENANT</code>, only your account can register it, so no one else can take over the hub. Not needed on <code>workers.dev</code>.</td></tr>
            <tr><td><code>VANITY_TENANT</code></td><td>Your Clerk user ID, the same value as <code>DEFAULT_TENANT</code>.</td></tr>
            <tr><td><code>FINCH_SERVICE_SECRET</code> (secret)</td><td>Shared with the website; authenticates its calls and signs CLI tokens.</td></tr>
            <tr><td><code>TICKET_SECRET</code> (secret)</td><td>Signs the tokens your machines use to connect.</td></tr>
            <tr><td><code>FINCH_ASSERTION_PRIVATE_JWKS</code> (secret, optional)</td><td>Signs <code>X-Finch-Assertion</code>, the caller identity your services can verify. Goes with <code>FINCH_ASSERTION_ACTIVE_KID</code> and <code>FINCH_ASSERTION_ISSUER</code>.</td></tr>
            <tr><td><code>RELEASES_BASE</code> or an R2 <code>RELEASES</code> bucket</td><td>Where binaries come from. Point <code>RELEASES_BASE</code> at <code>{`${REPO}/releases/download/v1.8.0`}</code> to use this repository&apos;s release.</td></tr>
          </tbody>
        </table>
      </div>
      <p>Set the secrets with fresh values and deploy:</p>
      <Code>{`cd worker && npm ci
SERVICE_SECRET="$(openssl rand -hex 32)"
printf %s "$SERVICE_SECRET" | npx wrangler secret put FINCH_SERVICE_SECRET --env selfhost
openssl rand -hex 32 | npx wrangler secret put TICKET_SECRET --env selfhost
node scripts/deploy-preflight.mjs selfhost
npx wrangler deploy --env selfhost`}</Code>
      <p>The website needs the same <code>FINCH_SERVICE_SECRET</code>, so deploy it from the same shell or keep the value somewhere safe.</p>

      <h2>3. Deploy the website</h2>
      <p>
        Add the matching <code>selfhost</code> environment to <code>web/wrangler.jsonc</code>{' '}
        (again, the full block is <a href={`${GUIDE}#3-configure-and-deploy-the-website`}>in the guide</a>):
        a <code>FINCH_HUB</code> service binding to your hub Worker,{' '}
        <code>HUB_URL</code> set to your hub&apos;s origin, <code>NEXT_PUBLIC_APP_ORIGIN</code>{' '}
        set to your website&apos;s exact origin, and your Clerk publishable key. Deploy the hub
        first, so the binding has something to point at.
      </p>
      <Code>{`cd ../web && npm ci
npx wrangler secret put CLERK_SECRET_KEY --env selfhost
printf %s "$SERVICE_SECRET" | npx wrangler secret put FINCH_SERVICE_SECRET --env selfhost
node scripts/deploy-preflight.mjs selfhost
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_... npx opennextjs-cloudflare build --env selfhost
npx opennextjs-cloudflare deploy -- --env selfhost`}</Code>

      <h2>4. Point the CLI at your hub</h2>
      <Code>{`curl -fsSL https://finch.example.dev/install | sh
finch login --hub https://finch.example.dev`}</Code>
      <p>
        Sign in on your website and approve the code. The CLI remembers the hub, so the rest
        of the usual flow needs no <code>--hub</code>:
      </p>
      <Code>{`finch add notes --service http://127.0.0.1:8000
finch service install
finch test notes
finch connect notes --client claude-code`}</Code>

      <h2>5. Check that it works</h2>
      <div className="docs-table-wrap">
        <table>
          <thead>
            <tr><th>Run</th><th>Expect</th></tr>
          </thead>
          <tbody>
            <tr><td><code>curl https://finch.example.dev/api/version</code></td><td>The version you deployed</td></tr>
            <tr><td><code>finch add hello --service http://127.0.0.1:8000</code></td><td>Prints <code>https://finch.example.dev/hello/mcp</code></td></tr>
            <tr><td><code>finch test hello</code></td><td>Lists the server&apos;s tools</td></tr>
            <tr><td><code>curl -i https://finch.example.dev/hello/mcp</code></td><td><code>401</code> with a <code>WWW-Authenticate: Bearer</code> challenge</td></tr>
            <tr><td><code>curl https://finch.example.dev/.well-known/oauth-protected-resource/hello/mcp</code></td><td><code>authorization_servers</code> is your Clerk Frontend API URL</td></tr>
          </tbody>
        </table>
      </div>

      <h2 id="limitations">Known limitations</h2>
      <p>
        These come from an audit of every <code>finchmcp.com</code> reference in the code.
        The <a href={COUPLING}>coupling checklist</a> lists the change that would remove each one.
      </p>
      <ul>
        <li><b>One account per hub.</b> Per-account subdomains on your own domain need code changes in the hub.</li>
        <li><b>The website&apos;s content names finchmcp.com.</b> The landing page, these docs, <code>/agents.md</code> and <code>/llms.txt</code> send visitors and agents to finchmcp.com until you edit them.</li>
        <li><b>Clerk production keys pin sign-in redirects to finchmcp.com</b> (<code>web/app/layout.tsx</code>). Use a development instance, or change that line in your copy.</li>
        <li><b>The installer&apos;s closing hints assume finchmcp.com</b>, and the CLI falls back to it when it has no saved hub. Pass <code>--hub</code> or set <code>FINCH_HUB</code>. <code>finch update</code> and <code>finch enroll</code> ignore <code>FINCH_HUB</code>: on a machine with no saved login, pass them <code>--hub</code>.</li>
        <li><b>Binaries come from this repository</b> unless you build and publish your own.</li>
        <li><b>The deploy tooling is written for finchmcp.com.</b> Use your own environment name, as above, rather than editing <code>production</code>.</li>
      </ul>
      <p>
        Updating is the same steps from a newer tag: deploy the hub, then the website, then
        run <code>finch update</code> on each machine (with <code>--hub</code> where there is no saved login). The full guide, with every configuration
        block, is <a href={GUIDE}>docs/self-host.md</a>.
      </p>

      <div className="docs-foot">
        <Link href="/docs/domains">← Domains</Link>
        <Link href="/docs/cli">CLI →</Link>
      </div>
    </>
  );
}
