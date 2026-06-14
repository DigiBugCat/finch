# finch 🐦

**Opinionated, batteries-included hosting for MCP appliances.**

There are many finches. This one is yours.

Finch turns any always-on box — a Mac mini, a Raspberry Pi, an old laptop —
into a publicly reachable, authenticated MCP server, without opening a single
port. You write the tool logic; finch handles **auth, routing, and hosting**.

```
MCP client ──HTTPS──▶  finchmcp.com/<id>/mcp   (Cloudflare Worker: auth + routing)
                          │
                          ▼
                       Durable Object  (one per appliance — hibernates when idle)
                          ▲ outbound WebSocket (the box dialed out)
                  ────────┘
                  finch agent on the box ──▶ your local MCP server
```

## Why

Every layer of "host an MCP server behind auth" is a commodity (ngrok,
cloudflared, Cloudflare Workers). What's missing is an **opinionated,
batteries-included** way to ship one: write the tool in a folder, run it, and
it's authed, public, identity-aware, and supervised — for free. Rails/Vercel
for MCP appliances. See [`docs/design.md`](docs/design.md).

## Layout

| Path | What |
|---|---|
| `worker/` | The finch hub — a Cloudflare Worker + a Durable Object per appliance. Auth + routing + the hibernatable WebSocket relay. |
| `agent/` | The box-side agent (Go). Dials out to the hub, proxies to your local MCP server. Cross-compiles to mac/linux/arm. |
| `docs/` | Design + architecture. |

## Status

Early. Working today: the **request/response relay** end-to-end (Worker DO ↔
agent ↔ local server), with hibernation done correctly. Not yet built: Clerk
auth + `finch_` keys at the edge, the appliance registry, server-initiated
(bidirectional) MCP push, the bundle/manifest runtime, and the dashboard.

## Quickstart (local dev)

```bash
# 1. run the hub locally
cd worker && npm install && npm run dev      # wrangler dev on :8787

# 2. run a local MCP server on :8000 (any streamable-http MCP server)

# 3. connect an appliance
cd agent && go run . --hub ws://localhost:8787 --id demo --upstream http://127.0.0.1:8000

# 4. hit it through the hub
curl -X POST http://localhost:8787/demo/mcp -d '{"jsonrpc":"2.0",...}'
```

## License

TBD.
