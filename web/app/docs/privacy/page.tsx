import type { Metadata } from 'next';
import { docsMetadata } from '../meta';
import Link from 'next/link';

export const metadata: Metadata = docsMetadata('Privacy & data handling', 'What finch sees while it relays a call, what it keeps, and what it never stores.');

export default function PrivacyAndDataHandling() {
  return (
    <>
      <h1>Privacy &amp; data handling</h1>
      <p className="docs-lede">
        finch works like a Cloudflare Tunnel: encrypted transport, an outbound-only
        connection from your machine, and no retention of the requests and responses
        it relays. finch is not end-to-end encrypted, because its Cloudflare edge
        ends the transport encryption and handles each payload in memory long enough
        to route it.
      </p>

      <h2>Ordinary relay traffic</h2>
      <p>
        A client connects to finch over HTTPS. finch checks the caller&apos;s key or
        sign-in and relays the request to your machine over the machine&apos;s outbound
        WSS connection. Responses come back over the same encrypted connections. Your
        machine opens no inbound port and its IP address is never shown to the caller.
        The last hop, from finch on your machine to your app, is yours to choose:
        finch allows plain HTTP to a loopback address and to single-label hosts (such
        as a Docker Compose service name). A single-label name can resolve to another
        computer, and when it does, that hop crosses your network in the clear. Use{' '}
        <code>https://</code> for any app that isn&apos;t on the machine itself.
      </p>
      <div className="docs-note">
        <b>The guarantee:</b> finch handles request and response bodies only in
        transit, to relay them. It does not log or persist those bodies.
      </div>
      <p>
        This is transport encryption, not end-to-end encryption. finch&apos;s runtime
        can read the plaintext while it forwards a request, even though it keeps none
        of it. So we don&apos;t claim that finch is unable to inspect traffic.
      </p>

      <h2>Operational metadata we retain</h2>
      <p>
        finch keeps a short record of each call so you can see what reached your
        services and troubleshoot them with <code>finch logs &lt;name&gt;</code>. For
        each relayed call, that record holds:
      </p>
      <ul>
        <li>the time of the call;</li>
        <li>the route (the request path, such as <code>/notes/mcp</code>);</li>
        <li>the caller&apos;s label: a key&apos;s label, or the account id of an OAuth sign-in;</li>
        <li>the response status code and how long it took; and</li>
        <li>running counts of requests, latency and errors.</li>
      </ul>
      <p>
        finch also records a call it answers itself with a <code>503</code> because
        no machine serving the service is connected. A call refused for a missing or
        wrong key is not recorded. Beyond calls, finch keeps what it needs to run your account: your services,
        machines, keys and settings. Keys are stored as hashes; the full key is shown
        only once, when it is made. Request and response bodies are never part of the
        call record, logs or metrics.
      </p>

      <h2>What this means in practice</h2>
      <ul>
        <li>Every request through a finch address gets the no-retention guarantee.</li>
        <li>The call record is shown to you, the account owner, and to no other finch user.</li>
        <li>Each finch account belongs to one person; there are no shared accounts or team members.</li>
      </ul>

      <h3>Accounts from before September 2026</h3>
      <p className="dim">
        finch used to have team features. Their records (members, invitations,
        groups, access rules and requests, and the activity entries about them) are
        deleted the first time finch handles a request for such an account, and if
        anyone besides the owner could sign in, its keys, machines and logins are
        revoked so the owner can re-add their own.
      </p>

      <div className="docs-foot">
        <Link href="/docs/cli">← CLI reference</Link>
        <Link href="/docs">Quickstart →</Link>
      </div>
    </>
  );
}
