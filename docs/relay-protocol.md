# Relay protocol

Status: **current.** The wire format between the hub and the `finch` agent on
your machine. The TypeScript side is `worker/src/relay-frames.ts` and
`worker/src/box-do.ts`; the Go side is `agent/core/relay_loop.go` and
`agent/core/agent.go`. The original, more ambitious v2 plan (binary frames,
multiplexing several local servers on one socket, session affinity) is kept in
[`archive/relay-protocol-v2-plan.md`](archive/relay-protocol-v2-plan.md); it
was not built as written.

## Shape

The relay is an HTTP tunnel that does not parse MCP. It moves an HTTP request
from a public caller to your local server and streams the response back, so
unmodified Streamable-HTTP servers (FastMCP, the MCP SDKs) work, including SSE,
progress notifications and long-running tools.

```text
caller ── HTTPS ──▶ hub Worker ──▶ BoxDO ══ WSS ══ finch agent ── HTTP(S) ──▶ local server
                   auth, strip           one socket per
                   credentials           service per machine
```

- **One WebSocket per service per machine.** Each rule in `finch.yml` is its
  own connection, dialed out by the agent to
  `wss://<host>/<service>/<machine>/_connect?ct=<connect token>`. Idle sockets
  hibernate, so extra services cost nothing at rest.
- **Many requests per socket.** Each relayed request has its own string `id`;
  frames for different ids interleave.
- **Request bodies are buffered** (up to 4 MiB); **response bodies stream.**
- **No session affinity.** A service served by several machines gets
  best-effort failover, not `Mcp-Session-Id` stickiness.

## Frames

One WebSocket text message is one frame: a UTF-8 JSON object with `id` and
`type`. Body bytes travel as standard, padded base64.

| Frame | Direction | Fields | Meaning |
|---|---|---|---|
| `req` | hub → agent | `method`, `path`, `headers` (name → value), `body` (string), optional `assertion` | A request begins. `path` is relative to the service and may include a query. `assertion` is the hub-minted caller JWS, delivered on its own field. |
| `head` | agent → hub | `status`, `headers` (ordered `[name, value]` pairs, lowercase, duplicates kept) | Sent as soon as the local server's status and headers are known, before any body. |
| `chunk` | agent → hub | `data` (base64) | A slice of the response body. |
| `end` | agent → hub | | The response body is complete. |
| `err` | agent → hub | `status`, `message` | The request failed before `head` (for example the local server is down, or the path was refused). |
| `reset` | either | optional `message` | Abort one in-flight request (caller disconnected, stream error). |
| `window` | hub → agent | `credits` | Flow control for one `id`: `0` pauses `chunk` frames, a positive value resumes them. |

Per id, the agent sends `head`, then zero or more `chunk`, then `end`, in that
order, or a single `err` instead of `head`. Keepalive uses WebSocket
ping/pong, which does not wake a hibernated Durable Object.

The golden vectors in `worker/test/relay-vectors.json` are round-tripped by
both codecs (`worker/test/relay-codec.test.ts`,
`agent/core/relay_vectors_test.go`). Change a shape there first.

## Flow control, timeouts and limits

| Limit | Value | Where |
|---|---|---|
| Request body | 4 MiB (413 above it) | Worker and `BoxDO` |
| Request bodies being read at once, per socket | 8 MiB reserved | `BoxDO` |
| Concurrent requests per socket | 32 | `BoxDO` |
| Response buffer high-water mark | 1 MiB per request; above it the hub sends `window {credits:0}` | `BoxDO` |
| Hard response buffer caps, for an agent that ignores the pause | 8 MiB unread per request, 32 MiB per socket (the request is reset) | `BoxDO` |
| Time to `head` | 120 seconds | `BoxDO` |
| Idle time between frames after `head` | 300 seconds | `BoxDO` |
| Response headers | 64 KiB | `BoxDO` |

There is no total duration cap: a tool that keeps sending progress events stays
alive.

## Routing

- `/<service>/…` picks a healthy machine for the service. If the pick answers
  with the Durable Object's `X-Finch-Offline` 503, the hub tries the next one.
- `/<service>/<machine>/…` pins a machine when the second segment names a
  registered machine of that service.
- `/<service>/<machine>/_connect` is reserved for the agent's socket.

The agent only forwards paths under the service's base path: the path in the
`service` URL when it has one (`http://127.0.0.1:8000/mcp` → `/mcp`), otherwise
`/mcp`. With `forward_all: true` in `finch.yml` it forwards everything under
`/<service>/`. It collapses `.` and `..` before checking, refuses scheme or host
injection, and takes scheme and host only from its configuration.

## Headers

Request headers pass through unchanged, except:

- **By name:** `Authorization`, `Proxy-Authorization` and every `X-Finch-*`
  header are removed (the hub adds `X-Finch-Assertion` afterwards).
- **By value, for the presented credential only:** when the request carried
  `Authorization: Bearer <token>` (16 characters or more), any remaining
  header whose value contains that exact token is removed too, so a client
  that copies its key into another header (`X-Api-Key`, a custom auth header)
  does not leak it to your server. Nothing else is matched by value: MCP
  headers such as `Mcp-Name: finch_search` and `Mcp-Param-*`, which mirror
  the JSON-RPC body, reach your server as sent, and so does any `finch_`
  text that is not the token on this request.
- **Hop-by-hop** headers are dropped in both directions.

`Cookie` is forwarded byte for byte, including the retired
`__Host-finch_session` / `finch_session` cookies from the removed browser
login wall (the hub no longer reads them; they expired within 12 hours of its
removal). A `Set-Cookie` from your server loses any `Domain` attribute, so it
stays on its own host.

## The hub's own MCP client

`POST /api/cli/call` (behind `finch test` and `finch call`) runs a complete MCP
exchange (initialize, the call, then `DELETE`) against one machine's pinned
`/<service>/<machine>/mcp` path, moving to the next healthy machine only while
the pick answers with the offline 503. Its code is `worker/src/cli-call.ts`.

## Privacy

HTTPS and WSS protect each hop, but finch is not end-to-end encrypted: the relay
handles plaintext while forwarding. Bodies are never written to logs, Durable
Object storage, call records or metrics. See [`privacy.md`](privacy.md).
