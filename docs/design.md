# finch — design

> Spun out of the `cassandra-tits` appliance kit (2026-06-13). Finch is the
> standalone, self-ownable productization: an opinionated, batteries-included
> way to host MCP appliances on infrastructure you own.

## Thesis

The components of "host an MCP server on a box you own, behind auth" are all
commodities. The **opinions** are the product. Nobody has made an opinionated,
batteries-included way to ship an MCP capability — write the tool logic in a
folder, run it, and it's authed, public, identity-aware, supervised, and
discoverable for free. "Rails/Vercel for MCP appliances."

This is not a new category — it's porting a proven category (sovereign app
bundles + an auth proxy: Sandstorm, YunoHost, Nabu Casa, Balena) to the
MCP/agent era. The only genuinely-2026 part is the MCP/agent-consumption
surface.

## Prior art (checked) + adopt-vs-build

| Layer | Closest prior art | Verdict |
|---|---|---|
| Transport (outbound agent + DO/WS + hibernation) | Wormhole, WorksLocal, cloudflared, ngrok | Commodity. Our relay is small and ours, but the idea is borrowed, not invented. |
| MCP-over-tunnel (vendor) | OpenAI Secure MCP Tunnels, Anthropic MCP Tunnels | Don't adopt: vendor-locked (consumable only by that one model) **and still make you do your own MCP auth.** |
| Auth + appliance bundles | Sandstorm (grains behind an auth proxy), YunoHost (manifest declares SSO), Nabu Casa (open appliance + paid cloud), Balena | Steal the patterns — proven and mature. |
| **MCP-native + agent-auth + vendor-neutral hub + appliance fleet** | — | **The open slice. This is finch.** |

Lineage note: Sandstorm's "auth proxy in front of capability bundles" was built
by Kenton Varda, who then built Cloudflare Workers + Durable Objects. The modern
expression of grains-behind-a-proxy *is* DO-behind-a-Worker — which is exactly
what finch is.

## Architecture

```
MCP client ──HTTPS (streamable-http)──▶ Worker (finchmcp.com/<id>/mcp)
                                          │ Clerk auth + finch_ key + ACL
                                          │ inject X-Finch-User; route by <id>
                                          ▼
                                        Durable Object (one per appliance)
                                          ▲ hibernatable outbound WS
                                   ───────┘ (agent dialed OUT)
                                          │
                                   finch agent on the box ──▶ local MCP server
```

- **Worker** = auth + routing (the thin plane: "we handle auth/routing/hosting").
- **ApplianceDO** = rendezvous + session anchor + bidirectional relay. Owns
  online/offline (= WS connected), request/response correlation, and later
  `mcp-session-id` stickiness + fleet features (tit-to-tit, broadcast, metering).
- **Agent** = outbound WS + local proxy. Reconnect + backoff. WS-protocol pings
  for NAT keepalive (auto-ponged by the DO → does not wake it → free). Never an
  app-level heartbeat (would wake + bill the DO).
- **App** = unchanged local MCP server (stays on the box; logic only).

### Auth: Clerk (not WorkOS)

Clerk fits a self-serve indie developer product better than WorkOS
(enterprise-SSO-first): better DX, generous free tier, drop-in OAuth + UI, and
MCP/OAuth support. Two credential types:
- **Clerk** — owner/human identity, dashboard login, OAuth for agent clients.
- **`finch_` keys** — agent/tool-call auth minted per appliance (hashed at rest).

The Worker terminates both at the edge and injects `X-Finch-User`. The appliance
app authenticates nothing — it reads the header (Sandstorm's "auth at the
proxy" lesson).

## Cost model (Cloudflare, with hibernation)

- **Idle fleet** (appliances connected, no clients): DOs hibernate → ~$0, just
  the $5/mo Workers Paid floor.
- **Per request/response tool call**: sub-microcent; millions/month fit inside
  free tiers (10M Worker req, 1M DO req, 400k GB-s).
- **Only real meter**: a client holding an open SSE push-session keeps its DO
  awake → ~0.5¢ per connected session-hour. Scales with concurrent held
  sessions, not call volume.
- Hard rule: agent keepalive = WS **pings** (free), never app messages
  (wake+bill). No `setInterval`/unresolved promises pinning the DO awake.

## Bidirectional

- **Wake on request**: automatic + transparent.
- **Request/response tools**: just work; DO awake only for the round-trip,
  hibernates between. (Built: the `id`-correlation relay.)
- **Server-initiated** (sampling/elicitation/progress/notifications): the
  agent→DO leg is natively duplex; reaching the client needs a session-sticky
  held SSE stream on the public side (the only thing that bills duration).
  Works, but is the part to design + pay for during live sessions. (Not yet
  built — current relay is request/response only.)

## Roadmap

1. ✅ Request/response relay end-to-end (Worker DO ↔ agent ↔ local server), hibernation-correct.
2. Appliance registry (KV/D1): id → owner, `finch_` key hashes, online state.
3. Clerk auth + `finch_` key check at the edge; inject `X-Finch-User`.
4. `finch` CLI: `new` / `connect` / `ls` / enrollment tickets; one-paste install.
5. Server-initiated bidirectional (session-sticky SSE relay).
6. Bundle/manifest runtime (folder = one MCP capability; launchd/systemd render).
7. Dashboard (fleet view + copy-paste MCP URLs + key minting).
8. Bind `finchmcp.com` zone + deploy.
