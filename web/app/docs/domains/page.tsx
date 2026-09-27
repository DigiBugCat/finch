import type { Metadata } from 'next';
import { docsMetadata } from '../meta';
import Link from 'next/link';
import Code from '../code';

export const metadata: Metadata = docsMetadata('Domains', 'Your finch account address, <slug>.finchmcp.com, and the state of custom domains.');

export default function Domains() {
  return (
    <>
      <h1>Domains</h1>
      <p className="docs-lede">
        Every account gets an address on finchmcp.com, and every service you publish
        lives under it as a path. Custom domains are on the way but don&apos;t serve
        traffic yet.
      </p>

      <h2>Your account address</h2>
      <p>
        Your account address (also called the slug) is the first part of every URL
        finch gives you. finch picks it the first time you use your account: a word, a
        bird and a number, such as <code>sunny-wren-42</code>. Each service answers under its
        name:
      </p>
      <Code>{`https://<slug>.finchmcp.com/<name>/
<span class="c"># an MCP server answers at /<name>/mcp</span>

https://sunny-wren-42.finchmcp.com/notes/mcp`}</Code>
      <p>
        The address stays the same across restarts, reboots and network changes, and
        for every machine that serves your services. There is no command to rename it
        yet. <code>finch add</code> prints each service&apos;s full URL, and{' '}
        <code>finch fleet</code> lists them all (the <code>url</code> field with{' '}
        <code>--json</code>).
      </p>
      <p>
        A mistyped address gets a <code>404</code> that says no finch account uses
        it, so check the URL against <code>finch fleet</code>.
      </p>

      <h2>Custom domains <span className="docs-badge">Not live yet</span></h2>
      <div className="docs-note">
        <b>Custom domains don&apos;t serve traffic yet.</b> The{' '}
        <code>finch domain</code> commands below accept and list hostnames, but the
        part of finch that routes a custom hostname to your services isn&apos;t
        switched on. Use your <code>&lt;slug&gt;.finchmcp.com</code> address for now.
        This page will say when that changes.
      </div>
      <p>
        When they are live, you&apos;ll be able to serve your services on your own
        hostname, one per machine, with the service in the path:
      </p>
      <Code>{`https://<machine>.yourdomain.com/<name>/`}</Code>
      <p>The commands that exist today:</p>
      <Code>{`finch domain ls                    <span class="c"># list custom hostnames on this account</span>
finch domain add mcp.example.com   <span class="c"># record one and print the DNS record it will need</span>
finch domain rm mcp.example.com    <span class="c"># remove one</span>`}</Code>
      <p>
        <code>finch domain ls</code> takes <code>--json</code>. Removal only works for
        hostnames on your account. Your finchmcp.com address keeps working either way;
        a custom domain would be an extra name, not a replacement.
      </p>

      <div className="docs-foot">
        <Link href="/docs/acls">← Access control</Link>
        <Link href="/docs/cli">CLI reference →</Link>
      </div>
    </>
  );
}
