import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'AviaryMCP | Finch docs',
  description: 'Build one Python tool surface and publish it through MCP, REST, and OpenAPI with Finch.',
};

function Code({ children }: { children: string }) {
  return <pre className="docs-code"><code dangerouslySetInnerHTML={{ __html: children }} /></pre>;
}

export default function AviaryMCPDocs() {
  return (
    <>
      <h1>AviaryMCP</h1>
      <p className="docs-lede">
        AviaryMCP is Finch&apos;s opinionated Python SDK for new MCP services. Define a
        tool once and get the MCP transport, typed REST endpoints, OpenAPI, Finch
        enrollment, and the same authorization decision across every interface.
      </p>

      <div className="docs-note">
        <b>Public release candidate.</b> Version <code>0.1.0rc6</code> is available on{' '}
        <a href="https://pypi.org/project/aviary-mcp/0.1.0rc6/" target="_blank" rel="noreferrer">
          PyPI
        </a>{' '}
        and requires the Finch 1.6 agent. The normal Finch CLI and <code>finch.yml</code>{' '}
        remain supported for existing, non-Python, and non-SDK services.
        {' '}Machine-readable guidance is available in the hosted{' '}
        <a href="/llms.txt">llms.txt</a> and AviaryMCP&apos;s{' '}
        <a href="https://github.com/DigiBugCat/aviary-mcp/blob/main/llms.txt" target="_blank" rel="noreferrer">
          project llms.txt
        </a>.
      </div>

      <h2>When to use it</h2>
      <div className="docs-table-wrap">
        <table>
          <thead>
            <tr><th>You have</th><th>Use</th></tr>
          </thead>
          <tbody>
            <tr>
              <td>A new Python MCP service</td>
              <td>AviaryMCP. The application owns its tools, routes, and Finch registration.</td>
            </tr>
            <tr>
              <td>An existing HTTP/MCP service, or another language</td>
              <td>The <Link href="/docs">Finch quickstart</Link> and <code>finch.yml</code>.</td>
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
        AviaryMCP is published publicly on PyPI. Pin the release candidate while
        evaluating it so a future prerelease does not change underneath your service.
      </p>
      <Code>{`python -m pip install 'aviary-mcp==0.1.0rc6'`}</Code>

      <h2>2. Define the service</h2>
      <p>Save this as <code>server.py</code>:</p>
      <Code>{`from aviary_mcp import AviaryMCP, Finch

service = "calculator"

mcp = AviaryMCP(
    service,
    finch=Finch.local(
        path=service,
        binary="/usr/local/bin/finch",
    ),
)

@mcp.tool
def add(a: int, b: int) -&gt; int:
    """Add two integers."""
    return a + b

if __name__ == "__main__":
    mcp.run()`}</Code>
      <p>
        <code>Finch.local</code> starts a dedicated zero-config Finch child and keeps
        its approval scoped to this project. Pass the absolute Finch 1.6+ binary path;
        the SDK never downloads or silently selects executable code from <code>PATH</code>.
        The tenant is bound to the account that approves the first-run device prompt.
      </p>

      <h3>Use an existing Finch agent instead</h3>
      <p>
        For sidecars, system services, and shared container groups, choose the other
        explicit mode and name the permissioned Unix socket:
      </p>
      <Code>{`mcp = AviaryMCP(
    "calculator",
    finch=Finch.agent(
        path="calculator",
        socket="/run/finch/control.sock",
    ),
)
mcp.run()`}</Code>
      <p>
        Both modes publish the same application at <code>/mcp</code>, <code>/api/v1</code>,
        and <code>/birdz</code>. Ordinary FastMCP tool decorators need no Finch route code.
      </p>

      <h2>3. Start and approve it</h2>
      <Code>{`python server.py
<span class="o">AviaryMCP is not enrolled with Finch.</span>
<span class="o">  Open: https://finchmcp.com/aviary/authorize?code=ABCD-EFGH</span>
<span class="o">  Code: ABCD-EFGH</span>
<span class="o">  Service: calculator (calculator)</span>
<span class="o">  Routes: /mcp, /api/v1, /birdz</span>
<span class="o">  Edge auth: key</span>`}</Code>
      <p>
        Open the printed URL on any signed-in device. Finch shows the exact service,
        routes, edge mode, and device-key fingerprint before you approve it. Finch
        stores the resulting service-scoped credential; your application never
        receives a CLI token, device secret, or caller key. On later starts, the saved
        approval is reused and the service registers automatically.
      </p>
      <div className="docs-note">
        <b>No duplicate configuration.</b> Do not also add this <code>app_path</code>{' '}
        to <code>finch.yml</code>. AviaryMCP holds a renewable dynamic registration;
        <code>finch.yml</code> is for services the SDK does not manage.
      </div>

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
            <tr><td>Liveness / readiness</td><td><code>/calculator/birdz</code> and <code>/calculator/birdz/ready</code></td></tr>
          </tbody>
        </table>
      </div>
      <Code>{`curl -X POST \\
  https://your-slug.finchmcp.com/calculator/api/v1/tools/add \\
  -H 'Authorization: Bearer finch_...' \\
  -H 'content-type: application/json' \\
  -d '{"a": 20, "b": 22}'`}</Code>
      <p>
        A caller still authenticates to Finch with a <code>finch_</code> key or OAuth.
        Finch validates that credential at the edge, strips it, and signs a short-lived
        assertion bound to the exact method, path, query, body, tenant, and service.
        AviaryMCP&apos;s automatically configured assertion verifier checks it before MCP
        or REST can invoke the tool.
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
        OpenAPI. Namespaces keep tools from different birds from colliding.
      </p>

      <h2>Production boundaries</h2>
      <ul>
        <li>Use one Finch sidecar/control socket per mutually trusted application group.</li>
        <li>Gate rollout on <code>/birdz/ready</code>, not liveness alone.</li>
        <li>Keep the Finch state volume persistent so approval survives restarts.</li>
        <li>Use a shared atomic replay store before running multiple application workers.</li>
        <li>Keep private edge auth as the default; public exposure requires separate explicit approval.</li>
      </ul>

      <div className="docs-foot">
        <Link href="/docs">&larr; Quickstart</Link>
        <Link href="/docs/services">Services &amp; boxes &rarr;</Link>
      </div>
    </>
  );
}
