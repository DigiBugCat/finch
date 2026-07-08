import Link from 'next/link';

function Code({ children }: { children: string }) {
  return <pre className="docs-code"><code dangerouslySetInnerHTML={{ __html: children }} /></pre>;
}

export default function Auth() {
  return (
    <>
      <h1>Keys &amp; auth</h1>
      <p className="docs-lede">
        Every request to your endpoint carries a bearer key. The hub checks it at
        the edge, before anything reaches your box. If the key is wrong, missing,
        or revoked, the request stops there.
      </p>

      <h2>How a request is authenticated</h2>
      <p>
        A caller sends its key in the <code>Authorization</code> header:
      </p>
      <Code>{`POST https://your-slug.finchmcp.com/printer/mcp
Authorization: Bearer finch_...`}</Code>
      <p>
        The hub verifies the key, then strips the header before relaying the
        request to your box. Your local service never sees the caller&apos;s key,
        so it cannot leak it in logs, and it does not need any auth code of its own.
      </p>
      <p>
        The hub stores only a hash of each key plus the last four characters for
        display. The full key exists in exactly one place: wherever you put it
        when it was shown at mint.
      </p>

      <h2>Mint a key</h2>
      <Code>{`finch keys mint web-client --service printer
<span class="o">finch_k3y5h0wn0nc3...</span>
<span class="c"># shown once. store it in the client now.</span>`}</Code>
      <p>
        Every key needs a scope: <code>--service &lt;id&gt;</code> limits it to one
        service, <code>--all</code> lets it reach every service on the account.
        There is no unscoped default, you have to pick one.
      </p>

      <h2>List and revoke</h2>
      <Code>{`finch keys list
<span class="o">  k_a1b2c3      web-client</span>

finch keys revoke k_a1b2c3
<span class="o">finch: revoked key k_a1b2c3</span>`}</Code>
      <p>
        Revocation is immediate. The next request with that key is rejected at the
        edge. <code>finch keys list</code> shows ids and labels, never the key
        itself. <code>finch keys list</code> and <code>finch keys mint</code> take{' '}
        <code>--json</code> for scripting.
      </p>
      <div className="docs-note">
        <b>Expiry.</b> The dashboard has a key expiry setting. Keys are stamped
        with an expiry at mint, and the hub enforces it when enforcement is turned
        on in Settings. Revocation works either way.
      </div>

      <h2>Test with a key in the loop</h2>
      <p>
        Two commands exercise a service through the hub, so you can confirm the
        path works end to end:
      </p>
      <Code>{`finch test printer                          <span class="c"># list the service&#39;s MCP tools</span>
finch call printer echo --args '{"text":"hi"}'   <span class="c"># invoke one tool</span>`}</Code>

      <h2>The CLI token is a different thing</h2>
      <p>
        A <code>finch_</code> key lets a caller reach one service. The CLI token
        is a tenant-admin credential: it is what <code>finch login</code> saves
        on your box, and it can mint keys, add services, and revoke access. It
        lasts about 30 days.
      </p>
      <Code>{`finch token          <span class="c"># mint a fresh CLI token (e.g. to provision a new box)</span>
finch revoke-tokens  <span class="c"># de-authorize every CLI login, including this box</span>`}</Code>
      <p>
        <code>finch token</code> is how you enroll a second box without a browser:
        pass its output to <code>finch login --token</code> on the new machine.
        To revoke from the web instead, use the dashboard under
        Settings &rarr; CLI access.
      </p>

      <h2>OAuth</h2>
      <p>
        MCP clients that speak OAuth can authenticate at the door without a raw
        key. The hub publishes standard protected-resource discovery metadata,
        so a client like Claude&apos;s custom connectors can run its own OAuth
        flow and present the resulting token instead of a <code>finch_</code> key.
        For everything else, mint a key.
      </p>

      <div className="docs-foot">
        <Link href="/docs/services">&larr; Services &amp; boxes</Link>
        <Link href="/docs/acls">Access control &rarr;</Link>
      </div>
    </>
  );
}
