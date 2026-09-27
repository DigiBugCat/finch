# Finch privacy and data handling

This document defines the privacy guarantee for Finch's production relay. It
distinguishes transport encryption from application retention, because treating
those as one claim would be misleading.

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
- Finch sends no relay data to an AI model. (The dashboard's former **Test in
  chat**, which sent chat and tool data to Cloudflare Workers AI, has been
  removed along with the hub's Workers AI binding.)

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
authentication or body handling. The box agent refuses non-loopback HTTP **hub**
URLs, non-loopback WS relay URLs, and TLS-to-plaintext redirects.

The agent-to-local-service connection is different, and is chosen by the box
operator. Loopback HTTP (for example, `http://127.0.0.1:8000`) does not leave
the box. But the agent also accepts a plaintext `http://` upstream whose host is
a **single DNS label** (for example `http://nas:8000` or a Docker Compose
service name like `http://hello-mcp:8000`), because container networks address
services that way. Such names are not necessarily on-box: they routinely resolve
elsewhere via `/etc/hosts`, a DNS search domain, or LLMNR. When one does, that
final hop is relayed **in the clear across your network**, carrying request and
response bodies and the hub-signed `X-Finch-Assertion` caller-identity header.

Only dotted names (`http://host.example`) and non-loopback IP literals are
refused over plaintext. So Finch does **not** guarantee the final hop is
encrypted — that is the operator's configuration decision. Use `https://` for
any upstream that is not genuinely on the box.

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

- tenant identifiers and the tenant owner's Clerk user id and email (a tenant
  is one Clerk user; there are no other members);
- service, box, group label, tag, hostname, and settings metadata;
- key metadata, including the key hash, label, scope, last four characters,
  creation time, and expiry (the plaintext `finch_` key is returned only when
  minted);
- authentication/enrollment state needed to operate and revoke box and CLI
  credentials; and
- bounded administrative, device, and key audit events.

This list is the allowed application-retention surface. Adding new retained
relay metadata or any body capture requires an explicit documentation update,
privacy review, and automated coverage proving the ordinary payload remains
absent from storage and logs.

### Legacy sharing records are deleted on migration

Finch's retired team, sharing and device-enrollment features wrote records
that named other people. The single-user migration deletes them:

- Each tenant's stored state is purged once, on the first request the hub
  serves for it after the migration deploys (`TenantDO.purgeLegacyTenancy`,
  recorded by a versioned `singleUserPurge` flag): member rows other than the
  owner, invitations, groups, access-control rules, access requests, the
  retired login wall's session epoch, the Aviary manifest, route and
  credential-epoch fields, the `access` audit-log rows, and any other audit
  row that names a member other than the owner. If anyone besides the owner
  could have signed in to the tenant, every access key, every box and every
  CLI login is revoked, because none of them records which person created
  it; the owner re-adds their own. Otherwise only keys labelled for someone
  else are revoked. A team tenant's hostnames move to its one former owner
  when it had exactly one. A tenant that no request touches keeps its legacy
  rows until one does; after the migration there is no index that lists
  such tenants.
- The global sign-in index (`DirectoryDO`) and the retired device-enrollment
  records (`AviaryEnrollmentDO`) are deleted outright by Durable Object
  migration `v7` when it deploys.

Nothing from these records is retained afterwards.

## Approved language

Use language such as:

> Finch encrypts traffic in transit. Ordinary MCP request and response bodies
> are processed transiently to relay the call and are not logged or persisted
> by Finch. Operational metadata is retained.

Do not use:

- "Finch never sees what flows through";
- "we can't see your messages";
- "end-to-end encrypted" or "E2EE"; or
- an unqualified "zero knowledge" or "no data retention" claim.

Those statements imply a cryptographic or retention boundary the current
architecture does not provide.
