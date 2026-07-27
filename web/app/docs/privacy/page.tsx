import Link from 'next/link';

export default function PrivacyAndDataHandling() {
  return (
    <>
      <h1>Privacy &amp; data handling</h1>
      <p className="docs-lede">
        Finch provides a Cloudflare Tunnel-style privacy boundary: encrypted
        transport, an outbound-only connection from your box, and no retention of
        ordinary relayed request or response bodies. Finch is not end-to-end
        encrypted, because its Cloudflare edge terminates transport encryption and
        processes each payload in memory long enough to route it.
      </p>

      <h2>Ordinary relay traffic</h2>
      <p>
        A client connects to Finch over HTTPS. Finch authenticates the caller and
        relays the request to your box over its outbound WSS connection. Responses
        return over the same encrypted network legs. Your box does not open an
        inbound port or expose its IP address to the caller. The final hop, from
        the box agent to your service, is your configuration choice: the agent
        allows plaintext HTTP to a loopback address and to single-label hosts
        (such as a Docker Compose service name). Single-label names can resolve
        off the box, and when they do that hop crosses your network in the clear
        — so use <code>https://</code> for any upstream that is not on the box
        itself.
      </p>
      <div className="docs-note">
        <b>The guarantee:</b> Finch handles ordinary MCP request and response bodies
        transiently to provide the relay. It does not log or persist those bodies.
      </div>
      <p>
        This is transport encryption, not end-to-end encryption. Finch&apos;s runtime
        can access plaintext while forwarding a request, even though the payload is
        not retained. We therefore do not claim that Finch is cryptographically
        unable to inspect traffic.
      </p>

      <h2>Operational metadata we retain</h2>
      <p>
        Finch stores a limited call record so owners can see service health and
        troubleshoot availability. For ordinary relayed calls, that record contains:
      </p>
      <ul>
        <li>the call timestamp;</li>
        <li>the target service route;</li>
        <li>the authenticated caller label;</li>
        <li>the response status code and latency; and</li>
        <li>aggregate request counts, latency, and error-rate metrics.</li>
      </ul>
      <p>
        Finch also stores the account, service, box, key, access-control, and audit
        configuration needed to operate your workspace. Finch access keys are
        stored as hashes; the plaintext key is shown only when it is minted.
        Ordinary MCP request and response bodies are not part of call history,
        logs, or analytics.
      </p>

      <h2>Test Chat is a separate processing path</h2>
      <p>
        Dashboard <b>Test Chat</b> deliberately uses a hosted model. When you use it,
        Finch sends your chat messages and your service&apos;s tool names, descriptions,
        and input schemas to Cloudflare Workers AI. If the model invokes a tool,
        its arguments and the tool&apos;s result are also sent to Workers AI so the model
        can complete its answer.
      </p>
      <div className="docs-note">
        Do not put sensitive information into Test Chat. The ordinary relay-body
        non-retention guarantee does not mean that Workers AI cannot process the
        Test Chat data described above.
      </div>

      <h2>What this means in practice</h2>
      <ul>
        <li>Use the ordinary Finch endpoint when you want the relay non-retention guarantee.</li>
        <li>Use Test Chat only when sending the relevant data to Workers AI is acceptable.</li>
        <li>
          Treat operational metadata as visible to workspace owners through the
          dashboard and audit surfaces.
        </li>
      </ul>

      <div className="docs-foot">
        <Link href="/docs/cli">← CLI reference</Link>
        <Link href="/docs">Quickstart →</Link>
      </div>
    </>
  );
}
