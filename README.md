# finch 🐦

**Opinionated, batteries-included hosting for MCP appliances.**

There are many finches. This one is yours.

Finch turns any always-on box — a Mac mini, a Raspberry Pi, an old laptop —
into a publicly reachable, authenticated, **streaming** MCP server, without
opening a single port. The box dials *out*; finch handles **auth, routing, and
hosting**. It feels like ngrok: you get a stable `https://<slug>.finchmcp.com`
URL with no DNS to configure — finch owns the wildcard, and a subdomain is just
a row in a database, not a DNS record.

```
   MCP client                 finch hub (Cloudflare)                 your box
  ┌──────────┐   HTTPS   ┌─────────────────────────┐   outbound   ┌──────────────┐
  │ Claude / │ ────────▶ │  Worker: auth + routing │   WebSocket  │ finch agent  │
  │ Cursor / │  Bearer   │         │               │ ◀─────────── │ (dialed out) │
  │  …        │ finch_…  │         ▼               │   (no open   │      │        │
  └──────────┘           │  Durable Objects        │    ports)    │      ▼        │
        ▲                │  (per tenant + machine) │              │  local MCP    │
        └────────────────┤  streaming relay        ├──────────────┤  server :8000 │
          streamed SSE / │                         │  head→chunk… │ (FastMCP, …)  │
          long-running   └─────────────────────────┘              └──────────────┘
```

## Why

Every layer of "host an MCP server behind auth" is a commodity (ngrok,
cloudflared, Cloudflare Workers). What's missing is an **opinionated,
batteries-included** way to ship one: write the tool, run it, and it's authed,
public, identity-aware, and supervised — for free. Rails/Vercel for MCP
appliances, aimed squarely at the things you **can't** just deploy to the cloud:
on-prem data, local stdio tools, and physical/IoT devices. See
[`docs/design.md`](docs/design.md).

## Architecture

The hub is a thin Cloudflare Worker in front of three Durable Objects:

| Object | Role |
|---|---|
| **RouterDO** | global `slug → tenant` index — resolves `<slug>.finchmcp.com` |
| **TenantDO** | per-tenant control plane: `finch_` keys, ACL, metrics, dashboard state |
| **ApplianceDO** | per-machine hibernatable **streaming relay** — the box parks its outbound WebSocket here |

**Auth has two layers, kept distinct:**

- **Box ↔ hub** — the agent enrolls once with a one-shot ticket, then holds a
  long-lived per-machine **refresh token** (persisted at `--state`, `0600`) and
  trades it for short-lived `connect-token`s. It survives restarts and reboots
  with no new ticket ("authenticate once", like ngrok's authtoken).
- **Client ↔ MCP server** — callers present a `finch_` bearer key; the hub hashes
  + checks it (scope + default-deny ACL), **strips it**, and relays the request.

**A request, end to end (streaming):**

```
client ─POST /<app>/mcp (Bearer finch_…)─▶ Worker
   Worker: rate-limit → checkKey (scope + ACL) → strip key → pick machine
      └─▶ ApplianceDO ──req──▶ agent ──HTTP──▶ local MCP server
                       ◀─head──         (status+headers the instant they're known)
                       ◀─chunk─ chunk ─ …      (body streams as base64 frames)
                       ◀─end───                (idle-timeout, not a 30s total cap)
   Worker streams the Response straight back to the client.
```

The relay is **MCP-unaware** — it moves raw HTTP bytes, so unmodified
[FastMCP](https://gofastmcp.com) (or any Streamable-HTTP MCP server) just works:
SSE, progress notifications, long-running "thinking" tools, and — on a
single-machine appliance — server-initiated sampling/elicitation. Pause/resume
**WINDOW** backpressure keeps a fast box from overrunning a slow client.

## Layout

| Path | What |
|---|---|
| `worker/` | The finch hub — Cloudflare Worker + 3 Durable Objects (TS). Auth, routing, the streaming relay. |
| `agent/` | The box-side agent (Go). Dials out, streams to your local MCP server. Cross-compiles to mac/linux × amd64/arm64. |
| `web/` | The dashboard (Next.js + Clerk, deployed to Cloudflare via OpenNext). Enroll devices, mint keys, see your fleet. |
| `docs/` | Design + the relay protocol spec. |

## Status

**v1 core is real and tested.** Working today:

- ✅ Outbound-dial relay, no open ports, zero per-box DNS (ngrok model)
- ✅ Two-layer auth (`finch_` keys + ticket/refresh/connect tokens), SSRF-guarded agent
- ✅ **Streaming** relay — SSE / progress / long-running tools, with backpressure
- ✅ Reconnect forever, including across reboots (persisted refresh credential)
- ✅ Dashboard: enroll → mint a key that actually reaches your appliances
- ✅ One-tag release pipeline (GoReleaser) + a `curl | sh` installer
- ✅ Full-stack e2e + CI gates on all three packages (`go test -race`, vitest, typecheck/lint)

**Roadmap (v1.1+):** the `finchd` runtime (`finch.toml` + multi-server-per-box +
a stdio↔Streamable-HTTP bridge — the "drop a folder, it's hosted" piece), edge
identity injection (`X-Finch-User`), and multi-machine session affinity.

## Quickstart (local dev)

You run three things: the **hub** (worker), the **dashboard** (web, mints
tickets/keys), and the **agent** on the box. The agent joins with a one-shot
ticket from the dashboard — there is no DNS or port setup.

```bash
# 0. shared secrets — copy the examples and set a matching FINCH_SERVICE_SECRET
#    and TICKET_SECRET in BOTH files (the dashboard signs what the hub verifies).
cp worker/.dev.vars.example worker/.dev.vars
cp web/.dev.vars.example    web/.dev.vars   # also needs Clerk pk_test_/sk_test_

# 1. run the hub
cd worker && npm install && npm run dev          # wrangler dev on :8787

# 2. run the dashboard (needs a Clerk dev instance)
cd web && npm install && npm run dev             # next dev on :3000

# 3. run a local MCP server on :8000 (any streamable-http MCP server, e.g.
#    a FastMCP server started with transport="http")

# 4. in the dashboard: sign in → Add device → copy the printed one-liner, e.g.
cd agent && go run . join --hub http://localhost:8787 \
  --ticket <ticket-from-dashboard> --upstream http://127.0.0.1:8000

# 5. mint a finch_ key in the dashboard, then call the appliance through the hub
curl -X POST http://localhost:8787/<appliance>/mcp \
  -H "Authorization: Bearer finch_…" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

> A frictionless `finch quickstart` (ngrok-style: one command, instant URL) is
> on the roadmap; today the dashboard is the source of tickets and keys.

## Tests

```bash
cd worker && npm test          # vitest-pool-workers: relay, auth, full-stack e2e
cd agent  && go test -race ./...
cd web    && npm run typecheck && npm test
```

## License

TBD.
