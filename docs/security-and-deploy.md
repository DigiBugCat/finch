# Security model and deployment

Status: **current.** How finch authenticates each hop, what it deploys to
Cloudflare, and how the environments are kept apart. The June 2026 pre-launch
audit that used to live here is in
[`archive/security-review-2026-06.md`](archive/security-review-2026-06.md),
with a note on how each finding was resolved. To report a vulnerability, see
[`SECURITY.md`](../SECURITY.md).

## Components

| Component | Code | Runs as |
|---|---|---|
| **Hub** | `worker/` | Cloudflare Worker `finch-prod` with three Durable Object classes: `RouterDO` (one global index from host to account), `TenantDO` (one per account: services, machines, key hashes, settings, call records) and `BoxDO` (one per service per machine: the relay socket). |
| **Web** | `web/` | Cloudflare Worker `finch-web-prod` (Next.js through OpenNext): the landing page, docs, Clerk sign-in and the `finch login` approval page at `/cli`. |
| **CLI** | `agent/` | The `finch` binary on your machine. `finch run` (usually as a launchd or systemd user service) holds one outbound WebSocket per service. |

In code an account is a *tenant* and a machine is a *box*; user-facing text
says account and machine.

## Who authenticates to whom

### Your machine to the hub

1. **CLI login.** `finch login` starts a device-code flow. You approve the code
   on `/cli` while signed in; the hub then issues a CLI token (30 days, signed
   with `FINCH_SERVICE_SECRET` and bound to a per-account epoch) that the CLI
   stores in `~/.finch/cli.json` with mode `0600`. `finch revoke-tokens`
   bumps the epoch, which invalidates every CLI token for the account.
2. **Join ticket.** `finch add` asks the hub for a join ticket (15 minutes,
   single use: its `jti` is burned on first use) and trades it at `/join` for a
   refresh token.
3. **Refresh token.** Long-lived (30 days), stored per service in the
   credentials directory (`~/.finch/<service>.json` by default, `0600`). The agent
   presents it at `/refresh` to get connect tokens, so restarts and reboots need
   no new ticket.
4. **Connect token.** Short-lived (120 seconds), HMAC-signed with
   `TICKET_SECRET` for exactly one account, service and machine. The agent
   dials `wss://<host>/<service>/<machine>/_connect?ct=<token>`; the hub checks
   the token against the route before it accepts the socket. A new connection
   for the same service and machine closes the old one.

The CLI refuses a non-loopback `http://` hub URL, a plaintext relay URL and a
redirect from TLS to plaintext.

### Callers to a service

A key-gated service (the default) accepts one of:

- a **`finch_` key** as `Authorization: Bearer finch_…`. The hub stores only
  the key's SHA-256 hash, its last four characters, a label and a scope
  (`{all:true}` or a list of services, validated when the key is minted).
  `finch connect` mints a key for one service and writes it into the client's
  configuration without printing it.
- a **Clerk OAuth access token**, for clients that only speak OAuth (for
  example claude.ai custom connectors). The hub serves RFC 9728
  protected-resource metadata that points at Clerk, and admits a token only
  when its Clerk user is the account owner.
- the hub's own first-party assertion, used by `finch test` and `finch call`
  (`POST /api/cli/call`).

A service marked `--public` accepts anyone with the URL.

Before relaying, the hub removes the credentials it reads, so a caller's key
or token never reaches your local server:

- by name: `Authorization`, `Proxy-Authorization` and every `X-Finch-*`
  header (which carry the service secret and the first-party assertion);
- by value: any other header whose value contains the exact bearer token
  presented in `Authorization` on that request (a client that copies its key
  into `X-Api-Key`, say). Other text that merely looks like a key, such as
  `Mcp-Name: finch_search`, is left alone.

Everything else passes through, including the whole `Cookie` header. That
includes the retired `__Host-finch_session` and `finch_session` cookies of the
removed browser login wall; the hub no longer reads or strips them, and they
expired within 12 hours of that feature's removal.

The hub then adds a short-lived ES256 **caller assertion**
(`X-Finch-Assertion`), which a service can verify against the hub's JWKS to
learn who is calling
([`worker/CALLER_ASSERTIONS.md`](../worker/CALLER_ASSERTIONS.md)), whenever
assertions are configured and the call was authenticated by:

- a `finch_` key on a key-gated service (`sub` is `key:<id>`);
- a Clerk OAuth token, on any service (`sub` is `user:<id>`); or
- the first-party `finch test` / `finch call` path (`sub` is
  `service:finch-dashboard`), on any service.

A public service therefore gets no assertion for a keyless call or a call
with a `finch_` key, but does get one when the caller signed in with OAuth or
used `finch test`. On a public service the OAuth check admits any user of the
hub's Clerk instance, not only the account owner, so the assertion there says
who called, not that they were allowed to. Treat an assertion as
authorization only on a key-gated service.

On your machine, the agent confines relayed paths to the service's base path
(`/mcp` by default, or the whole service with `forward_all`), collapses `.` and
`..` segments first, and builds the upstream URL from its own configuration,
never from the request.

### Web to hub

The web calls the hub over a Worker **service binding** (`FINCH_HUB`). Each
call carries the shared `FINCH_SERVICE_SECRET` and a short-lived assertion,
`{tenant, exp}` HMAC-signed with that same secret, naming the signed-in user's
account. The web builds the assertion from the signed-in Clerk user's own ID
and confirms with the hub that this user is the account's owner.

The assertion stops a caller without the secret from choosing an account; it
is no boundary for someone who has the secret. **`FINCH_SERVICE_SECRET` is a
fleet-wide credential.** The hub also accepts it on requests from the public
internet, not only over the binding, and whoever holds it can sign an
assertion for any account and use the control API as that account, sign CLI
tokens (they are HMAC-signed with the same secret, bound to a per-account
epoch), and relay calls to any account's services the way `finch test` does.
Keep it only in the hub's and web's Worker secrets, and rotate it on both
together if it may have leaked.

### Isolation between accounts

Account services live on sibling subdomains (`<slug>.finchmcp.com`), and a
public service can serve arbitrary HTML there. The web therefore:

- pins Clerk's `authorizedParties` to the exact app origin
  (`NEXT_PUBLIC_APP_ORIGIN`), so a session token minted on an account subdomain
  is rejected;
- pins Clerk's redirect allowlist to the app origin;
- denies framing (`frame-ancestors 'none'`, `X-Frame-Options: DENY`); and
- rejects cross-site mutations using `Sec-Fetch-Site` with an `Origin`
  fallback.

The hub sets no cookies on relay hosts and strips the `Domain` attribute from
any `Set-Cookie` your service sends, so cookies stay host-only.

### Limits

- The relay is rate limited per account and IP (600 requests per 60
  seconds). The limiter needs the account, so it runs after the host is
  resolved: a request on an account subdomain or custom hostname first looks
  the host up in the global `RouterDO`, and a host `RouterDO` does not know
  answers 404 without reaching the limiter. (A request on a host with no
  lookup key, such as `workers.dev` in single-account mode, skips `RouterDO`.)
  The limiter does run before the relay's `TenantDO` and `BoxDO` work: the
  machine pin check, the key check and the relay itself.
- `/join` and `/refresh` are limited per IP (10 per 60 seconds) before any
  Durable Object is touched; the CLI API has its own per-IP and per-account
  limits on the same binding.
- Request bodies are capped at 4 MiB. Responses stream with flow control; see
  [`relay-protocol.md`](relay-protocol.md).
- An unknown host fails closed with 404. The dev-only `DEFAULT_TENANT` fallback
  exists only when `DEV=1`.

## What is deployed

### Workers and storage

| Resource | Production name | Notes |
|---|---|---|
| Hub Worker | `finch-prod` | Needs Workers Paid (Durable Objects). |
| Web Worker | `finch-web-prod` | Binds `FINCH_HUB` to `finch-prod` and `WORKER_SELF_REFERENCE` to itself. |
| Durable Objects | `BoxDO`, `TenantDO`, `RouterDO` | SQLite-backed. Migrations are append-only; `deploy-preflight` refuses any edit to applied history. |
| R2 bucket | `finch-releases` | Agent binaries served at `/releases/<asset>`. Without the binding the hub redirects to the GitHub release instead. |
| Rate limits | `RELAY_LIMIT`, `JOIN_LIMIT` | `unsafe.bindings` of type `ratelimit`, repeated in every environment. |

### Hub configuration

| Name | Kind | What it does |
|---|---|---|
| `FINCH_SERVICE_SECRET` | secret | Shared with the web; authenticates web-to-hub calls and signs account assertions and CLI tokens. Fleet-wide: its holder can act for any account (see [Web to hub](#web-to-hub)). |
| `TICKET_SECRET` | secret | HMAC key for join tickets, refresh tokens and connect tokens. |
| `FINCH_ASSERTION_PRIVATE_JWKS` | secret | ES256 private JWKS for caller assertions. Generate with `worker/scripts/generate-assertion-jwks.mjs`. |
| `CF_API_TOKEN` | secret, optional | Cloudflare for SaaS token for bring-your-own custom hostnames. |
| `WEB_URL` | var | Web origin; the `finch login` approval page is `<WEB_URL>/cli`. |
| `CLERK_ISSUER` | var | Clerk frontend API origin. Turns on the MCP OAuth plane; unset turns it off. |
| `FINCH_ASSERTION_ACTIVE_KID` | var | Which key in the private JWKS signs. |
| `FINCH_ASSERTION_ISSUER` | var | `iss` of caller assertions and the origin that serves `/.well-known/finch-jwks.json`. |
| `VANITY_SUFFIXES`, `VANITY_TENANT` | var, optional | First-party hostname suffixes and the one account allowed to claim them. |
| `CF_SAAS_ZONE_ID`, `BYO_CNAME_TARGET` | var, optional | Zone and CNAME target for bring-your-own hostnames. |
| `RELEASES_BASE` | var, optional | Where `/releases/<asset>` redirects when there is no R2 binding. Defaults to the GitHub release. |
| `DEV`, `DEFAULT_TENANT`, `ALLOW_INSECURE_HTTP` | var, dev only | Local and staging conveniences; preflight refuses them in production. |

### Web configuration

| Name | Kind | What it does |
|---|---|---|
| `CLERK_SECRET_KEY` | secret | Clerk backend key (`sk_live_…` in production). |
| `FINCH_SERVICE_SECRET` | secret | Must equal the hub's. |
| `HUB_URL` | var | The hub origin the web addresses (the host the hub sees on binding calls). Must be https. |
| `NEXT_PUBLIC_APP_ORIGIN` | var | Exact web origin for Clerk `authorizedParties`; preflight refuses a wildcard. |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | var and build env | Clerk publishable key (`pk_live_…` in production). |
| `NEXT_PUBLIC_CLERK_SIGN_IN_URL`, `…_SIGN_UP_URL`, `…_FALLBACK_REDIRECT_URL` | var | Clerk routing. |

### Routes on finchmcp.com

| Pattern | Worker |
|---|---|
| `finchmcp.com/*` | web |
| `finchmcp.com/join*`, `/refresh*`, `/api/cli/*`, `/install*`, `/releases/*` | hub (more specific routes win over the web's catch-all) |
| `jwks.finchmcp.com/.well-known/finch-jwks.json` | hub (caller-assertion JWKS) |
| `*.finchmcp.com/*` | hub (account subdomains, and `hub.finchmcp.com`, which the web uses as `HUB_URL`) |

The `*.aviary.run/*` vanity route and the `*/*` catch-all that bring-your-own
hostnames need are commented out in `worker/wrangler.jsonc` until the deploy
token and Cloudflare for SaaS are set up for them.

## Environments

| Environment | Hub | Web | Host routing |
|---|---|---|---|
| `dev` | `finch-dev` | `finch-web-dev` | `wrangler dev` on localhost; `DEV=1` resolves every request to `DEFAULT_TENANT`. |
| `staging` | `finch-staging` | `finch-web-staging` | `workers.dev` hosts with `DEV=1` and a fixed staging account. |
| `production` | `finch-prod` | `finch-web-prod` | Real routes, `workers_dev: false`, fail-closed host resolution. |

Durable Object IDs are scoped to the Worker name, so each environment has its
own state. Secrets are set per environment with
`wrangler secret put <NAME> --env <env>`, never copied from `.dev.vars`.
Both `deploy-preflight` scripts refuse a production deploy that ships a
dev-only variable, a known dev secret value, a `pk_test_` Clerk key, a missing
or wildcard `NEXT_PUBLIC_APP_ORIGIN`, persistent invocation logs, or a missing
assertion signer. How code reaches each environment is in
[`releases.md`](releases.md).

## Accounts are single-user

An account is one Clerk user: its ID is that user's Clerk user ID and that user
is its only member. Clerk Organizations are not used. The relay admits a
`finch_` key whose scope covers the service, a Clerk OAuth token whose user is
the account owner, the first-party `/api/cli/call` assertion, or anyone on a
public service. A caller without a credential on a key-gated service gets a 401
with an OAuth challenge; there is no browser login wall or session cookie.

Accounts created before September 2026 are migrated once, lazily: the purge
runs when an account's `TenantDO` is first loaded after the single-user
release, so an account that has not been used since keeps its legacy rows
until then. What the migration deletes, and why it is lazy, is recorded in
[`archive/single-user-migration.md`](archive/single-user-migration.md).

## Known gaps

- **Not end-to-end encrypted.** Cloudflare terminates TLS and the relay
  handles plaintext while forwarding. See [`privacy.md`](privacy.md).
- **Custom hostnames are first-come.** Registering a hostname does not prove
  you own the domain; traffic only flows once its DNS points at finch. A
  design for ownership checks is in
  [`archive/hostname-ownership-design.md`](archive/hostname-ownership-design.md).
- **The last hop is yours.** The agent accepts a plaintext `http://` upstream
  whose host is loopback or a single DNS label (such as a Docker Compose
  service name). If that name resolves off the machine, the hop crosses your
  network unencrypted. Use `https://` for anything not on the machine.
