import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'AviaryMCP | Finch docs',
  description: 'Build one Python tool surface for MCP, REST, and OpenAPI, and publish it with the Finch CLI.',
};

function Code({ children }: { children: string }) {
  return <pre className="docs-code"><code dangerouslySetInnerHTML={{ __html: children }} /></pre>;
}

export default function AviaryMCPDocs() {
  return (
    <>
      <h1>AviaryMCP</h1>
      <p className="docs-lede">
        AviaryMCP is an opinionated Python SDK for new MCP services. Define a tool
        once and get the MCP transport, typed REST endpoints, and OpenAPI from the
        same registry. Run it on loopback like any other local service, then publish
        it with the Finch CLI.
      </p>

      <div className="docs-note">
        <b>Public release candidate.</b> Version <code>0.1.0rc6</code> is available on{' '}
        <a href="https://pypi.org/project/aviary-mcp/0.1.0rc6/" target="_blank" rel="noreferrer">
          PyPI
        </a>
        . Agents can read the hosted <a href="/llms.txt">llms.txt</a> and
        AviaryMCP&apos;s{' '}
        <a href="/aviarymcp-llms.txt">
          project llms.txt
        </a>{' '}
        for the same guidance in machine-readable form.
      </div>

      <h2>When to use it</h2>
      <div className="docs-table-wrap">
        <table>
          <thead>
            <tr><th>You have</th><th>Use</th></tr>
          </thead>
          <tbody>
            <tr>
              <td>A new Python MCP service that should also speak REST</td>
              <td>AviaryMCP, published with <code>finch add</code>.</td>
            </tr>
            <tr>
              <td>An existing HTTP/MCP service, or another language</td>
              <td>The <Link href="/docs">Finch quickstart</Link> as is.</td>
            </tr>
            <tr>
              <td>Several existing FastMCP servers</td>
              <td>Mount them into one AviaryMCP parent, with a namespace for each child.</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>1. Install the release candidate</h2>
      <p>
        Pin the release candidate while evaluating it so a future prerelease does
        not change underneath your service.
      </p>
      <Code>{`python -m pip install 'aviary-mcp==0.1.0rc6'`}</Code>

      <h2>2. Define the service</h2>
      <p>Save this as <code>server.py</code>:</p>
      <Code>{`from aviary_mcp import AviaryMCP

mcp = AviaryMCP("calculator")

@mcp.tool
def add(a: int, b: int) -&gt; int:
    """Add two integers."""
    return a + b

if __name__ == "__main__":
    mcp.run(transport="http", host="127.0.0.1", port=8000)`}</Code>
      <p>
        By default AviaryMCP binds only to loopback, which is exactly what the Finch
        agent on the same box needs. It serves MCP at <code>/mcp</code>, the REST
        API under <code>/api/v1</code>, and liveness at <code>/birdz</code>.
      </p>

      <h2>3. Publish it with Finch</h2>
      <p>
        From here it is an ordinary Finch service. With the CLI installed and
        logged in (see the <Link href="/docs">quickstart</Link>):
      </p>
      <Code>{`python server.py &amp;
finch add calculator --service http://127.0.0.1:8000
finch run
<span class="o">✓ https://your-slug.finchmcp.com/calculator/</span>`}</Code>

      <h2>4. Use MCP or REST</h2>
      <p>The same <code>add</code> tool is available through each generated interface:</p>
      <div className="docs-table-wrap">
        <table>
          <thead>
            <tr><th>Interface</th><th>Path</th></tr>
          </thead>
          <tbody>
            <tr><td>MCP</td><td><code>/calculator/mcp</code></td></tr>
            <tr><td>Tool catalog</td><td><code>/calculator/api/v1/tools</code></td></tr>
            <tr><td>Call a tool</td><td><code>/calculator/api/v1/tools/add</code></td></tr>
            <tr><td>OpenAPI 3.1</td><td><code>/calculator/api/v1/openapi.json</code></td></tr>
            <tr><td>Liveness</td><td><code>/calculator/birdz</code></td></tr>
          </tbody>
        </table>
      </div>
      <Code>{`finch test calculator
finch call calculator add --args '{"a": 20, "b": 22}'

curl -X POST \\
  https://your-slug.finchmcp.com/calculator/api/v1/tools/add \\
  -H 'Authorization: Bearer finch_...' \\
  -H 'content-type: application/json' \\
  -d '{"a": 20, "b": 22}'`}</Code>
      <p>
        A caller authenticates to Finch with a <code>finch_</code> key or OAuth.
        Finch validates that credential at the edge and strips it before the request
        reaches your box, so the service never sees the caller&apos;s key.
      </p>

      <h2>Compose existing FastMCP servers</h2>
      <Code>{`from fastmcp import FastMCP
from aviary_mcp import AviaryMCP

weather = FastMCP("weather")

@weather.tool
def forecast(city: str) -&gt; str:
    return f"sunny in {city}"

mcp = AviaryMCP("aviary")
mcp.mount(weather, namespace="weather")`}</Code>
      <p>
        The mounted tool becomes <code>weather_forecast</code> in MCP, REST, and
        OpenAPI. Namespaces keep tools from different servers from colliding.
      </p>

      <div className="docs-foot">
        <Link href="/docs">&larr; Quickstart</Link>
        <Link href="/docs/services">Services &amp; boxes &rarr;</Link>
      </div>
    </>
  );
}
