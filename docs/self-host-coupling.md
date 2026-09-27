# Self-hosting: where finchmcp.com is hard-coded

Status: **current** (audited 2026-09-27 against `main` at finch 1.7.1, with the
1.8.0 changes in flight). A checklist of the code changes needed before finch
can run with per-account subdomains on a second domain (`<slug>.example.dev`).
Until they land, self-hosting uses single-account mode; see
[`self-host.md`](self-host.md).

Found with:

```sh
grep -rn 'finchmcp\.com\|aviary\.run\|pantainos' worker/src worker/scripts agent web \
  --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=.open-next
```

The suggested shape is one setting per side: a hub variable (say
`FINCH_DOMAIN=example.dev`) read everywhere the hub builds or parses an
account host, a build-time default hub for the CLI (stamped with `-ldflags -X`
like `agentVersion`), and a site origin for the web read from
`NEXT_PUBLIC_APP_ORIGIN`.

## Hub (`worker/`): required for a second domain

- [ ] `src/index.ts` `hostKeyFromHost`: treats only `finchmcp.com` and
  `www.finchmcp.com` as the apex and only `<label>.finchmcp.com` as an account
  subdomain. On another domain every `<slug>.example.dev` is looked up as a
  custom hostname and fails with 404. It needs the configured domain (it is
  called without `env` today, from `index.ts` and `api.ts`).
- [ ] `src/tenant-do.ts` `ensureDefaultSlug` and `updateSetting("subdomain")`:
  store the account host as `` `${slug}.finchmcp.com` ``. That host feeds the
  relay URL machines dial (`connectUrl`), the service URLs `finch add` and
  `finch connect` print, and `serviceBase`. Hosts already stored in account
  state need a migration or a read-time rewrite.
- [ ] `src/api.ts` `relayOriginForTenant`: builds `` `${k}.finchmcp.com` `` for
  `finch test` and `finch call`.
- [ ] `src/router-do.ts` `isValidHostKey` and `src/api.ts` custom-hostname
  registration: reserve the `finchmcp.com` family (so nobody registers
  `x.finchmcp.com` as a custom hostname). The reserved family must follow the
  configured domain.
- [ ] Reserve the labels the deployment itself uses (`www`, `hub`, `jwks`)
  so they can never become account slugs. Today `www` is special-cased in
  `hostKeyFromHost`; `hub` and `jwks` are safe only because generated slugs
  never produce them.
- [ ] `scripts/deploy-preflight.mjs`: requires the `production` environment's
  `FINCH_ASSERTION_ISSUER` to be `https://jwks.finchmcp.com` and its routes to
  include `jwks.finchmcp.com/.well-known/finch-jwks.json`. A fork that edits
  `production` for its own domain cannot pass preflight. Derive both from the
  configured domain or a var.

## Hub (`worker/`): defaults and copy

- [ ] `src/api.ts` `DEFAULT_BYO_CNAME_TARGET = "finchmcp.com"`. Overridable
  with `BYO_CNAME_TARGET`; the default should follow the domain.
- [ ] `src/install-script.ts`: the closing hint points at
  `https://finchmcp.com/agents.md`, and the "Next:" lines print `finch login`
  without `--hub`. When the script is served from a hub other than the CLI's
  default, print `finch login --hub <that hub>` and `<that hub>`'s agents.md.
- [ ] `src/index.ts` `DEFAULT_RELEASES_BASE` redirects to this repository's
  GitHub releases. Fine for most self-hosters; overridable with
  `RELEASES_BASE`.
- [ ] `src/index.ts` the hub root answers `finch hub — https://finchmcp.com`.
- [ ] `wrangler.jsonc`: the `production` and `staging` environments carry
  the maintainers' Worker names, routes, zone, Clerk issuer, account IDs
  (`DEFAULT_TENANT`, `VANITY_TENANT`), `CF_SAAS_ZONE_ID`, R2 bucket and
  `pantainos.workers.dev` URLs. Expected per deployment; self-hosters add their
  own environment instead of editing these.
- [ ] Comments across `src/` describe hosts as `<slug>.finchmcp.com`
  (`types.ts`, `index.ts`, `api.ts`, `router-do.ts`, `box-do.ts`,
  `tenant-do.ts`). Cosmetic.

## CLI (`agent/`)

The CLI already honours `--hub`, `FINCH_HUB`, the hub saved by `finch login`
in `~/.finch/cli.json`, and `hub:` in `finch.yml`. What remains:

- [ ] One default hub literal instead of seven: `core/agent.go`
  (`agentDefaultHub`, and `loadConfig`'s default), `core/relay_loop.go`
  (`relayOptions.hub`), `core/transport_security.go`
  (`validateHubTransportURL`), `core/cli_update.go` (fallback when there is no
  login), and `core/cli.go` `runEnroll`. Make it a variable stamped at build
  time so a fork's binaries default to its own hub.
- [ ] `core/cli.go` `runEnroll`: its `--hub` default is the literal and ignores
  `FINCH_HUB`; use `agentDefaultHub()`.
- [ ] Install hints in errors: `core/cli_update.go` and `core/cli_service.go`
  print `curl -fsSL https://finchmcp.com/install | sh`. Use the current hub.
- [ ] Help and guide text: `core/cli.go` (`guideText`, the `finch add` usage
  line) name `finchmcp.com` and `https://finchmcp.com/agents.md`.
- [ ] The launchd label `com.finchmcp.finch` (`core/cli_service.go`). Harmless;
  only matters if two differently built CLIs share a machine.
- [ ] `README.md`, `finch.example.yml` and `Dockerfile` examples use
  `https://finchmcp.com`. Documentation only.

## Web (`web/`)

- [ ] `app/layout.tsx` `allowedRedirectOrigins`: with a `pk_live_` Clerk key it
  returns `["https://finchmcp.com"]`, so sign-in redirects on another domain
  are refused. Read `NEXT_PUBLIC_APP_ORIGIN`, as the middleware already does.
- [ ] `app/layout.tsx` `metadataBase` and Open Graph `url` are
  `https://finchmcp.com`. Read the same origin.
- [ ] `middleware.ts` `authorizedParties`: falls back to
  `https://finchmcp.com` for a `pk_live_` key when `NEXT_PUBLIC_APP_ORIGIN` is
  unset. Already safe when the var is set (preflight requires it in
  production); the fallback should not name a domain.
- [ ] `scripts/deploy-preflight.mjs`: any environment not named `staging` or
  `production` must have observability *enabled* with invocation logs and
  traces off; `enabled: false` (which keeps even less) is refused. Accept both.
- [ ] Site content: `components/fieldguide/prompt.ts` (`AGENT_PROMPT`,
  `INSTALL_ONE_LINER`), `HeroPlate.tsx`, `BandPlate.tsx`, `GateDial.tsx`,
  `AgentSession.tsx`, `PricingPlate.tsx`, every page under `app/docs/`,
  `public/agents.md`, `public/llms.txt` and `public/aviarymcp-llms.txt` name
  `finchmcp.com`. A self-hosted site sends visitors and agents to finchmcp.com.
  Render them from one site-origin constant.
- [ ] `wrangler.jsonc`: `production` and `staging` carry the maintainers'
  hub URLs, origin, Clerk keys and routes. Expected per deployment.

## Repository automation

- [ ] `.github/workflows/deploy.yml` smoke-tests
  `https://jwks.finchmcp.com/.well-known/finch-jwks.json` and
  `https://finch-staging.pantainos.workers.dev`.
- [ ] `.github/workflows/release.yml` mirrors binaries into the
  `finch-releases` R2 bucket of the maintainers' account.
- [ ] `.goreleaser.yaml` release notes print
  `curl -fsSL https://finchmcp.com/install | sh`. Correct for this repository's
  releases.
