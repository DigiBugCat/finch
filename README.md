# finch 🐦

**Opinionated, batteries-included hosting for MCP services.**

User-facing terms map to the protocol names this repo still uses on the wire:
**service** = `appliance`, and **box** = `machine`.

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
        ▲                │  (per tenant + box)     │              │  local MCP    │
        └────────────────┤  streaming relay        ├──────────────┤  server :8000 │
          streamed SSE / │                         │  head→chunk… │ (FastMCP, …)  │
          long-running   └─────────────────────────┘              └──────────────┘
```

## Why

Every layer of "host an MCP server behind auth" is a commodity (ngrok,
cloudflared, Cloudflare Workers). What's missing is an **opinionated,
batteries-included** way to ship one: write the tool, run it, and it's authed,
public, identity-aware, and supervised — for free. Rails/Vercel for MCP
services, aimed squarely at the things you **can't** just deploy to the cloud:
on-prem data, local stdio tools, and physical/IoT hardware. See
[`docs/design.md`](docs/design.md).

## Architecture

The hub is a thin Cloudflare Worker in front of three Durable Objects:

| Object | Role |
|---|---|
| **RouterDO** | global `slug → tenant` index — resolves `<slug>.finchmcp.com` |
| **TenantDO** | per-tenant control plane: `finch_` keys, ACL, metrics, dashboard state |
| **ApplianceDO** | per-box hibernatable **streaming relay** — the box parks its outbound WebSocket here |

**Auth has two layers, kept distinct:**

- **Box ↔ hub** — the agent enrolls once with a one-shot ticket, then holds a
  long-lived per-box **refresh token** (persisted at `--state`, `0600`) and
  trades it for short-lived `connect-token`s. It survives restarts and reboots
  with no new ticket ("authenticate once", like ngrok's authtoken).
- **Client ↔ MCP server** — callers present a `finch_` bearer key; the hub hashes
  + checks it (scope + default-deny ACL), **strips it**, and relays the request.

**A request, end to end (streaming):**

```
client ─POST /<app>/mcp (Bearer finch_…)─▶ Worker
   Worker: rate-limit → checkKey (scope + ACL) → strip key → pick box
      └─▶ ApplianceDO ──req──▶ agent ──HTTP──▶ local MCP server
                       ◀─head──         (status+headers the instant they're known)
                       ◀─chunk─ chunk ─ …      (body streams as base64 frames)
                       ◀─end───                (idle-timeout, not a 30s total cap)
   Worker streams the Response straight back to the client.
```

The relay is **MCP-unaware** — it moves raw HTTP bytes, so unmodified
[FastMCP](https://gofastmcp.com) (or any Streamable-HTTP MCP server) just works:
SSE, progress notifications, long-running "thinking" tools, and — on a
single-box service — server-initiated sampling/elicitation. Pause/resume
**WINDOW** backpressure keeps a fast box from overrunning a slow client.

## Layout

| Path | What |
|---|---|
| `worker/` | The finch hub — Cloudflare Worker + 3 Durable Objects (TS). Auth, routing, the streaming relay. |
| `agent/` | The box-side agent (Go). Dials out, streams to your local MCP server. Cross-compiles to mac/linux × amd64/arm64. |
| `web/` | The dashboard (Next.js + Clerk, deployed to Cloudflare via OpenNext). Add boxes, mint keys, see your fleet. |
| `docs/` | Design + the relay protocol spec. |

## Status

**v1 core is real and tested.** Working today:

- ✅ Outbound-dial relay, no open ports, zero per-box DNS (ngrok model)
- ✅ Two-layer auth (`finch_` keys + ticket/refresh/connect tokens), SSRF-guarded agent
- ✅ **Streaming** relay — SSE / progress / long-running tools, with backpressure
- ✅ Reconnect forever, including across reboots (persisted refresh credential)
- ✅ **CLI: `finch login` (browser approval) → `finch add` → `finch run`** — enroll
  and serve from the box, no dashboard ticket copying
- ✅ **`finch.yml` manifest** — one process fronts many local services, each its own
  service (cloudflared-style ingress); found in the cwd or `~/.finch/finch.yml`
- ✅ **Remote update** — an outdated box shows an ⬆ badge; click **update now** in the
  dashboard (or run `finch update` on the box) and the agent swaps its binary
  atomically and restarts in place — no SSH, no second process. Binaries are
  served from R2 at `$HUB/releases/<asset>`
- ✅ Dashboard: fleet, keys (default-deny ACL), settings (hub-domain slug picker +
  CLI access tokens), and a **"test in chat"** panel that drives a service's MCP
  tools through an LLM (Cloudflare Workers AI)
- ✅ One-tag release pipeline (GoReleaser) + a `curl | sh` installer
- ✅ Full-stack e2e + CI gates on all three packages (`go test -race`, vitest, typecheck/lint)

**Roadmap (v1.1+):** a stdio↔Streamable-HTTP bridge (host non-HTTP servers) and
multi-box session affinity. Authenticated caller identity already travels as a
signed `X-Finch-Assertion` for assertion-aware services; see
[`worker/CALLER_ASSERTIONS.md`](worker/CALLER_ASSERTIONS.md).

## Use it

For a new Python service, the private Aviary pilot can use
[AviaryMCP](https://finchmcp.com/docs/aviarymcp): define a tool once, expose it
through MCP and generated REST/OpenAPI routes, and let the application register
itself with Finch. Existing services and other languages use the CLI flow below.

Three commands on the box, from a logged-in CLI (see
[`agent/README.md`](agent/README.md) for the full reference):

```bash
# 1. log in — opens the dashboard to approve a short code (like `gh auth login`)
finch login --hub https://finchmcp.com

# 2. expose a local MCP server (running on :8000) as the service "printer"
finch add printer --service http://127.0.0.1:8000 --name "Label Printer"

# 3. serve it — dials out, auto-approves, prints the public URL
finch run            #  → https://<your-slug>.finchmcp.com/printer/mcp
```

`finch add` writes a [`finch.yml`](agent/finch.example.yml) manifest; `finch
run` serves every rule in it (add more services with more `finch add` calls —
one process fronts them all). Then point any MCP client at the printed URL with
a `finch_` key (mint one in the dashboard → **Keys**), or test it right in the
dashboard with the service's **"test in chat"** panel.

A runnable end-to-end example lives in
[`examples/hello-mcp/`](examples/hello-mcp/).

> No CLI yet? You can also enroll a single box from the dashboard ("Add box")
> and run `finch join --ticket … --upstream …` — see the agent README.

## Local dev

Run three things: the **hub** (worker), the **dashboard** (web), and the
**agent** on the box.

```bash
# 0. shared secrets — copy the examples and set a matching FINCH_SERVICE_SECRET
#    and TICKET_SECRET in BOTH files (the dashboard signs what the hub verifies).
cp worker/.dev.vars.example worker/.dev.vars
cp web/.dev.vars.example    web/.dev.vars   # also needs Clerk pk_test_/sk_test_

# 1. run the hub
cd worker && npm install && npm run dev          # wrangler dev on :8787

# 2. run the dashboard (Node 22 — see web/.nvmrc; needs a Clerk dev instance)
cd web && npm install && npm run dev             # next dev on :3000

# 3. run a local MCP server on :8000 (any streamable-http MCP server, e.g.
#    a FastMCP server, or examples/hello-mcp/server.py)

# 4. enroll + serve, then call it
cd agent && go build -o finch . && \
  ./finch login --hub http://localhost:8787 && \
  ./finch add hello --service http://127.0.0.1:8000 && ./finch run
```

## Tests

```bash
cd worker && npm test          # vitest-pool-workers: relay, auth, full-stack e2e
cd agent  && go test -race ./...
cd web    && npm run typecheck && npm test
```

## License

TBD.
