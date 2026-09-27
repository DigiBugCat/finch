# Run your own finch

Status: **current** for finch 1.8. This guide deploys your own hub and website
on your own Cloudflare account and points the `finch` CLI at them. The website
at [finchmcp.com](https://finchmcp.com) runs the same code; you never need it
to self-host.

**Read this first.** A self-hosted finch today runs in **single-account
mode**: one hub hostname, and every service you publish lives under it, at
`https://finch.example.dev/<service>/mcp`. The layout finchmcp.com uses, where
each account gets its own subdomain (`<slug>.finchmcp.com`), is tied to the
`finchmcp.com` name in the code. Running it on another domain needs the code
changes listed in [`self-host-coupling.md`](self-host-coupling.md). Single-account
mode is how this repository's own staging deployment runs on the internet, so
it is exercised on every merge.

## What you deploy

```text
 your MCP client ── https://finch.example.dev/notes/mcp ──▶ hub Worker ◀══ WSS ══ finch on your machine
                                                              ▲
 you, signing in ── https://example.dev/cli ──▶ web Worker ───┘ (service binding)
                                                   │
                                                 Clerk (sign-in, and OAuth for MCP clients)
```

| Piece | What it is | Where it comes from |
|---|---|---|
| Hub | Cloudflare Worker with three Durable Objects. Relays calls, checks keys, runs the CLI's API, serves `/install`. | `worker/` |
| Website | Cloudflare Worker (Next.js via OpenNext). Sign-in and the `finch login` approval page, plus the landing page and docs. | `web/` |
| Clerk | Your sign-in provider, and the OAuth server for MCP clients that sign in instead of using a key. | clerk.com |
| Release binaries | What `/install` and `finch update` download. Either an R2 bucket you fill, or a redirect to this repository's GitHub releases. | GitHub releases or R2 |

## Before you start

- A Cloudflare account. finchmcp.com runs on Workers Paid ($5/month). The
  Durable Objects are SQLite-backed, which the free plan allows, but its daily
  request limits are low for a relay.
- Optionally, a domain on Cloudflare (this guide uses `example.dev`). Without
  one, both Workers can run on your `workers.dev` subdomain.
- A Clerk account.
- Node 22 and `npx wrangler login` done once.
- A clone of this repository, checked out at a release tag, so the hub's
  version matches the published binaries:

  ```sh
  git clone https://github.com/DigiBugCat/finch && cd finch
  git checkout v1.8.0
  ```

Pick two hostnames: one for the hub (`finch.example.dev`) and one for the
website (`example.dev`). This guide uses Workers Custom Domains, which create
the DNS record and certificate for you, so single-account mode needs no
wildcard DNS.

## 1. Set up Clerk

1. Create a Clerk application. A **development instance** is the simplest
   choice for one person: it works on any origin, including `workers.dev`, and
   shows a small development banner. A production instance needs DNS records
   on your domain, and see the Clerk note under
   [Known limitations](#known-limitations).
2. Restrict who can sign up (in Clerk: **Configure → Restrictions**, allowlist
   your email or turn sign-ups off). Anyone who can sign in can log a CLI in,
   and in single-account mode their services would never be reachable anyway.
3. Create your user (**Users → Create user**) and copy its ID (`user_…`). This
   is your finch account ID.
4. For MCP clients that sign in with OAuth instead of a key (such as claude.ai
   custom connectors): open **Configure → OAuth applications**, turn on
   **dynamic client registration**, and set the default scopes for
   dynamically registered clients to `openid email profile`. Clients that
   register without asking for scopes get these defaults. (Clerk's labels move
   around; the settings are what matter.)
5. Note three values from **API keys**: the publishable key (`pk_…`), the
   secret key (`sk_…`), and the **Frontend API URL**
   (`https://<something>.clerk.accounts.dev` on a development instance).

## 2. Configure the hub

Add an environment to `worker/wrangler.jsonc`, next to `staging` and
`production`. Copy the whole block below (wrangler does not inherit
bindings, migrations or rate limits into environments, so every one is
repeated) and replace the example values.

```jsonc
"selfhost": {
  "name": "finch-selfhost",
  "workers_dev": false,
  "routes": [{ "pattern": "finch.example.dev", "custom_domain": true }],
  "observability": { "enabled": false },
  "logpush": false,
  "vars": {
    // Single-account mode: every request on the hub host is your account.
    "DEV": "1",
    "DEFAULT_TENANT": "user_REPLACE_WITH_YOUR_CLERK_USER_ID",
    "WEB_URL": "https://example.dev",
    "CLERK_ISSUER": "https://REPLACE.clerk.accounts.dev",
    // Caller assertions (optional; remove both lines to turn them off).
    "FINCH_ASSERTION_ACTIVE_KID": "selfhost-2026-09",
    "FINCH_ASSERTION_ISSUER": "https://finch.example.dev",
    // Without an R2 bucket, pin downloads to the release you checked out.
    "RELEASES_BASE": "https://github.com/DigiBugCat/finch/releases/download/v1.8.0"
  },
  "services": [{ "binding": "SELF", "service": "finch-selfhost" }],
  "durable_objects": {
    "bindings": [
      { "name": "BOX", "class_name": "BoxDO" },
      { "name": "TENANT", "class_name": "TenantDO" },
      { "name": "ROUTER", "class_name": "RouterDO" }
    ]
  },
  "unsafe": {
    "bindings": [
      { "name": "RELAY_LIMIT", "type": "ratelimit", "namespace_id": "2001", "simple": { "limit": 600, "period": 60 } },
      { "name": "JOIN_LIMIT", "type": "ratelimit", "namespace_id": "2002", "simple": { "limit": 10, "period": 60 } }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["ApplianceDO"] },
    { "tag": "v2", "new_sqlite_classes": ["TenantDO"] },
    { "tag": "v3", "new_sqlite_classes": ["RouterDO"] },
    { "tag": "v4", "renamed_classes": [{ "from": "ApplianceDO", "to": "BoxDO" }] },
    { "tag": "v5", "new_sqlite_classes": ["AviaryEnrollmentDO"] },
    { "tag": "v6", "new_sqlite_classes": ["DirectoryDO"] },
    { "tag": "v7", "deleted_classes": ["AviaryEnrollmentDO", "DirectoryDO"] }
  ]
}
```

No domain? Remove `routes` and set `workers_dev` to `true`. The hub is then
`https://finch-selfhost.<your-subdomain>.workers.dev`; use that wherever this
guide says `https://finch.example.dev`. The website works the same way.

Keep the migrations exactly as they are: they are append-only history, and
`deploy-preflight` refuses any other list. (v5 and v6 created two classes that
v7 deletes; on a new Worker they leave nothing behind.)

`DEV=1` is what turns on single-account mode. It does not relax
authentication: keys, OAuth and connect tokens are checked exactly as in
production. Besides the account fallback and printing URLs on the hub host, the
only thing it unlocks is `ALLOW_INSECURE_HTTP`, which you must never set on a
public hub.

### Hub settings

| Name | Kind | Required | What it does |
|---|---|---|---|
| `DEV` | var | yes (`"1"`) | Turns on single-account mode: requests on the hub host resolve to `DEFAULT_TENANT`, and the URLs finch prints use the hub host. |
| `DEFAULT_TENANT` | var | yes | Your Clerk user ID. Every relayed call on the hub host belongs to this account. |
| `WEB_URL` | var | yes | Your website origin. `finch login` sends you to `<WEB_URL>/cli`. |
| `CLERK_ISSUER` | var | for OAuth | Clerk's Frontend API URL. Turns on OAuth sign-in for MCP clients; leave it out and only `finch_` keys work. |
| `FINCH_SERVICE_SECRET` | secret | yes | Shared with the website. Authenticates website-to-hub calls and signs CLI tokens. |
| `TICKET_SECRET` | secret | yes | Signs join tickets, refresh tokens and connect tokens for your machines. |
| `FINCH_ASSERTION_PRIVATE_JWKS` | secret | optional | ES256 key that signs `X-Finch-Assertion`, the caller identity your services can verify. Set it together with `FINCH_ASSERTION_ACTIVE_KID` and `FINCH_ASSERTION_ISSUER`, or leave all three out. |
| `FINCH_ASSERTION_ACTIVE_KID` | var | with the JWKS | Which key in the JWKS signs. |
| `FINCH_ASSERTION_ISSUER` | var | with the JWKS | The `iss` of assertions; the hub serves the public keys at `<issuer>/.well-known/finch-jwks.json`. Use the hub origin. |
| `RELEASES` | R2 binding | optional | Bucket the hub serves `/releases/<asset>` from. |
| `RELEASES_BASE` | var | optional | Where `/releases/<asset>` redirects when there is no bucket. Defaults to this repository's latest GitHub release. |
| `SELF` | service binding | yes | The hub bound to itself, used by `finch test` and `finch call`. |
| `RELAY_LIMIT`, `JOIN_LIMIT` | rate limit | recommended | Per-IP limits on the relay and on `/join`. `namespace_id` must be unique in your Cloudflare account. |
| `VANITY_SUFFIXES`, `VANITY_TENANT`, `CF_SAAS_ZONE_ID`, `CF_API_TOKEN`, `BYO_CNAME_TARGET` | vars and secret | no | Custom hostnames (`finch domain add`). Not needed in single-account mode. |

Set the secrets. Generate fresh values; never reuse the ones in `.dev.vars`.

```sh
cd worker
npm ci
SERVICE_SECRET="$(openssl rand -hex 32)"    # the website needs this value too
printf %s "$SERVICE_SECRET" | npx wrangler secret put FINCH_SERVICE_SECRET --env selfhost
openssl rand -hex 32 | npx wrangler secret put TICKET_SECRET --env selfhost
# Optional caller assertions (the kid must match FINCH_ASSERTION_ACTIVE_KID):
node scripts/generate-assertion-jwks.mjs selfhost-2026-09 \
  | node scripts/validate-assertion-jwks.mjs selfhost-2026-09 --passthrough \
  | npx wrangler secret put FINCH_ASSERTION_PRIVATE_JWKS --env selfhost
```

Deploy the website from the same shell so `$SERVICE_SECRET` is still set, or
keep the value in a password manager until then.

### Release binaries

Pick one:

- **Use this repository's releases** (simplest). Leave out the `RELEASES`
  binding and set `RELEASES_BASE` to the release you checked out, as in the
  block above. The installer still verifies each binary against the release's
  `checksums.txt`.
- **Serve them from R2.** Create a bucket, upload the six `finch-*` binaries
  and `checksums.txt` from the release, and bind it:

  ```sh
  npx wrangler r2 bucket create finch-releases-selfhost
  gh release download v1.8.0 --repo DigiBugCat/finch --dir release
  for f in release/*; do
    npx wrangler r2 object put "finch-releases-selfhost/$(basename "$f")" --file "$f" --remote
  done
  ```

  and add `"r2_buckets": [{ "binding": "RELEASES", "bucket_name": "finch-releases-selfhost" }]`
  to the `selfhost` block.

Either way the hub's version (`LATEST_AGENT`) comes from the code you deploy,
so deploy a release tag and serve that tag's binaries.

### Deploy the hub

```sh
node scripts/deploy-preflight.mjs selfhost
npx wrangler deploy --env selfhost
```

## 3. Configure and deploy the website

Add the matching environment to `web/wrangler.jsonc`:

```jsonc
"selfhost": {
  "name": "finch-web-selfhost",
  "workers_dev": false,
  "routes": [{ "pattern": "example.dev", "custom_domain": true }],
  // Keeps nothing: no logs, no invocation logs, no traces. (The web preflight
  // wants this shape for any environment not named staging or production.)
  "observability": {
    "enabled": true,
    "logs": { "enabled": false, "invocation_logs": false },
    "traces": { "enabled": false }
  },
  "logpush": false,
  "services": [
    { "binding": "WORKER_SELF_REFERENCE", "service": "finch-web-selfhost" },
    { "binding": "FINCH_HUB", "service": "finch-selfhost" }
  ],
  "vars": {
    "HUB_URL": "https://finch.example.dev",
    "NEXT_PUBLIC_APP_ORIGIN": "https://example.dev",
    "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY": "pk_REPLACE",
    "NEXT_PUBLIC_CLERK_SIGN_IN_URL": "/sign-in",
    "NEXT_PUBLIC_CLERK_SIGN_UP_URL": "/sign-up",
    "NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL": "/docs",
    "NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL": "/docs"
  }
}
```

| Name | Kind | What it does |
|---|---|---|
| `HUB_URL` | var | Your hub origin. The website reaches the hub over the `FINCH_HUB` service binding; this is the address it uses on those calls. Must be https. |
| `FINCH_HUB` | service binding | The hub Worker. Deploy the hub first so it exists. |
| `NEXT_PUBLIC_APP_ORIGIN` | var | Your website's exact origin. Clerk session tokens minted anywhere else are refused. |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | var and build env | Clerk publishable key. |
| `NEXT_PUBLIC_CLERK_SIGN_IN_URL` and the other `NEXT_PUBLIC_CLERK_*` URLs | var | Where Clerk's pages live and where sign-in lands. |
| `CLERK_SECRET_KEY` | secret | Clerk secret key. |
| `FINCH_SERVICE_SECRET` | secret | The same value as the hub's. |

Set the secrets, build and deploy (the build inlines the publishable key, so it
must be in the environment too):

```sh
cd ../web    # from worker/
npm ci
npx wrangler secret put CLERK_SECRET_KEY --env selfhost
printf %s "$SERVICE_SECRET" | npx wrangler secret put FINCH_SERVICE_SECRET --env selfhost   # the hub's value
node scripts/deploy-preflight.mjs selfhost
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_REPLACE npx opennextjs-cloudflare build --env selfhost
npx opennextjs-cloudflare deploy -- --env selfhost
```

## 4. Point the CLI at your hub

On the machine that runs your MCP server:

```sh
curl -fsSL https://finch.example.dev/install | sh
finch login --hub https://finch.example.dev
```

`finch login` opens your website's `/cli` page; sign in and approve the code.
The CLI saves the hub in `~/.finch/cli.json`, and `finch add` writes it into
`finch.yml`, so later commands use it without `--hub`. Setting
`FINCH_HUB=https://finch.example.dev` works too. From here the normal flow
applies:

```sh
finch add notes --service http://127.0.0.1:8000
finch service install
finch test notes
finch connect notes --client claude-code
```

## 5. Check that it works

| Check | Expect |
|---|---|
| `curl https://finch.example.dev/api/version` | `{"latest":"1.8.0"}` (the version you deployed) |
| `curl -fsSL https://finch.example.dev/install \| grep '^HUB='` | `HUB="https://finch.example.dev"` |
| `finch login --hub https://finch.example.dev` | Opens `https://example.dev/cli`; approving it logs the CLI in |
| `finch add hello --service http://127.0.0.1:8000` (with `python3 examples/hello-mcp/server.py` running) | Prints `https://finch.example.dev/hello/mcp` |
| `finch test hello` | Lists the server's tools |
| `curl -i https://finch.example.dev/hello/mcp` | `401` with a `WWW-Authenticate: Bearer` challenge |
| `curl https://finch.example.dev/.well-known/oauth-protected-resource/hello/mcp` | `authorization_servers` is your Clerk Frontend API URL |
| `curl https://finch.example.dev/.well-known/finch-jwks.json` (if you set up assertions) | A JWKS with your `kid` |

## Updating

Check out the new release tag, then deploy the hub before the website:

```sh
git fetch --tags && git checkout v1.9.0
(cd worker && npm ci && node scripts/deploy-preflight.mjs selfhost && npx wrangler deploy --env selfhost)
(cd web && npm ci && node scripts/deploy-preflight.mjs selfhost \
  && NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_REPLACE npx opennextjs-cloudflare build --env selfhost \
  && npx opennextjs-cloudflare deploy -- --env selfhost)
```

Update `RELEASES_BASE` (or your R2 bucket) to the new tag first, then run
`finch update` on each machine. Read [`CHANGELOG.md`](../CHANGELOG.md) before
upgrading.

## Known limitations

These come from an audit of every `finchmcp.com` reference in `worker/`,
`web/` and `agent/`. The code changes that would remove them are listed in
[`self-host-coupling.md`](self-host-coupling.md).

- **One account per hub.** Single-account mode routes every request on the
  hub host to `DEFAULT_TENANT`. Per-account subdomains on your own domain need
  code changes: the hub only recognizes `<slug>.finchmcp.com` as an account
  subdomain, stores new accounts' hosts as `<slug>.finchmcp.com`, and hands
  machines a `wss://<slug>.finchmcp.com/…` relay URL outside `DEV=1`.
- **The website's content points at finchmcp.com.** The landing page, docs,
  `/agents.md`, `/llms.txt`, the agent prompt and the install line all name
  `finchmcp.com`. Your deployment serves them unchanged, so a visitor or
  agent following them ends up on finchmcp.com. Edit them in your fork, or
  tell people to use your hub's `/install` and `--hub`.
- **Clerk production keys pin sign-in redirects to finchmcp.com.** With a
  `pk_live_` key, `web/app/layout.tsx` sets Clerk's redirect allowlist to
  `https://finchmcp.com`. Use a development instance, or change that literal
  to your origin in your fork. (`web/middleware.ts` has the same fallback, but
  only when `NEXT_PUBLIC_APP_ORIGIN` is unset.)
- **The installer's closing hints assume finchmcp.com.** It prints
  `finch login` without `--hub` and points at `https://finchmcp.com/agents.md`.
  Pass `--hub` yourself.
- **The CLI defaults to finchmcp.com** whenever it has no saved login, no
  `hub:` in `finch.yml`, no `FINCH_HUB` and no `--hub`. `finch enroll` ignores
  `FINCH_HUB` and needs `--hub`.
- **Binaries come from this repository** unless you build and publish your
  own (GoReleaser config in `.goreleaser.yaml`); a build from a fork keeps
  finchmcp.com as its default hub.
- **Deploy tooling is finchmcp.com-specific.** `worker/scripts/deploy-preflight.mjs`
  requires the `production` environment's assertion issuer to be
  `https://jwks.finchmcp.com`, and `.github/workflows/deploy.yml` smoke-tests
  finchmcp.com and the maintainers' staging URL. Use your own environment
  name (as above) and your own pipeline.
- **Custom hostnames** (`finch domain add`) need Cloudflare for SaaS on your
  zone, `CF_API_TOKEN`, `CF_SAAS_ZONE_ID` and a catch-all Worker route. They are
  first-come and not ownership-checked.
- **`finch test` borrows an internal name.** Each account is given a slug when
  it is created, and `finch test` routes through it as `<slug>.finchmcp.com`
  over the `SELF` binding, which needs no DNS. It works, but the name can show
  up in hub-side records.
