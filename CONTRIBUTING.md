# Contributing to finch

Thanks for helping. This file covers how to run each part locally, which tests
to run, and how changes get merged and released. For how the pieces fit
together, start with the [README](README.md) and [`docs/`](docs/README.md).

## What you need

- **Node 22** for the hub and the website (`.nvmrc`; the website's OpenNext
  build breaks on newer Node).
- **Go 1.26.4** for the CLI (`agent/go.mod`).
- **Python 3** to run the example MCP server.
- For the website: a free [Clerk](https://clerk.com) development instance.

## The three parts

| Part | Directory | Language |
|---|---|---|
| Hub: relay, auth, CLI API | `worker/` | TypeScript on Cloudflare Workers and Durable Objects |
| Website: landing, docs, sign-in, `finch login` approval | `web/` | Next.js via OpenNext on Cloudflare |
| CLI and relay agent | `agent/` | Go |

### Hub

```sh
cd worker
cp .dev.vars.example .dev.vars    # fill in throwaway values
npm ci
npm run dev                       # wrangler dev on http://localhost:8787
```

For a full local loop, also set in `worker/.dev.vars`:

- `WEB_URL="http://localhost:3000"`, so `finch login` sends you to your local
  website;
- `DEFAULT_TENANT` to your Clerk development user's ID (`user_…`). Locally
  every relayed request belongs to that account, and it must match the account
  you log the CLI in as.

### Website

```sh
cd web
cp .dev.vars.example .dev.vars    # Clerk dev keys; FINCH_SERVICE_SECRET must match the hub's
npm ci
npm run dev                       # next dev on http://localhost:3000
```

### CLI

```sh
cd agent
go build -o finch .
python3 ../examples/hello-mcp/server.py &          # an MCP server on :8000
./finch login --hub http://localhost:8787
./finch add hello --service http://127.0.0.1:8000
./finch run                                         # serve in the foreground
./finch test hello
```

Plain `http://` is accepted only for a loopback hub.

## Tests

Run the suites for every part you touched. CI runs all of them on each pull
request (the `versions`, `worker`, `web` and `agent` checks).

| Part | Commands |
|---|---|
| Repository | `node --test scripts/*.test.mjs && node scripts/check-versions.mjs && node scripts/check-assertion-vector-drift.mjs` |
| Hub | `cd worker && npm ci && npm test && npx tsc --noEmit && npm run privacy:check && npx wrangler deploy --dry-run --env production` |
| Website | `cd web && npm ci && npx vitest run && npx tsc --noEmit && npx eslint . && npx next build` |
| CLI | `cd agent && go build ./... && go vet ./... && go test -race ./... && go mod tidy && git diff --exit-code go.mod go.sum && test -z "$(gofmt -l .)"` |

Conventions the tests rely on:

- **A behaviour change comes with a test.** Tests drive real code against
  strict fakes: a fake hub, service manager or client that rejects input the
  real one would reject. A fake that accepts anything proves nothing.
- **Docs that show CLI commands are checked.** `agent/core/cli_docs_test.go`
  fails when `web/public/agents.md`, `web/public/llms.txt`, `finch guide` or
  `finch help` shows a flag the binary does not have. Update them together.
- **The relay wire format has golden vectors** in
  `worker/test/relay-vectors.json`, round-tripped by both the TypeScript and Go
  codecs. Change the vectors first.
- **The agent version lives in two places**, `agent/core/agent.go` and
  `worker/src/types.ts`; `scripts/check-versions.mjs` keeps them equal.

## Pull requests

1. Branch from `main`. Keep a pull request to one change you can describe in a
   sentence.
2. Stage files by name. Never commit binaries or build outputs; `git status`
   before committing.
3. Add a line under `Unreleased` in [`CHANGELOG.md`](CHANGELOG.md) for anything
   a user or self-hoster would notice.
4. Open the pull request against `main`. Describe what changed, why, and how you
   tested it; the template asks for each.

A merge to `main` deploys to staging. Maintainers promote to production with a
reviewed pull request from `main` to the `production` branch; see
[`docs/releases.md`](docs/releases.md).

### Writing for users

User-facing text (CLI output, errors, the website, docs) is plain, specific and
in the active voice, and names things the way users know them:

- **service**: something you publish with `finch add`. Not "app path", "rule"
  or "ingress" (those are `finch.yml` field names).
- **machine**: the computer running `finch`. Not "box", which is the code's
  name for it.
- **account address**: the `<slug>` in `https://<slug>.finchmcp.com`. Explain
  it once where it first appears.
- **finch**, lowercase.

## Releases

Agent releases are cut from a tag: bump the version in both files, move the
`Unreleased` changelog entries under the new version, merge, then push
`vX.Y.Z`. GoReleaser builds and publishes the binaries with grouped release
notes. The full steps are in [`docs/releases.md`](docs/releases.md).

## Security issues

Please report vulnerabilities privately; see [`SECURITY.md`](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
