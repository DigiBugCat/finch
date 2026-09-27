# finch privacy and data handling

Status: **current.** This document defines the privacy guarantee for finch's production relay. It
distinguishes transport encryption from application retention, because treating
those as one claim would be misleading.

## The short version

- Network traffic is encrypted from the client to finch with HTTPS/TLS and
  from finch to the finch agent on your machine with WSS/TLS.
- finch is not end-to-end encrypted. Cloudflare terminates those TLS
  connections, and the finch relay can access request and response plaintext
  while it forwards a call.
- The ordinary MCP relay processes request and response bodies transiently. It
  does not write those bodies to finch application logs, Durable Object state,
  call history, or metrics.
- finch retains documented operational and control-plane metadata needed to
  authenticate callers, route calls, show health, enforce access, and operate
  the service.
- finch sends no relay data to an AI model, and the hub has no AI binding.

Accordingly, finch must not be described as E2EE or as technically unable to
see messages. Accurate language is: **encrypted in transit; ordinary relayed
payloads are processed transiently and are not logged or persisted by finch.**

## Transport and trust boundary

In production, an ordinary request follows this path:

```text
MCP client -- HTTPS/TLS --> Cloudflare-hosted finch relay
                                |
                                +-- WSS/TLS --> finch agent (dialed out from your machine)
                                                       |
                                                       +-- local HTTP(S) --> MCP service
```

HTTPS and WSS protect traffic against passive observers on the network. They do
not make the payload opaque to Cloudflare or to finch code running there:
Cloudflare terminates both encrypted connections, and the relay reconstructs
the HTTP request and response to forward them. The agent on your machine also
necessarily handles plaintext before calling the local service.

The production web and relay entry points reject plaintext HTTP before
authentication or body handling. The agent refuses non-loopback HTTP **hub**
URLs, non-loopback WS relay URLs, and TLS-to-plaintext redirects.

The agent-to-local-service connection is different, and is chosen by whoever
runs the machine. Loopback HTTP (for example, `http://127.0.0.1:8000`) does not leave
the machine. But the agent also accepts a plaintext `http://` upstream whose host is
a **single DNS label** (for example `http://nas:8000` or a Docker Compose
service name like `http://hello-mcp:8000`), because container networks address
services that way. Such names are not necessarily on the machine: they routinely resolve
elsewhere via `/etc/hosts`, a DNS search domain, or LLMNR. When one does, that
final hop is relayed **in the clear across your network**, carrying request and
response bodies and the hub-signed `X-Finch-Assertion` caller-identity header.

Only dotted names (`http://host.example`) and non-loopback IP literals are
refused over plaintext. So finch does **not** guarantee the final hop is
encrypted — that is the operator's configuration decision. Use `https://` for
any upstream that is not genuinely on the machine.

Cloudflare's underlying platform may process network and security telemetry
under the deployment's Cloudflare configuration and terms. finch's guarantee
below describes what the finch application deliberately records; it is not a
claim that Cloudflare is cryptographically unable to inspect traffic.

## Ordinary MCP relay

For a normal call made directly to a finch service URL, finch buffers or
streams payload bytes only as needed to forward the request and response. The
ordinary relay does not intentionally:

- persist request or response bodies in Durable Objects or another finch data
  store;
- include bodies in application logs, exceptions, traces, or metrics; or
- send bodies to an AI model or other payload-processing integration.

The caller's local MCP client and the local MCP service are outside this
application-retention guarantee; either endpoint may keep its own history or
logs. Operators should also avoid adding platform log capture, tracing, or
debug middleware that records raw headers or bodies.

## Data finch retains

finch retains the following operational metadata for ordinary relay calls:

| Category | Retained fields or derived values | Purpose |
|---|---|---|
| Recent call | timestamp, route, caller label, HTTP response status, and duration, stored within the account's service record | recent activity and diagnosis; `finch logs <name>` shows them |
| Aggregate metrics | call count, hourly traffic and latency buckets, rolling p50/p95 latency, error rate | service health |
| Activity log | timestamp, actor/caller label, action, service and route target, result status | account audit trail |
| Connection health | service and machine identity, connection state, last-seen and handshake timestamps, agent version | routing and `finch status` / `finch fleet` |

The ordinary call record does not contain the MCP method, prompt/message text,
JSON-RPC parameters, tool arguments, tool results, or response body. Client IP
may be used transiently for edge rate limiting; finch's ordinary call record
does not store it. HTTP headers are forwarded as required by the relay but are
not part of the retained recent-call record.

finch also retains control-plane data that is not message content:

- account identifiers and the account owner's Clerk user id and email (an
  account is one Clerk user; there are no other members);
- service, machine, group label, tag, hostname, and settings metadata;
- key metadata, including the key hash, label, scope, last four characters,
  creation time, and expiry (the plaintext `finch_` key is returned only when
  minted);
- authentication/enrollment state needed to operate and revoke machine and
  CLI credentials; and
- bounded administrative, device, and key audit events.

This list is the allowed application-retention surface. Adding new retained
relay metadata or any body capture requires an explicit documentation update,
privacy review, and automated coverage proving the ordinary payload remains
absent from storage and logs.

### Records from retired features

The team, sharing and device-enrollment features removed in September 2026
wrote records that named other people. The one-time single-user migration
deleted them; nothing from them is retained. What it deleted is recorded in
[`archive/single-user-migration.md`](archive/single-user-migration.md).

## Approved language

Use language such as:

> finch encrypts traffic in transit. Ordinary MCP request and response bodies
> are processed transiently to relay the call and are not logged or persisted
> by finch. Operational metadata is retained.

Do not use:

- "finch never sees what flows through";
- "we can't see your messages";
- "end-to-end encrypted" or "E2EE"; or
- an unqualified "zero knowledge" or "no data retention" claim.

Those statements imply a cryptographic or retention boundary the current
architecture does not provide.
