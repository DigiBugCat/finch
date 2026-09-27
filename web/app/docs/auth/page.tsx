import type { Metadata } from 'next';
import { docsMetadata } from '../meta';
import Link from 'next/link';
import Code from '../code';

export const metadata: Metadata = docsMetadata('Keys & auth', 'How finch checks a caller before a request reaches your machine: finch_ keys, OAuth sign-in and the login token.');

export default function Auth() {
  return (
    <>
      <h1>Keys &amp; auth</h1>
      <p className="docs-lede">
        Every request to a service that isn&apos;t public carries a key or an OAuth
        sign-in. finch checks it before anything reaches your machine. If it&apos;s
        missing, wrong or revoked, the request stops there.
      </p>

      <h2>How a request is checked</h2>
      <p>
        A caller sends its key in the <code>Authorization</code> header:
      </p>
      <Code>{`POST https://sunny-wren-42.finchmcp.com/printer/mcp
Authorization: Bearer finch_...`}</Code>
      <p>
        finch checks the key, then removes the header before it relays the request
        to your machine. Your app never sees the caller&apos;s key, so it can&apos;t
        leak it in a log, and it needs no auth code of its own.
      </p>
      <p>
        finch stores only a hash of each key, plus its last four characters for
        display. The full key exists in one place: wherever you put it when it was
        shown.
      </p>

      <h2>When a request is refused</h2>
      <div className="docs-table-wrap">
        <table>
          <thead>
            <tr><th>Status</th><th>Why</th></tr>
          </thead>
          <tbody>
            <tr>
              <td><code>401</code></td>
              <td>No key was sent. The response carries the OAuth sign-in challenge, so a client such as claude.ai can start signing you in, even while the machine is offline.</td>
            </tr>
            <tr>
              <td><code>403</code></td>
              <td>A key was sent but doesn&apos;t work here: finch doesn&apos;t know it (it was mistyped or revoked; see <code>finch keys list</code>), or it is scoped to other services. The error says which.</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>Make a key</h2>
      <Code>{`finch keys mint web-client --service printer
<span class="o">finch_k3y5h0wn0nc3...</span>
<span class="c"># shown once: put it in the client now</span>`}</Code>
      <p>
        Every key needs a scope: <code>--service &lt;name&gt;</code> limits it to one
        service, <code>--all</code> lets it reach every service on the account. There
        is no default; you pick one. For Claude Code, Cursor and Codex,{' '}
        <code>finch connect</code> makes the key and puts it in the client for you.
      </p>

      <h2>List and revoke</h2>
      <Code>{`finch keys list
<span class="o">  k_a1b2c3      web-client</span>

finch keys revoke k_a1b2c3
<span class="o">finch: revoked key k_a1b2c3</span>`}</Code>
      <p>
        Revoking is immediate: the next request with that key is refused.{' '}
        <code>finch keys list</code> shows ids and labels, never the key itself. Both{' '}
        <code>finch keys list</code> and <code>finch keys mint</code> take{' '}
        <code>--json</code>.
      </p>

      <h2>Test through finch</h2>
      <p>
        Two commands reach a service through finch, the same way a client does, so
        you can confirm the whole path works:
      </p>
      <Code>{`finch test printer                               <span class="c"># list the service's MCP tools</span>
finch call printer echo --args '{"text":"hi"}'   <span class="c"># call one tool</span>`}</Code>

      <h2>The login token is a different thing</h2>
      <p>
        A <code>finch_</code> key lets a client reach a service. The login token is
        what <code>finch login</code> saves on your machine, and it can manage your
        whole account: add services, make keys and revoke access. It lasts about 30
        days.
      </p>
      <Code>{`finch token          <span class="c"># make a fresh login token, e.g. to set up another machine</span>
finch revoke-tokens  <span class="c"># log out every machine, including this one</span>`}</Code>
      <p>
        <code>finch token</code> is how you log in a second machine without a browser:
        pipe it into <code>finch login --token -</code> there (
        <code>finch token | ssh pi &quot;finch login --token -&quot;</code>), or set{' '}
        <code>FINCH_CLI_TOKEN</code>. Passing it as an argument works but puts the
        token in the other machine&apos;s process list and shell history.
      </p>
      <p>
        Your first machine has nothing to copy from: run <code>finch login</code>{' '}
        there and approve the code on any device where you&apos;re signed in. That
        approval page is the only part of finch that needs a browser.
      </p>

      <h2>OAuth</h2>
      <p>
        MCP clients that speak OAuth can sign in instead of using a key. finch
        publishes the standard discovery metadata that points them at finch&apos;s
        sign-in service, so a client like claude.ai&apos;s custom connectors signs
        you in there and then presents the resulting token instead of a{' '}
        <code>finch_</code> key. The token only carries your identity and email, and
        only you, the account owner, are let in. For everything else, make a key.
      </p>

      <div className="docs-foot">
        <Link href="/docs/services">&larr; Services &amp; machines</Link>
        <Link href="/docs/acls">Access control &rarr;</Link>
      </div>
    </>
  );
}
