# finch relay protocol v2 — streaming, MCP-unaware (design + plan)

Status: **shipped, with a deliberately simpler design than this spec.** The
goals are LIVE: a streaming, MCP-unaware relay (`head` → `chunk…` → `end` over
per-request ids, with pause/resume `WINDOW` backpressure). Several of this spec's
mechanisms were **superseded by simpler choices** that are sufficient for MCP —
recorded here so the ambition isn't mistaken for a backlog:

- **Multi-server per box → one connection per appliance** (not `OPEN.route`
  multiplexing on a single socket). Each `finch.toml` `[[ingress]]` rule is its
  own appliance with its own outbound WebSocket. Idle appliances hibernate
  independently (~$0), so the extra sockets cost nothing at rest — and the wire
  stays trivially simple. **This is the design, not a gap.**
- **No load balancing / session affinity.** An appliance is served by one box;
  finch is not a load-balancer and won't pin `Mcp-Session-Id` across a multi-box
  pool. (Running >1 box for one appliance is best-effort failover only, no
  session stickiness.) **Out of scope by choice.**
- **Request body is buffered, not streamed.** MCP requests are small JSON-RPC
  POSTs; the *response* is what gets large (SSE, long-running tools), and that
  streams. Buffering a tiny request is correct and cheap — request-body
  streaming buys nothing for MCP.
- **JSON frames with base64 bodies** (not binary msgpack/CBOR). Binary-safe
  today; the ~33% body overhead is a future micro-optimization, not a
  correctness gap.

**Genuinely future (optional, not blocking anything):** a stdio↔Streamable-HTTP
bridge so boxes can host MCP servers that speak stdio instead of HTTP. Until
then, `service` is an HTTP URL.

The wire-format reference below stands; treat the OPEN.route / SessionDO /
binary-frame sections as the original v2 ambition, superseded as noted above.

## Why

The relay today (`worker/src/appliance-do.ts`, `agent/main.go`) is **MCP-aware and
buffered**, and that is the root of every fidelity gap:

- `appliance-do.ts` returns **501** for any request whose `Accept` contains
  `text/event-stream` — which a spec-compliant MCP client sends on *every* POST,
  including `initialize`. So real Streamable-HTTP clients can't even handshake.
- The whole request and response are buffered as one JSON `frame` (`req.text()`
  on the way in, `io.ReadAll` on the box) — so SSE, progress notifications,
  server-initiated sampling/elicitation, and long-running ("thinking") tools
  cannot stream and **deadlock** when the server tries to talk back mid-call.
- A hard **30s** cap (`REQUEST_TIMEOUT_MS`) + 28s on the agent + a 4 MiB body cap
  kill any long or large call. These are self-imposed — Cloudflare puts no
  wall-clock limit on a Worker/DO blocked on I/O.

Fix: **stop parsing MCP.** Make the relay a protocol-agnostic, multiplexed,
raw-HTTP **byte tunnel** (the cloudflared/ngrok shape, via yamux-style framing).
Then unmodified FastMCP + unmodified MCP clients "just work" because nothing in
the middle understands MCP — it moves bytes of an HTTP stream, full-duplex.

## Model

One WebSocket per box (unchanged: the agent dials OUT to
`/<appliance>/<machine>/_connect`, the `ApplianceDO` accepts it; hibernation and
the connect-token gate are preserved). Over that one socket we multiplex many
independent, full-duplex **logical streams** (`sid`), one per in-flight HTTP
request. Each stream carries a **raw HTTP request/response** — headers as opaque
pairs, body as opaque bytes. Server-initiated traffic (a sampling request the
box's server sends back mid-call) is just another stream interleaved on the same
socket, so bidirectionality is free.

```
client → Worker → ApplianceDO ── OPEN(sid,route,method,path,headers) ──▶ finchd
                              ── DATA(sid, up, bytes)… END(sid, up) ────▶
         (returns Response    ◀── HEAD(sid, status, headers) ───────────  (emitted
          the instant HEAD    ◀── DATA(sid, down, bytes)… ───────────────  the INSTANT
          arrives; streams)   ◀── END(sid, down) ─────────────────────────  the app
                              ◀── (or) OPEN(sid', …) a server→client req     produces it)
```

## Frame format

Binary, length-prefixed (NOT JSON strings — that's what makes today's bodies
UTF-8-lossy and 4 MiB-capped). One WS message carries one frame. Wire encoding:

```
struct frame {
  u8   type;        // 1=OPEN 2=HEAD 3=DATA 4=END 5=RESET 6=WINDOW
  u32  sid;         // stream id (odd = client-initiated, even = server-initiated)
  u8   flags;       // type-specific (e.g. DATA dir: 0=up/req-side, 1=down/res-side)
  u32  len;         // length of payload
  u8[] payload;     // type-specific (see below)
}
```

| Frame  | Direction        | Payload | Meaning |
|--------|------------------|---------|---------|
| OPEN   | hub→box, box→hub | `{route, method, path, headers:[[k,v]…]}` (msgpack/CBOR) | a request begins on `sid`. `route` selects the local server (multi-server-per-box). `headers` is a **list of pairs** (preserves duplicates — today's map collapses them). |
| HEAD   | box→hub, hub→box | `{status, headers:[[k,v]…]}` | response status+headers, emitted **before** the body — this is what unblocks SSE. The peer returns `new Response(stream, {status, headers})` immediately. |
| DATA   | either           | raw bytes | a body chunk for `sid` in the `flags` direction. Binary-safe. A large body rides as many sub-32-MiB DATA frames. |
| END    | either           | — | half-close one direction of `sid` (EOF on that body). |
| RESET  | either           | `{code}` | abort `sid` (client disconnect → propagate `http.disconnect`; app error). |
| WINDOW | either           | `{credits}` | grant N more bytes of send-credit for `sid` (flow control — see below). |

`sid` lifecycle: allocate on OPEN → DATA*/HEAD/DATA* → END each direction →
freed. Client-initiated `sid` are odd, server-initiated (sampling/elicitation)
are even, so the two sides never collide. PING/PONG stay WS-protocol control
frames via `setWebSocketAutoResponse` (free, no DO wake) — keep as today.

## Flow control (mandatory, not optional)

32 MiB is a per-**message** cap, not a window. Without per-stream credits, one
slow public reader head-of-line-blocks the socket or OOMs the shared DO heap
across all `sid`. So: each `sid` has a bounded send window; the receiver grants
`WINDOW(credits)` as it drains DATA to the public client; the sender pauses that
stream's body when credits hit zero. This is the one piece today's coarse
one-frame design can't get wrong because it never streams — and the one the v2
design must get right or the deadlock just moves from "SSE buffering" to "window
starvation."

## Timeouts — idle, not total

Delete `REQUEST_TIMEOUT_MS` (30s) and the agent's 28s `context.WithTimeout`. Gate
each `sid` on an **idle** timeout (≥300s, reset on any DATA/HEAD frame). A tool
that emits a progress event every ~15s stays alive indefinitely; a genuinely
silent stream is reaped. Cloudflare allows this — an actively-streaming Worker
response has no duration limit.

## Session affinity

The relay does **not** parse MCP bodies, but it may read the `Mcp-Session-Id`
**response header** off a `HEAD` frame (a header is just a header). On first
sight, write `sessionId → machine` to a per-session sharded `SessionDO`
(`idFromName(sessionId)`); route subsequent requests carrying that
`Mcp-Session-Id` to the pinned machine; tear the mapping down on `DELETE /mcp`.
Single-machine appliances (the common IoT case) need none of this — they pin
trivially. (Do **not** use cookie affinity — MCP clients drop `Set-Cookie`.)

## What changes in the existing code

- `appliance-do.ts`: delete the 501 SSE reject, `req.text()` buffering, the
  single `Promise<Frame>`, and `REQUEST_TIMEOUT_MS`. The `pending: Map<id,fn>`
  becomes `streams: Map<sid,{controller, creditsUp, creditsDown}>`. Return
  `new Response(readableStream, {status, headers})` fed from `HEAD`+`DATA(down)`.
- `index.ts`: drop the `MAX_RELAY_BODY_BYTES` whole-body cap and the
  `req.arrayBuffer()` buffer in `relayMcp`; stream `req.body` into `DATA(up)`.
  Keep the finch_ auth + key-strip exactly as-is (that's the trust boundary).
- `agent/main.go`: replace the `frame{…Body string}` model + `io.ReadAll`
  (`forward()`) with a yamux session + `httputil.ReverseProxy` (streams natively,
  no buffering). `--upstream` becomes a `route → upstream` table (multi-server).
  Keep the `resolveUpstream` SSRF guard — generalized per-route.

## Golden test vectors (Phase-0 deliverable)

A versioned fixture file the TS and Go codecs both round-trip, so the two
implementations can't drift (a framing bug is a class today's one-JSON-frame
design simply cannot have). At minimum:

1. OPEN with duplicate headers (`set-cookie` ×2) → both survive the round-trip.
2. A 100 MB body as a run of 32-MiB-bounded DATA frames → reassembles byte-exact.
3. A binary (non-UTF-8) body → byte-exact (today's string body corrupts it).
4. HEAD-before-body: HEAD arrives, then 3 DATA(down), then END → the consumer
   sees status+headers before any body byte.
5. Interleaved `sid`: two concurrent streams' frames interleaved → demuxed
   correctly, no cross-talk.
6. WINDOW starvation: sender blocks at 0 credits, resumes on WINDOW → no deadlock.
7. RESET mid-stream → the consumer's ReadableStream errors promptly (no 30s hang).

## Phased implementation plan

0. **Spec + golden vectors** (this doc + the fixtures). The contract. Fuzz it.
1. **Codec library** — pure, networkless, in BOTH `worker/` (TS) and `agent/`
   (Go). Unit + cross-impl fuzz. No behavior change shipped.
2. **ApplianceDO → dumb pump** behind a feature flag: `streams` map +
   `new Response(readableStream)`; delete the 501/buffer/30s cap; add per-stream
   idle timeout + a DO alarm heartbeat (keeps the object resident while a stream
   is open; `RESET` every in-flight client on eviction). Old frame agents still
   work during rollout.
3. **finchd mux client** — yamux + `httputil.ReverseProxy`, single `--upstream`,
   WINDOW backpressure, no `io.ReadAll`. Ship as the streaming replacement.
4. **stdio bridge** — `route` type that spawns a stdio MCP server and bridges
   stdio↔Streamable-HTTP. Unlocks the stdio IoT wedge. Integration-test against a
   real stdio server.
5. **multi-server** — `OPEN.route` selects among N local servers on one socket;
   wire per-server health into the dashboard.
6. **session affinity** — `SessionDO` keyed by `Mcp-Session-Id`; replace the
   per-request machine shuffle for sessioned requests.
7. **cut over** — finchd default across releases; delete the legacy frame path.

## Honest risks

- Cross-impl codec drift (TS vs Go) — mitigated by the golden vectors + fuzz.
- In-flight streams **PIN and BILL** the ApplianceDO (not hibernatable while a
  request is in flight); a long idle `GET /mcp` needs the alarm heartbeat +
  airtight `RESET`-on-eviction, and a per-tenant concurrent-stream cap ships
  with this change (that's when the cost first exists).
- DO input-gate concurrency: `webSocketMessage` interleaving with the awaiting
  fetch handler feeding the stream controller is the real race surface — written
  defensively, and in-flight stream state can't rely on `serializeAttachment`
  (per-socket) surviving eviction.
- The stdio↔Streamable-HTTP bridge is the hardest fidelity surface and serves the
  headline wedge — resource it properly.
