# finch dashboard (`web/`)

The finch control-plane UI: sign in (Clerk), watch your fleet, mint `finch_`
keys, manage access, and test services. Next.js (App Router) deployed to
**Cloudflare Workers via [OpenNext](https://opennext.js.org/cloudflare)** —
**not** Vercel.

> **Node 22 required.** The OpenNext build silently breaks on Node 26 (see
> [`.nvmrc`](.nvmrc) / `engines`). Run `nvm use` / `fnm use` before building.

## What's in it

| Surface | What |
|---|---|
| **Fleet** | Your services + boxes, grouped; live status, traffic, p50/p95. |
| **Service detail** | The connect URL (Claude/Cursor/JSON snippets), traffic, boxes + key revocation, recent calls, and a **"test in chat"** panel — an LLM (Cloudflare Workers AI) calls the service's MCP tools so you can confirm it works without leaving the dashboard. |
| **Keys** | Mint/revoke `finch_` bearer keys (a default-deny ACL governs which reach which service). |
| **Settings** | **Hub domain** — claim a `<slug>.finchmcp.com` with a live availability check. **CLI access** — generate the token you paste into `finch login`. Organization (read-only identity), default group, key expiry. |
| **Users / Access / Logs** | Clerk org members, ACL rules, the audit log. |

```
 browser ──▶ Next.js dashboard ──▶ /app/api/finch/* (BFF route handlers)
                                        │  Clerk auth() → requireAdmin
                                        │  sign a short-lived {tenant} assertion
                                        ▼
                                   finch hub Worker  (verifies X-Finch-Service
                                                      + the signed X-Finch-Auth)
```

The BFF never exposes the hub directly: each route checks the Clerk session,
then calls the hub with the shared `FINCH_SERVICE_SECRET` **and** an HMAC-signed
tenant assertion (so a leaked secret alone can't act as an arbitrary tenant).

## Setup

```bash
cp .dev.vars.example .dev.vars
```

Fill `.dev.vars`:

- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` / `CLERK_SECRET_KEY` — from a Clerk dev instance.
- `HUB_URL` — the finch hub (e.g. `http://localhost:8787` in dev).
- `FINCH_SERVICE_SECRET` / `TICKET_SECRET` — **must match `worker/.dev.vars`**
  (the dashboard signs assertions/tickets the hub verifies).

```bash
npm install
npm run dev          # http://localhost:3000  (run the hub in worker/ first)
```

## Scripts

| Script | What |
|---|---|
| `npm run dev` | local dev server |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | eslint |
| `npm test` | vitest (BFF auth, the signAssertion↔hub contract, scope formatting, …) |
| `npm run build` | `next build` |
| `npm run deploy` | OpenNext build + deploy to Cloudflare |

## Layout

| Path | What |
|---|---|
| `app/api/finch/*` | BFF route handlers — Clerk-gated, sign + proxy to the hub |
| `lib/hub.ts` | hub client: `resolveTenant`, `requireAdmin`, `adminProxy`, error shaping |
| `lib/assertion.ts` | the Clerk-free HMAC signer (shared shape with `worker/src/auth.ts`) |
| `components/dash/*` | the dashboard app (fleet, keys, access, users, settings, logs) |
| `middleware.ts` | Clerk middleware + CSRF (`Sec-Fetch-Site`/`Origin`) checks |
| `test/` | vitest unit/contract tests |

> Heads-up: this repo pins a **non-standard Next.js** build (see
> [`AGENTS.md`](AGENTS.md)) — check `node_modules/next/dist/docs/` before
> changing framework-level code.
