# Finch privacy and data handling

This document defines the privacy guarantee for Finch's production relay. It
distinguishes transport encryption, application retention, and Dashboard **Test
in chat**, because treating those as one claim would be misleading.

## The short version

- Network traffic is encrypted from the client to Finch with HTTPS/TLS and
  from Finch to the box agent with WSS/TLS.
- Finch is not end-to-end encrypted. Cloudflare terminates those TLS
  connections, and the Finch relay can access request and response plaintext
  while it forwards a call.
- The ordinary MCP relay processes request and response bodies transiently. It
  does not write those bodies to Finch application logs, Durable Object state,
  call history, or metrics.
- Finch retains documented operational and control-plane metadata needed to
  authenticate callers, route calls, show health, enforce access, and operate
  the service.
- Dashboard **Test in chat** is opt-in and separately sends chat and tool data
  to Cloudflare Workers AI. It is not provider-blind and is not covered by the
  ordinary relay's no-body-retention statement.

Accordingly, Finch must not be described as E2EE or as technically unable to
see messages. Accurate language is: **encrypted in transit; ordinary relayed
payloads are processed transiently and are not logged or persisted by Finch.**

## Transport and trust boundary

In production, an ordinary request follows this path:

```text
MCP client -- HTTPS/TLS --> Cloudflare-hosted Finch relay
                                |
                                +-- WSS/TLS --> outbound Finch box agent
                                                       |
                                                       +-- local HTTP(S) --> MCP service
```

HTTPS and WSS protect traffic against passive observers on the network. They do
not make the payload opaque to Cloudflare or to Finch code running there:
Cloudflare terminates both encrypted connections, and the relay reconstructs
the HTTP request and response to forward them. The box agent also necessarily
handles plaintext before calling the local service.

The production web and relay entry points reject plaintext HTTP before
authentication or body handling. The box agent refuses non-loopback HTTP hub
and upstream URLs, non-loopback WS relay URLs, and TLS-to-plaintext redirects.
Plain HTTP/WS is permitted only for literal loopback development addresses.

The agent-to-local-service connection is chosen by the box operator. Loopback
HTTP (for example, `http://127.0.0.1:8000`) does not leave the box. If an
upstream is on another host, the agent requires HTTPS, so the final network hop
cannot be configured as plaintext HTTP.

Cloudflare's underlying platform may process network and security telemetry
under the deployment's Cloudflare configuration and terms. Finch's guarantee
below describes what the Finch application deliberately records; it is not a
claim that Cloudflare is cryptographically unable to inspect traffic.

## Ordinary MCP relay

For a normal call made directly to a Finch service URL, Finch buffers or
streams payload bytes only as needed to forward the request and response. The
ordinary relay does not intentionally:

- persist request or response bodies in Durable Objects or another Finch data
  store;
- include bodies in application logs, exceptions, traces, or metrics; or
- send bodies to an AI model or other payload-processing integration.

The caller's local MCP client and the local MCP service are outside this
application-retention guarantee; either endpoint may keep its own history or
logs. Operators should also avoid adding platform log capture, tracing, or
debug middleware that records raw headers or bodies.

## Data Finch retains

Finch retains the following operational metadata for ordinary relay calls:

| Category | Retained fields or derived values | Purpose |
|---|---|---|
| Recent call | timestamp, route, caller label, HTTP response status, and duration, stored within the tenant/service record | recent activity and diagnosis |
| Aggregate metrics | call count, hourly traffic and latency buckets, rolling p50/p95 latency, error rate | health and dashboard charts |
| Activity log | timestamp, actor/caller label, action, service and route target, result status | tenant audit trail |
| Connection health | service/box identity, connection state, last-seen and handshake timestamps, agent version | routing and fleet status |

The ordinary call record does not contain the MCP method, prompt/message text,
JSON-RPC parameters, tool arguments, tool results, or response body. Client IP
may be used transiently for edge rate limiting; Finch's ordinary call record
does not store it. HTTP headers are forwarded as required by the relay but are
not part of the retained recent-call record.

Finch also retains control-plane data that is not message content:

- tenant/workspace identifiers, user membership, email, role, and invitation
  or access-request state;
- service, route, box, group, tag, hostname, manifest, and settings metadata;
- access-control rules and key metadata, including the key hash, label, scope,
  last four characters, creation time, and expiry (the plaintext `finch_` key
  is returned only when minted);
- authentication/enrollment state needed to operate and revoke box, CLI, and
  browser sessions; and
- bounded administrative, device, access, and key audit events.

This list is the allowed application-retention surface. Adding new retained
relay metadata or any body capture requires an explicit documentation update,
privacy review, and automated coverage proving the ordinary payload remains
absent from storage and logs.

## Dashboard Test in chat

**Test in chat** is an explicit diagnostic feature powered by Cloudflare
Workers AI. When a user sends a chat turn, Finch:

1. reads the recent chat history supplied by the dashboard;
2. calls `tools/list` on the selected service;
3. sends the chat history plus tool names, descriptions, and input schemas to
   the Workers AI model;
4. if the model selects a tool, sends its arguments to the service; and
5. sends the returned tool result back to Workers AI so the model can compose
   the final answer. This loop can repeat for multiple tool calls.

Therefore Cloudflare Workers AI processes chat messages, tool definitions,
tool arguments, and tool results. Users should not place sensitive data in
**Test in chat** unless they accept that processing. This path is separate from
an MCP client calling the service directly, and its disclosure must remain
visible anywhere the feature is offered.

Finch does not add Test in chat payloads to the ordinary Durable Object
recent-call body storage (there is no such body storage). Any processing or
retention performed by Cloudflare Workers AI is governed by the configured
Cloudflare service and terms, not by Finch's ordinary-relay no-retention claim.

## Approved language

Use language such as:

> Finch encrypts traffic in transit. Ordinary MCP request and response bodies
> are processed transiently to relay the call and are not logged or persisted
> by Finch. Operational metadata is retained. Dashboard Test in chat separately
> sends chat and tool data to Cloudflare Workers AI.

Do not use:

- "Finch never sees what flows through";
- "we can't see your messages";
- "end-to-end encrypted" or "E2EE"; or
- an unqualified "zero knowledge" or "no data retention" claim.

Those statements imply a cryptographic or retention boundary the current
architecture does not provide.
