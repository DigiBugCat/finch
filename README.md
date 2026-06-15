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

Early, but the spine is real. **Working today:** the Clerk-authed control plane
(dashboard → enroll a device → mint `finch_` keys), the per-machine outbound
WebSocket relay with hibernation, and `finch_`-key-gated MCP routing end-to-end
(`<slug>.finchmcp.com/mcp` → your box). **In progress:** a streaming transport
(SSE / server-initiated MCP / long-running "thinking" tools — today the relay
buffers a single response and is best for unary JSON-RPC), the bundle/manifest
runtime, and a one-command install. See [`docs/`](docs/) for the design.

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

## License

TBD.
