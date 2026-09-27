import type { Metadata } from 'next';
import { docsMetadata } from '../meta';
import Link from 'next/link';
import Code from '../code';

export const metadata: Metadata = docsMetadata('Access control', 'Who can reach a finch service: scoped finch_ keys, OAuth sign-in, or public.');

export default function Acls() {
  return (
    <>
      <h1>Access control</h1>
      <p className="docs-lede">
        finch decides who can reach a service before a request ever touches your
        machine. Everything is managed from the CLI: you choose, per
        service, whether callers need a key, and you choose what each key can reach.
      </p>
      <p>
        A finch account belongs to one person. There are no teams, groups,
        shared members, or access-control rules to maintain: the scope of each
        key is the whole policy.
      </p>

      <h2>Three ways in</h2>
      <div className="docs-table-wrap">
        <table>
          <thead>
            <tr><th>Caller presents</th><th>Gets in when</th></tr>
          </thead>
          <tbody>
            <tr>
              <td>A <code>finch_</code> key</td>
              <td>The key is live (not revoked) and its scope is <code>--all</code> or names the service. Nothing else is checked. See <Link href="/docs/auth">Keys &amp; auth</Link>.</td>
            </tr>
            <tr>
              <td>An OAuth token</td>
              <td>An MCP client that speaks OAuth (such as Claude&apos;s custom connectors) signed in as you, the account&apos;s owner. Anyone else&apos;s sign-in is refused.</td>
            </tr>
            <tr>
              <td>Nothing</td>
              <td>The service is set to <code>public</code>. It needs no key at all.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        Anything else is refused before it reaches your machine: a <code>401</code>{' '}
        when no key was sent, a <code>403</code> when the key is unknown, revoked or
        scoped to other services. There is no sign-in page in front of your services:
        a browser opening a key-protected service gets the same <code>401</code> an
        unauthenticated client does.
      </p>

      <h2>Key scope</h2>
      <p>
        Every key is scoped when it is minted, and that scope is the only thing
        that decides what it reaches. <code>--service &lt;name&gt;</code>{' '}
        limits it to one service; <code>--all</code> lets it reach every service on
        the account. There is no unscoped default.
      </p>
      <Code>{`finch keys mint scraper-only --service scraper
finch keys mint everything --all`}</Code>

      <h2>One key per agent</h2>
      <p>
        The common setup: you run several MCP services and several agents, and
        each agent should reach only some of them. Mint one key per agent, scoped
        to what that agent needs. Revoking one key cuts off exactly one caller.
      </p>
      <Code>{`<span class="c"># a key for the research agent, scoped to one service</span>
finch keys mint research-agent --service scraper

<span class="c"># see what exists, then revoke it later; access stops immediately</span>
finch keys list
finch keys revoke &lt;id&gt;`}</Code>

      <h2>Public services</h2>
      <p>
        A service whose auth is <code>public</code> is open: no key, no OAuth. Use
        it for a web page or an API you mean to publish, and add{' '}
        <code>--forward-all</code> when you publish it so every path is forwarded,
        not just <code>/&lt;name&gt;/mcp</code> (see{' '}
        <Link href="/docs/services#web-apps">Web apps and REST APIs</Link>). Switch a
        service back to requiring a key at any time.
      </p>
      <Code>{`finch add docs-site --service http://127.0.0.1:3000 --public --forward-all
<span class="c"># later:</span>
finch auth docs-site key      <span class="c"># back to finch_ keys (and OAuth)</span>
finch auth docs-site public   <span class="c"># open to anyone again</span>`}</Code>

      <div className="docs-foot">
        <Link href="/docs/auth">← Keys &amp; auth</Link>
        <Link href="/docs/domains">Domains →</Link>
      </div>
    </>
  );
}
