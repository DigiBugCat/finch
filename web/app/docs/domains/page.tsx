import Link from 'next/link';

function Code({ children }: { children: string }) {
  return <pre className="docs-code"><code dangerouslySetInnerHTML={{ __html: children }} /></pre>;
}

export default function Domains() {
  return (
    <>
      <h1>Domains</h1>
      <p className="docs-lede">
        Every account gets a hub domain: <code>&lt;slug&gt;.finchmcp.com</code>. Services
        live under it as paths. You can also bring your own hostname and serve the same
        services on your domain.
      </p>

      <h2>Your hub domain</h2>
      <p>
        The slug is the routing key. It resolves <code>&lt;slug&gt;.finchmcp.com</code> to
        your account, and each service answers under its <code>app_path</code>:
      </p>
      <Code>{`https://<slug>.finchmcp.com/<app_path>/
<span class="c"># an MCP server answers at /<app_path>/mcp</span>`}</Code>
      <p>
        A slug is assigned automatically the first time a box enrolls, so your account
        always has a working public host. Slugs are lowercase letters, digits, and
        hyphens, at least 3 characters. <code>finch add</code> prints each service&apos;s
        public endpoint, slug included (the <code>url</code> field with{' '}
        <code>--json</code>).
      </p>

      <h2>Custom domains</h2>
      <p>
        Serve your boxes on your own domain instead of <code>.finchmcp.com</code>. The
        recommended naming is one hostname per box, with the service in the path:
      </p>
      <Code>{`https://<box>.yourdomain.com/<service>/`}</Code>
      <p>Setup is three steps, all with <code>finch domain</code>:</p>
      <div className="docs-table-wrap">
        <table>
          <thead>
            <tr><th>Step</th><th>What happens</th></tr>
          </thead>
          <tbody>
            <tr>
              <td>1. Add the hostname</td>
              <td><code>finch domain add pelican.yourdomain.com</code>. Name it after the box it reaches.</td>
            </tr>
            <tr>
              <td>2. Create the DNS record</td>
              <td>The command prints the exact CNAME record to create at your DNS provider. It points your hostname at Finch.</td>
            </tr>
            <tr>
              <td>3. Wait for DNS</td>
              <td>Once the record resolves, the certificate is issued automatically and your services go live on the new name.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <Code>{`finch domain ls                    <span class="c"># list custom hostnames on this account</span>
finch domain add mcp.example.com   <span class="c"># add one; prints the CNAME to configure</span>
finch domain rm mcp.example.com    <span class="c"># remove one; traffic stops immediately</span>`}</Code>
      <p>
        <code>finch domain ls</code> supports <code>--json</code> for scripting. Removal
        only works for hostnames on your account.
      </p>
      <div className="docs-note">
        <b>Removal is immediate.</b> Removing a hostname stops traffic on it right away.
        Your hub domain keeps working; custom domains are additional names, not replacements.
      </div>

      <div className="docs-foot">
        <Link href="/docs/acls">← Access control</Link>
        <Link href="/docs/cli">CLI reference →</Link>
      </div>
    </>
  );
}
