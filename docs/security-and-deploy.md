# Finch — Security Review & Deployment Guide

Status: **pre-launch.** This document is the security gate for the first production deploy of
Finch (the control plane for self-hosted MCP appliances). It covers (1) confirmed security
findings, (2) the hardening checklist to apply before any prod deploy, (3) the exact
Cloudflare deploy inventory, and (4) concrete dev/prod separation.

Components:

- **Hub** (`worker/`) — Cloudflare Worker + Durable Objects. `index.ts` (routing, tenant
  resolution), `api.ts` (control API `/api/*` + agent `/join`), `auth.ts` (`finch_` keys,
  HMAC tickets, service secret), `tenant-do.ts` (per-tenant registry), `appliance-do.ts`
  (per-machine WebSocket relay).
- **Web** (`web/`) — Next.js (OpenNext/Cloudflare) dashboard + landing. `lib/hub.ts`
  (Clerk-authed bridge to the hub), `app/api/finch/*` (route handlers), `middleware.ts` (Clerk).
- **Agent** (`agent/main.go`) — box-side relay agent: `/join` with a ticket, then holds the
  relay WebSocket open.

---

## 1. Security findings

Ranked by severity. **Deploy is BLOCKED until every Critical and High item is fixed.** The
single most important issue is the **unauthenticated agent relay channel** (`/_connect`) — fix
it first.

### Must-fix-before-deploy: the unauthenticated agent channel

The relay WebSocket upgrade at `/<appliance>/<machine>/_connect` performs **zero credential
checks**. `index.ts:118-131` forwards the upgrade on the `Upgrade: websocket` header alone, and
`appliance-do.ts:64-87` calls `ctx.acceptWebSocket(server, ["agent"])` (`:76`) unconditionally.
The `FLEET_SECRET` that is supposedly the "fleet membership proof" is minted and returned to
every agent (`api.ts:275`) and stored in the agent's join response struct (`agent/main.go:53`),
but the agent **never sends it** (`agent/main.go:161` dials with `websocket.Dial(ctx, wsURL, nil)`)
and the hub **never checks it** — it is entirely dead code. Anyone who knows or guesses a
tenant subdomain + appliance id + machine name (all low-entropy slugs, and the appliance id/URL
is printed in the enroll response and dashboard) can open the relay socket and become THE agent.
Because inbound MCP frames are forwarded with the full header set
(`appliance-do.ts:101` `Object.fromEntries(req.headers)`) and the agent only strips hop-by-hop
headers (`agent/main.go:219-225`), the attacker also receives every legitimate caller's
`Authorization: Bearer finch_…` key. This is a full data-plane takeover plus credential
exfiltration with no credentials required.

### Findings table

| # | Sev | Location | Risk | Fix |
|---|-----|----------|------|-----|
| C1 | **Critical** | `worker/src/index.ts:118-131`, `worker/src/appliance-do.ts:64-87,76` (key leak: `appliance-do.ts:101` + `agent/main.go:219-225`) | Agent relay WS `/_connect` is fully unauthenticated. Anyone can register as the box-side agent for any tenant/appliance/machine → relay hijack, harvest of callers' `finch_` keys, forged MCP responses, false "online" liveness. | Authenticate the `/_connect` upgrade **before** `ctx.acceptWebSocket`. Mint a **per-machine HMAC connect-token** at `/join` (reuse `auth.ts` `signToken`/`verifyToken` over `{tenant,appliance,machine,exp}` signed with `TICKET_SECRET`); have the Go agent present it on the dial (`DialOptions.HTTPHeader` `Authorization: Bearer <token>`, replacing the `nil` at `main.go:161`); verify it in `index.ts` and assert token tenant/appliance/machine match the resolved route; reject 401/403 via `verifyToken` + `timingSafeEqual`. |
| C2 | **Critical** | `worker/src/index.ts:29`, `worker/src/api.ts:275`, `worker/src/types.ts` (`JoinResp.fleetSecret`), `agent/main.go:53` | `FLEET_SECRET` is dead code: minted, broadcast to every agent in plaintext, never sent on the dial, never verified. Creates a false sense of authentication while the relay is wide open (same root cause as C1). | After C1's per-machine connect-token is in place, **remove `FLEET_SECRET` entirely**: drop from `Env` (`index.ts:29`), the `/join` response (`api.ts:275`), `JoinResp` type, and the agent struct (`main.go:53`). Do **not** keep a single global shared secret — one leaked box would impersonate the whole fleet. |
| C3 | **Critical** | `web/lib/hub.ts:44-48`; all mutating handlers under `web/app/api/finch/*`; user-mgmt `users/[id]/role/route.ts`, `users/[id]/route.ts`, `users/invite/route.ts`; hub trust `worker/src/api.ts:78-84`, `auth.ts:160-169` | **No authorization anywhere.** `resolveTenant` returns `orgId ?? userId` with no role check; the hub only checks the service secret and trusts `X-Finch-Tenant`. Any logged-in org **Member** can mint `finch_` keys, rewrite ACLs, change settings/subdomain, release/approve appliances — and the user-management routes call the Clerk backend admin client (`clerkClient()`) with no caller-role check, so a Member can **self-promote to org:admin** (`users/[id]/role/route.ts:28`), delete the owner, or invite outsiders. Full tenant takeover from lowest privilege. | Add a shared `requireAdmin()` in `lib/hub.ts`: `const {userId,orgId,has}=await auth();` 401 if no `userId`; if `orgId` present require `has({role:'org:admin'})` else 403; treat no-org (personal tenant) as authorized. Call it at the top of every mutating handler. The three Clerk-direct user-mgmt routes bypass `resolveTenant`/`hubFetch` — they must add `requireAdmin()` individually. Refuse demoting/removing the last admin/owner. Keep read-only `GET /api/finch/state` open to members. |
| H1 | **High** | `worker/src/appliance-do.ts:76,90` | No single-agent enforcement: every `/_connect` socket gets the `"agent"` tag; relay picks `getWebSockets("agent")[0]` nondeterministically. A second socket coexists undetected (malicious takeover once C1 is fixed-but-not-this, or split-brain from the agent's own reconnect loop `main.go:80-92`). | On a new `/_connect`, evict prior agents before accepting (`for ws of ctx.getWebSockets("agent"): ws.close(1012,"superseded")`) — last-writer-wins. Guard `markMachine` ordering: skip `markMachine(false)` on close code 1012, or re-assert `markMachine(true)` after eviction so liveness doesn't flap. **Must be paired with C1** — without auth this just gives the attacker a clean deterministic takeover. |
| H2 | **High** | `worker/src/appliance-do.ts:61,99-103`; `agent/main.go:214,219-225`; gate `index.ts:134` | Relay is an open **SSRF proxy** into the box's loopback: attacker-controlled method + path + query + headers are forwarded verbatim to the agent's local upstream with no allowlist. `index.ts:134` only requires the 3rd segment be `mcp` (path starts with `/mcp`); the agent does pure string concat (`main.go:214`), so `/mcp/../admin` resolves to `/admin` on most frameworks → full SSRF to anything on `127.0.0.1`. Spoofable `X-Forwarded-For`, leaked `Authorization`. | (1) Hub-side: in `relayMcp` only forward the exact `/<appliance>/<machine>/mcp` route. (2) Agent-side (`main.go forward`): `path.Clean` the path **before** the check, then allowlist (only `POST`/`GET` where cleaned path `== "/mcp"` or has prefix `/mcp/` if subpaths are intended); 403 otherwise. (3) Replace `Object.fromEntries(req.headers)` (`appliance-do.ts:101`) with an explicit header safelist and drop inbound `Authorization`. |
| H3 | **High** | `worker/src/index.ts:187,214-218` → `appliance-do.ts:101` → `agent/main.go:219-226` | Caller's `Authorization: Bearer finch_…` key is forwarded verbatim to the box's local upstream on every relayed call (credential leak across trust boundary). Default key scope is "all appliances" (`tenant-do.ts:473`), so a key harvested from one box's upstream logs is valid against every appliance in the tenant. | In `relayMcp` strip the credential before relaying: build the relay `Request` from a `Headers` clone with `authorization` deleted (`req.body` is still unconsumed at `index.ts:218`). Add `authorization` to the agent's hop-by-hop strip switch (`main.go:221`) as defense-in-depth. If a box upstream needs auth, inject a separate per-appliance secret — never the caller's `finch_` key. |
| H4 | **High** | `worker/src/tenant-do.ts:529-557` (ACL stored only), `:251` (echoed in state), `:774-793` (checkKey, sole gate); `worker/src/index.ts:194-202`; web `access.tsx:62,106`, `panels.tsx:152` | **ACL rules are stored, logged, and advertised-as-enforced but NEVER evaluated** on MCP traffic. The only runtime gate is `checkKey` (key-hash exists + scope match). The dashboard explicitly promises "Every rule is enforced at the door" — a missing control turned into an actively misleading one. The mint form submits no `scope`, so `mintKey` defaults every key to fleet-wide. Net: any valid `finch_` key reaches every appliance in the tenant (intra-tenant confused-deputy / priv-esc). | Evaluate `s.acl` (default-deny, src→dst) inside the DO atomically with `checkKey` before forwarding: extend `checkKey` to return the key identity, resolve src entities (`key`→id/label, `user`→owner, `group`/`tag`→appliance's group/tags, `all`→wildcard), evaluate against the target appliance. Until then, remove the false UI copy (`access.tsx:62,106`, `panels.tsx:152`) and wire the mint form to send a real scope. |
| H5 | **High** | `worker/src/api.ts:78-84`; `auth.ts:160-169`; `web/lib/hub.ts:55-76` | **Unscoped `FINCH_SERVICE_SECRET` is a fleet-wide god-key:** every `/api/*` route gates only on `serviceOk()` then trusts `X-Finch-Tenant` verbatim. Any holder can name any tenant and dump state, mint keys + join tickets, mutate ACLs/settings/appliances. Web→hub is a **public-internet `fetch` over `HUB_URL`** (not a service binding) to a publicly-routed `/api/*` surface. | Replace the public `fetch` with a **Cloudflare Worker-to-Worker service binding** (add `finch` to `finch-web`'s `services[]`) so the secret never crosses the public wire and `/api/*` stops being publicly callable. Add per-request cryptographic tenant binding (web HMACs/signs the tenant id with a key the hub verifies) so a leaked secret can't be replayed for arbitrary tenants. Add tenant-mismatch alerting. |
| H6 | **High** | `worker/wrangler.jsonc:11-13`, `worker/src/index.ts:37-46,108` | `tenantFromHost` **fails OPEN** to the committed `DEFAULT_TENANT="dev-tenant"` for any non-subdomain host (apex, `www`, `*.workers.dev`). Ships a debug fallback tenant to prod; combined with H7, it's currently the sole live ingress and every request resolves to `dev-tenant`. | Remove `DEFAULT_TENANT` from committed `vars`; provide it only via `worker/.dev.vars` (dev) and **only under the dev env** (see §4). Make `tenantFromHost` **fail closed**: if no `<sub>.finchmcp.com` subdomain resolves and `DEFAULT_TENANT` is unset, return 400/404 ("tenant could not be resolved from host"). Reject apex and `*.workers.dev` in prod. |
| H7 | **High** | `worker/wrangler.jsonc:32-33` (routes commented out, no `workers_dev:false`); `worker/package.json` (bare `wrangler deploy`) | Prod Worker is reachable on `*.workers.dev` (a stable public hostname **outside any WAF / CF Access** bound to `*.finchmcp.com`) and, via H6, pins all traffic to `dev-tenant`. | Under a production env set `"workers_dev": false` and bind the real routes (`finchmcp.com/*`, `*.finchmcp.com/*`) so only subdomain-scoped, WAF-coverable hostnames are reachable. Keep `workers.dev` only under the dev env. Deploy with `wrangler deploy --env production`. |
| M1 | **Medium** | `worker/src/auth.ts:74-78,110-151`; `api.ts:24,216,243-260`; `tenant-do.ts:605-612` | Join tickets are **replayable for the full 1h TTL** ("one-shot" in comments, but `verifyToken` checks only signature + structure + `exp`; no `jti`/nonce/used-ticket store). `body.machine` is attacker-chosen and uncapped → registry pollution, machine-name squatting, unbounded DO creation within the ticket's tenant+appliance. Mitigated somewhat because `requireApproval` defaults true. | Add a random `jti` to `TicketPayload`; in `handleJoin` atomically check/record it in `TenantDO` (used-tickets set with TTL eviction at `exp`) before `registerMachine`. Shorten `TICKET_TTL_SECONDS` to ~5-10 min. Validate/clamp `body.machine` (length + charset) and bound machines-per-appliance. |
| M2 | **Medium** | `worker/src/tenant-do.ts:460-488` (`mintKey` default `'all appliances'`), `:776-793` (`checkKey`); `api.ts:127-143` (scope passed unvalidated) | `checkKey` scope is the sole appliance gate, **defaults to fleet-wide**, and parses free-text/magic strings (`"all appliances"`/`"all"`/`"*"`, CSV). Unvalidated scope CSV (no check that ids are real appliances). Combined with H4 (ACL unenforced), every minted key is whole-tenant by default. | Change `Key.scope` to structured form (`string[]` of appliance ids, or `{all:true} \| {appliances:string[]}`). Default `mintKey` to least privilege (explicit selection required). Validate at mint time that every appliance id exists; reject unknown ids 400. Drop the magic-string overloads; gate fleet-wide behind an explicit validated boolean. |
| M3 | **Medium** | `worker/wrangler.jsonc:1-34`, `web/wrangler.jsonc:1-23`, `worker/package.json`, `web/package.json` | **No wrangler environments:** single Worker name + one DO namespace per class for all deploys; env-less deploy scripts publish straight to the implicit top-level (prod) Worker. Prod-overwrite footgun and zero deploy-target isolation. (Note: `wrangler dev` defaults to local Miniflare, so routine local dev does **not** touch deployed prod DOs.) | Add `[env.production]` and `[env.dev]` blocks to both `wrangler.jsonc` files with distinct names, routes, vars (see §4). Change `deploy` scripts to target `--env production`. DO ids are name-scoped per Worker, so distinct names = separate DO state. |
| M4 | **Medium** | `worker/.dev.vars:3-5`, `web/.dev.vars` (`FINCH_SERVICE_SECRET` duplicated), no `.example`, no env blocks | No dev/prod secret-separation hardening: identical dev `TICKET_SECRET`/`FINCH_SERVICE_SECRET` exist in two `.dev.vars` files; nothing structurally prevents an operator seeding prod with known dev values (e.g. `wrangler secret bulk .dev.vars`). `TICKET_SECRET` forges join tickets for any tenant; `FINCH_SERVICE_SECRET` is the web→hub trust root. | Add tracked `worker/.dev.vars.example` + `web/.dev.vars.example` (placeholders only) and a secrets checklist. Generate fresh high-entropy prod values; set per-worker via `wrangler secret put …` — never `secret bulk .dev.vars`. Add a deploy preflight that refuses to deploy if any live secret equals a known dev value. |
| M5 | **Medium** | `worker/src/index.ts:88,178-202,194`; `api.ts:78,237`; `tenant-do.ts:358-384,597-653,765,781`; `worker/wrangler.jsonc` (no rate-limit binding) | **No rate limiting / abuse controls.** A well-formed-but-wrong `Bearer finch_…` forces a `checkKey` DO round-trip + state load before any gate (`index.ts:194`) → cheap unbounded DO-invocation/cost-amplification DoS for anyone who knows a tenant subdomain. `appliances[]` (enroll) and `machines[]` (registerMachine) are pushed uncapped → unbounded DO state growth. (Brute-force/oracle sub-claims are overstated: tickets/keys are 256-bit, and wrong vs. nonexistent keys both return 403.) | Bind Cloudflare Rate Limiting (`unsafe.bindings ratelimit`); gate per-(tenant,IP) in `relayMcp` **before** the `checkKey` round-trip and per-IP on `/join`. Cap appliances-per-tenant in `enroll` and machines-per-appliance in `registerMachine`; error past the cap. (Skip Turnstile on `/api/enroll` — it's service-secret-gated, no browser.) |
| L1 | Low | `worker/src/auth.ts:160-169`; `api.ts:78-98,200-233` | Service-authed enroll/join can target any tenant via attacker-controlled `X-Finch-Tenant` (subset of H5). Architecture/secret-hygiene observation — the secret is only ever held by two first-party server-side components; not an attacker-reachable cross-tenant exploit. | Treat `FINCH_SERVICE_SECRET` as a root credential: store only in wrangler secrets in prod, isolate from the Clerk key in dev (currently co-located in `web/.dev.vars`), rotate independently, log/monitor its use. Optionally HMAC-bind per tenant (defense-in-depth, not a hard boundary — tenant ids are low-entropy Clerk org/user ids). |
| L2 | Low | `web/app/api/finch/*` (all POST/PUT/DELETE), `web/lib/hub.ts:44-76`, `web/middleware.ts:5-11` | No CSRF/Origin defense on cookie-authed mutating handlers. **Mitigated in modern browsers** by Clerk's default `SameSite=Lax` session cookie (Lax does not attach to cross-site POST). Defense-in-depth gap, not a live CSRF. | Add a same-origin guard rejecting non-GET `/api/finch/*` whose `Origin` is absent/not allowlisted (or lacking `Sec-Fetch-Site: same-origin`), enforced in `middleware.ts` so all current/future handlers are covered. Don't rely on content-type as CSRF defense. |
| L3 | Low | `worker/src/index.ts:88-155` (OPTIONS → 404 at `:153`), `api.ts`, `appliance-do.ts` | No CORS/OPTIONS handling. **Not a live vuln**: both planes use header-based credentials (service secret; Bearer key), no cookie/ambient-credential surface, and OPTIONS already fails closed to 404 with no `Access-Control-Allow-Origin`. Posture/possible-functional gap. | Make posture explicit. Control API: keep header-only, emit no `Access-Control-*`. MCP relay: add an allowlist OPTIONS/CORS handler **only if** browser MCP clients are a goal (`Access-Control-Allow-Headers: authorization, content-type`, omit `Allow-Credentials`); otherwise document as non-browser only. |
| L4 | Low | `worker/src/api.ts:223`; `web/components/dash/panels.tsx:30,33`; `web/components/HowItWorks.tsx:36` | Advertised `/install` pipe-to-shell endpoint does not exist (`/install`, `/install.ps1`, `/start` all 404; the `finch join` verb doesn't exist — agent parses `finch --ticket`; dashboard copies a mock `tk_` ticket). Broken onboarding now; `curl\|sh` is a future supply-chain risk. | Fix all surfaces consistently; correct the CLI invocation (`finch --ticket`, not `finch join`); render the real hub-issued ticket. When `/install` is built: serve over HTTPS from a fixed apex with a published SHA-256 / signed (cosign/minisign) release binary, or ship a directly-run binary instead of `\| sh`. |
| L5 | Low | `web/.dev.vars` (`CLERK_SECRET_KEY=sk_test_…`, `FINCH_SERVICE_SECRET`), `worker/.dev.vars` (`FINCH_SERVICE_SECRET`/`FLEET_SECRET`/`TICKET_SECRET`) | Dev-only Clerk `sk_test_` key + finch dev secrets sit in plaintext in correctly-gitignored `.dev.vars`. Confirmed NOT tracked / never committed / not leaked into `.next`. Standard local-dev hygiene; blast radius is the dev Clerk instance only. (Rotate because the `sk_test_` value was disclosed into a review transcript.) | Rotate the disclosed `sk_test_` key + dev finch secrets. Add tracked `.dev.vars.example` stubs (none exist today). `.dev.vars` IS the intended Wrangler/OpenNext local-dev mechanism — keep it (gitignored), don't move local dev to a secret manager. |
| L6 | Low | `web/lib/hub.ts:83-91` (`hubProxy`), `web/lib/hub.ts:98` (`errorResponse`) | Hub-internal error details pass straight through to the client. Largely redundant (the web `/api/finch/*` routes are a 1:1 public projection of the hub API) — the only genuine leak is the raw exception message at `errorResponse:98`. No secrets leak; all routes post-auth. | In `errorResponse` non-`HttpError` branch: log `err.message` server-side, return generic `{error:'internal error'}` 500. In `hubProxy`: pass structured `{error}` through for expected 4xx (dashboard relies on it), genericize only 5xx bodies. |
| L7 | Low | `web/.env.local`, `web/.dev.vars`, `web/lib/hub.ts:44-48`, `web/wrangler.jsonc` | Only a Clerk **dev** instance (`pk_test`/`sk_test`) is wired; `resolveTenant` makes Clerk identity the tenant root-of-trust. A dev-grade auth instance would undermine prod tenant identity if deployed. Pre-launch hardening note (nothing deployed yet). | Provision a Clerk **production** instance before deploy; set `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_…` as a build-time var for the prod build and `CLERK_SECRET_KEY=sk_live_…` via `wrangler secret put` under the production env. Configure Organizations on the live instance (`resolveTenant` depends on `orgId`). Lock authorized parties / origins to `finchmcp.com`. |
| L8 | Low | `web/wrangler.jsonc:14-20`; `web/lib/hub.ts:55-76` (secret set at `:69`) | `HUB_URL` has no env separation (committed default `http://localhost:8787`). A misconfigured non-https override would send the `X-Finch-Service` root secret in cleartext. Fail-broken in practice (localhost unroutable on CF + `global_fetch_strictly_public`), pre-prod. | Add an in-code guard in `hubFetch`: after resolving `hubUrl`, throw 500 unless it is `https:` or a localhost/`127.0.0.1` dev URL (fail-closed regardless of config). Move `HUB_URL` into per-env config (https hub under `[env.production]`, localhost only under dev). The service binding in H5 makes this moot for the hub call. |
| L9 | Low | `worker/src/appliance-do.ts:102` (buffering); `index.ts:178-239` | No request-size limit on the relay — full body buffered into the per-machine DO heap (`await req.text()`), no 413/content-length check anywhere. Authenticated (post-`checkKey`), single-machine scope; single-request OOM impossible (CF 100MB cap) but concurrent POSTs can sum past DO heap. | In `relayMcp` (post-auth, pre-`stub.fetch`) reject when `content-length` exceeds a small cap (a few MB suits MCP JSON-RPC) → 413. **Also** enforce in `ApplianceDO.fetch` after `req.text()` by checking string length (content-length is client-controlled/absent for chunked), else a spoofed header bypasses the index.ts check. |

---

## 2. Hardening checklist (ordered, grouped — apply before any prod deploy)

Apply top to bottom. The **auth channel** group is the deploy gate.

### A. Auth channel (relay `/_connect`) — DEPLOY BLOCKER
1. **Mint a per-machine HMAC connect-token at `/join`** (`api.ts handleJoin`): `signToken({tenant,appliance,machine,exp}, TICKET_SECRET)`; add `machine` to `TicketPayload` and update `verifyToken`'s shape check. Return it in `JoinResp` (e.g. `connectToken`). [C1]
2. **Send it from the Go agent on the dial**: replace `websocket.Dial(ctx, wsURL, nil)` (`main.go:161`) with `DialOptions{HTTPHeader: {"Authorization": "Bearer <token>"}}`; re-/join on reconnect (agent loops forever — don't let a short TTL fail closed mid-life; use a renewable/long-lived relay token). [C1]
3. **Verify before `acceptWebSocket`**: in `index.ts` (upgrade headers available there) `verifyToken` it and assert token tenant/appliance/machine match the host/path-resolved route; reject 401/403 with `timingSafeEqual`. Re-verify or pass a trust flag into `appliance-do.ts` so the DO can't be hit directly. [C1]
4. **Enforce single-agent** in `appliance-do.ts`: evict prior `getWebSockets("agent")` sockets (`ws.close(1012,"superseded")`) before accepting; skip `markMachine(false)` on close code 1012 (or re-assert `true`) to avoid liveness flapping. [H1]
5. **Remove `FLEET_SECRET` entirely** once the connect-token is load-bearing (`index.ts:29`, `api.ts:275`, `JoinResp` type, `main.go:53`, wrangler comments). [C2]

### B. Secrets
6. Generate fresh high-entropy prod values for `TICKET_SECRET`, `FINCH_SERVICE_SECRET` (and the new connect-token secret if separate). Set per-worker via `wrangler secret put …` (never `secret bulk .dev.vars`). [M4]
7. Add tracked `worker/.dev.vars.example` + `web/.dev.vars.example` (placeholders only) and a secrets checklist. [M4, L5]
8. Rotate the disclosed dev `sk_test_` Clerk key + dev finch secrets. [L5]
9. Add a deploy preflight that refuses to deploy if any live secret equals a known dev value. [M4]
10. Isolate `FINCH_SERVICE_SECRET` from the Clerk secret in dev (`web/.dev.vars` co-locates them); treat it as a root credential, rotate independently, monitor use. [L1]

### C. Tenant isolation
11. Make `tenantFromHost` **fail closed** (no `DEFAULT_TENANT` fallback in prod; 400/404 on unresolved host). Reject apex + `*.workers.dev`. [H6]
12. Add per-request **cryptographic tenant binding** on web→hub (web signs/HMACs the tenant id; hub verifies), so a leaked service secret can't be replayed for arbitrary tenants. [H5, L1]
13. **Evaluate ACL rules** in the relay (default-deny, atomic with `checkKey` inside the DO); remove the false "enforced at the door" UI copy until done. [H4]
14. Replace free-text scope with structured least-privilege scope; validate appliance ids at mint; drop magic strings. [M2]

### D. Web / Clerk authz + CSRF
15. Add `requireAdmin()` to `lib/hub.ts`; gate every mutating `/api/finch/*` handler. [C3]
16. Gate the three Clerk-direct user-management routes (`users/[id]/role`, `users/[id]`, `users/invite`) individually — they bypass `resolveTenant`/`hubFetch`; refuse demoting/removing the last admin/owner. [C3]
17. Provision a Clerk **production** instance (`pk_live`/`sk_live`); configure Organizations; lock origins to `finchmcp.com`. [L7]
18. Add a same-origin/`Sec-Fetch-Site` guard for non-GET `/api/finch/*` in `middleware.ts`. [L2]
19. Genericize 5xx error bodies in `errorResponse`/`hubProxy`; log details server-side. [L6]

### E. Transport / CORS / rate-limit
20. Move web→hub to a **CF Worker-to-Worker service binding** (add `finch` to `finch-web`'s `services[]`); `/api/*` stops being publicly callable. [H5]
21. Add the `hubFetch` https-or-localhost guard (belt-and-suspenders if a binding isn't used everywhere). [L8]
22. Fix the **SSRF**: hub-side exact-route forward + agent-side `path.Clean` + method/path allowlist; header safelist + drop inbound `Authorization`. [H2]
23. **Strip the caller's `finch_` key** before relaying (hub-side + agent-side defense). [H3]
24. Bind Cloudflare Rate Limiting; gate `relayMcp` (before the DO round-trip) and `/join` per-IP/per-tenant. Cap appliances/machines counts. [M5]
25. Add request-size 413 caps in `relayMcp` and `ApplianceDO.fetch`. [L9]
26. Make join tickets single-use (`jti` + used-set), shorten TTL, validate `body.machine`. [M1]
27. Bind real routes + `workers_dev:false` under the prod env so traffic is WAF/Access-coverable. [H7]
28. Fix the `/install` onboarding surfaces / CLI verb / mock ticket (and design a signed-binary install before enabling `curl|sh`). [L4]

---

## 3. Cloudflare deploy inventory

What actually ships, with the exact secrets/vars/routes per worker.

### 3.1 Workers (two)

| Worker | Source | Build/deploy | Plan |
|--------|--------|--------------|------|
| **`finch`** (hub) | `worker/src/index.ts` | `wrangler deploy --env production` | **Workers Paid** (Durable Objects require it) |
| **`finch-web`** (dashboard + landing) | OpenNext build → `.open-next/worker.js` | `opennextjs-cloudflare build && opennextjs-cloudflare deploy -- --env production` | Workers Paid (shares account) |

### 3.2 Durable Objects (hub only)

- Classes: **`ApplianceDO`** (per-machine WS relay), **`TenantDO`** (per-tenant control-plane state).
- Bindings: `APPLIANCE → ApplianceDO`, `TENANT → TenantDO`.
- Migrations (already present): `v1` `new_sqlite_classes: ["ApplianceDO"]`, `v2` `new_sqlite_classes: ["TenantDO"]`. SQLite-backed (required for the modern DO API). **Do not renumber existing tags.**
- DO ids are derived from `idFromName` (`${tenant}:${appliance}:${machine}` for ApplianceDO, tenant id for TenantDO) and are **scoped per Worker name** — so a distinct prod Worker name (`finch-prod`) gives a fully separate DO namespace from dev (see §4).

### 3.3 Secrets & vars

**Hub (`finch`)** — set under the production env: `wrangler secret put <NAME> --env production`
- `FINCH_SERVICE_SECRET` (secret) — web→hub shared secret.
- `TICKET_SECRET` (secret) — HMAC key for join tickets (and the new per-machine connect-token).
- ~~`FLEET_SECRET`~~ — **delete** (dead code, C2). If the connect-token uses a separate signing secret, `wrangler secret put CONNECT_TOKEN_SECRET` instead.
- `DEFAULT_TENANT` (var) — **dev env only.** Must NOT be set in production (H6: prod must fail closed).
- Routes (prod env): `finchmcp.com/*` and `*.finchmcp.com/*`; `workers_dev: false`.

**Web (`finch-web`)** — secrets via `wrangler secret put <NAME> --env production`; publishable key is a build-time env var
- `CLERK_SECRET_KEY` (secret) — `sk_live_…` (prod Clerk instance).
- `FINCH_SERVICE_SECRET` (secret) — must equal the hub's. *(Eliminated from the wire by the service binding in H5, but still configured for the bridge.)*
- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` (build-time var) — `pk_live_…`. Must be present at build or Clerk silently falls back; supply via CI build env or wrangler var.
- `NEXT_PUBLIC_CLERK_SIGN_IN_URL` / `_SIGN_UP_URL` / `_SIGN_IN_FALLBACK_REDIRECT_URL` / `_SIGN_UP_FALLBACK_REDIRECT_URL` (build-time vars).
- `HUB_URL` (var) — prod hub origin under the production env (or unused once the service binding lands).
- Service binding (recommended, H5): `services: [{ binding: "FINCH_HUB", service: "finch" }]` in addition to the existing `WORKER_SELF_REFERENCE`.
- Routes (prod env): `finchmcp.com/*` (apex/app).

### 3.4 DNS / routes for `finchmcp.com`

- **Apex + app** (`finchmcp.com`, `www`/app host) → **`finch-web`** (dashboard + landing).
- **Tenant subdomains** (`*.finchmcp.com`) → **`finch`** (hub) for MCP relay + agent `/connect`. The wildcard is how `tenantFromHost` resolves the tenant.
- Zone `finchmcp.com` must be on Cloudflare (orange-cloud) so Worker routes + WAF apply.
- After H6/H7: `workers_dev:false` and the only reachable hostnames are the bound routes.

### 3.5 Clerk

- A **production Clerk instance** (separate from dev). `pk_live`/`sk_live`. Organizations enabled (`resolveTenant` needs `orgId`). Authorized parties / allowed origins locked to `finchmcp.com`.

### 3.6 Step-by-step deploy order

1. **Plan**: confirm the Cloudflare account is on **Workers Paid** (DOs).
2. **Zone**: add `finchmcp.com` to Cloudflare; verify DNS is active (orange-cloud).
3. **Clerk prod**: create the production instance; enable Organizations; set authorized parties to `finchmcp.com`; note `pk_live`/`sk_live`.
4. **Apply all Critical + High fixes** from §2 (deploy is blocked otherwise) — especially the `/_connect` connect-token (A1-A5).
5. **Hub secrets**: `wrangler secret put FINCH_SERVICE_SECRET --env production`, `... TICKET_SECRET --env production`, (connect-token secret if separate). Do NOT set `DEFAULT_TENANT` in prod.
6. **Deploy hub**: `cd worker && wrangler deploy --env production`. Confirm DO migrations applied and `workers_dev:false` / routes bound.
7. **Web build-time vars**: set `NEXT_PUBLIC_CLERK_*` (incl. `pk_live`) in the build env.
8. **Web secrets**: `wrangler secret put CLERK_SECRET_KEY --env production` (`sk_live`), `... FINCH_SERVICE_SECRET --env production` (matching the hub).
9. **Deploy web**: `cd web && opennextjs-cloudflare build && opennextjs-cloudflare deploy -- --env production`.
10. **Smoke test**: dashboard sign-in (Organizations), enroll an appliance, agent `/join` + `/_connect` with the connect-token, a relayed MCP call with a `finch_` key, and confirm the apex + a tenant subdomain both route correctly. Verify `*.workers.dev` and the apex no longer resolve to `dev-tenant`.

---

## 4. Dev vs Prod separation

Goal: **a dev build can never point at prod secrets or prod tenant data.** Achieved with
wrangler **environments** for both workers (distinct names → distinct DO namespaces, routes,
vars, and secrets), separate Clerk instances, and `DEFAULT_TENANT` confined to dev.

### 4.1 Design

- **Distinct Worker names per env** — `finch` / `finch-web` for dev, `finch-prod` / `finch-web-prod` for production. Because DO ids are name-scoped per Worker, the prod Worker has a **completely separate `ApplianceDO`/`TenantDO` namespace**; dev deploys can never read or mutate prod tenant registries, keys, or ACLs.
- **Distinct routes** — prod binds `finchmcp.com/*` + `*.finchmcp.com/*` with `workers_dev:false`; dev uses `workers.dev` (or a `dev.finchmcp.com` zone) and may keep `workers_dev:true`.
- **Distinct secrets** — secrets are per-deployed-worker; `wrangler secret put … --env production` only touches `finch-prod`. Generate fresh prod values; never copy dev `.dev.vars` into prod.
- **Distinct Clerk instances** — dev uses `pk_test`/`sk_test`, prod uses `pk_live`/`sk_live`, each its own JWKS issuer. Since `resolveTenant` makes Clerk identity the tenant root-of-trust, this keeps prod tenant identity off the dev auth instance.
- **`DEFAULT_TENANT` is dev-only** — set only in `[env.dev]` vars and `worker/.dev.vars`. Prod has it **unset**, and `tenantFromHost` fails closed (H6) so a missing subdomain is a 400/404, never a silent fallback tenant.
- **Local dev → dev env** — `.dev.vars` (gitignored, throwaway values) feeds `wrangler dev` / `next dev` in local Miniflare mode; local DOs live in gitignored `.wrangler/` and never touch edge DOs (only `wrangler dev --remote`, which we don't use, would).
- **Guardrail** — change the bare `deploy` scripts to require `--env`, and add a deploy preflight (M4) that aborts if a live secret equals a known dev value. A dev checkout therefore cannot `npm run deploy` onto the prod Worker by accident.

### 4.2 `worker/wrangler.jsonc` env blocks to add

```jsonc
{
  "name": "finch",                 // dev / default
  "main": "src/index.ts",
  "compatibility_date": "2026-06-01",
  "compatibility_flags": ["nodejs_compat"],
  "observability": { "enabled": true },
  "durable_objects": {
    "bindings": [
      { "name": "APPLIANCE", "class_name": "ApplianceDO" },
      { "name": "TENANT", "class_name": "TenantDO" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["ApplianceDO"] },
    { "tag": "v2", "new_sqlite_classes": ["TenantDO"] }
  ],

  "env": {
    "dev": {
      "name": "finch-dev",
      "workers_dev": true,
      // DEFAULT_TENANT lives ONLY here (and in .dev.vars) — never in prod.
      "vars": { "DEFAULT_TENANT": "dev-tenant" }
    },
    "production": {
      "name": "finch-prod",
      "workers_dev": false,
      // NO DEFAULT_TENANT — tenantFromHost must fail closed in prod.
      "vars": {},
      "routes": [
        { "pattern": "finchmcp.com/*",   "zone_name": "finchmcp.com" },
        { "pattern": "*.finchmcp.com/*", "zone_name": "finchmcp.com" }
      ]
    }
  }
  // Secrets per env: wrangler secret put FINCH_SERVICE_SECRET --env production
  //                  wrangler secret put TICKET_SECRET        --env production
  //                  (CONNECT_TOKEN_SECRET if separate). FLEET_SECRET removed.
}
```

> Note: top-level `durable_objects`/`migrations` apply to all environments. Keep them at the
> top level (as above) so dev and prod share the same class definitions but get separate
> name-scoped DO instances.

### 4.3 `web/wrangler.jsonc` env blocks to add

```jsonc
{
  "main": ".open-next/worker.js",
  "name": "finch-web",             // dev / default
  "compatibility_date": "2025-09-23",
  "compatibility_flags": ["nodejs_compat", "global_fetch_strictly_public"],
  "assets": { "directory": ".open-next/assets", "binding": "ASSETS" },

  "env": {
    "dev": {
      "name": "finch-web-dev",
      "services": [
        { "binding": "WORKER_SELF_REFERENCE", "service": "finch-web-dev" },
        { "binding": "FINCH_HUB", "service": "finch-dev" }   // service binding (H5)
      ],
      "vars": { "HUB_URL": "http://localhost:8787" }
    },
    "production": {
      "name": "finch-web-prod",
      "workers_dev": false,
      "services": [
        { "binding": "WORKER_SELF_REFERENCE", "service": "finch-web-prod" },
        { "binding": "FINCH_HUB", "service": "finch-prod" }  // service binding (H5)
      ],
      "vars": { "HUB_URL": "https://finchmcp.com" },         // unused once FINCH_HUB binding is used
      "routes": [
        { "pattern": "finchmcp.com/*", "zone_name": "finchmcp.com" }
      ]
    }
  }
  // Secrets per env: wrangler secret put CLERK_SECRET_KEY      --env production  (sk_live_…)
  //                  wrangler secret put FINCH_SERVICE_SECRET  --env production  (== hub)
  // Build-time: NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_… (CI build env / wrangler var)
}
```

### 4.4 Local dev mapping

- `worker`: `wrangler dev` reads `worker/.dev.vars` (incl. `DEFAULT_TENANT=dev-tenant`) in local Miniflare — separate from any deployed DO state.
- `web`: `next dev` / `opennextjs-cloudflare preview` reads `web/.dev.vars` (`pk_test`/`sk_test`, local `HUB_URL`).
- Both `.dev.vars` are gitignored; commit `.dev.vars.example` stubs (M4) so a new clone knows what to fill in without inheriting real values.
