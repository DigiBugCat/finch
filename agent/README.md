# finch agent (`agent/`)

The box-side CLI and daemon, for macOS and Linux. It runs on any always-on box
(Mac mini, Raspberry Pi, old laptop), **dials out** to the finch hub over a
single WebSocket, and relays each request the hub sends down to your local
service(s). finch is a protocol-agnostic tunnel — the service can be an MCP
server, a website, or any HTTP/WebSocket app. Nothing listens on the box; no
ports are opened.

A single Go binary with a few subcommands. It is built to be driven end to end
by an AI agent: every command is non-interactive and supports `--json`, and
`finch guide` prints a complete operating manual an agent can follow.

| Command | What it does |
|---|---|
| `finch version [--json]` | Print this binary's version and platform; JSON is a stable SDK/automation contract. |
| `finch login` | Log in to your tenant: prints a link + code to approve on any device (like `gh auth login`). |
| `finch add <app_path> --service <url>` | Enroll a service and append an `ingress` rule to `finch.yml`. |
| `finch run` | Serve every rule in `finch.yml` — dials out, auto-approves, holds the relay open. |
| `finch enroll <app_path> --ticket -` | One time, on a box with no CLI login: trade a one-shot join ticket (stdin, or `FINCH_TICKET`) for a saved credential. A logged-in box uses `finch add`. |
| `finch status` | Am I logged in (which tenant)? What does `finch.yml` serve? |
| `finch fleet` (alias `ls`) | List this account's services + state. |
| `finch test <service>` | List a service's MCP tools (does-it-work check). |
| `finch call <service> <tool> [--args '{…}']` | Invoke one tool through the hub. |
| `finch keys [list \| mint <label> --service <id> \| revoke <id>]` | Manage the client `finch_` keys callers present (grant + revoke access). |
| `finch auth <app_path> public\|key` | Serve a service with no auth, or require a `finch_` key (the default). |
| `finch domain [ls \| add <hostname> \| rm <hostname>]` | Manage custom hostnames. |
| `finch token` | Mint a fresh CLI token — provision a new box with no browser. |
| `finch approve <path>` | Approve a service (clear the pending gate). Usually automatic. |
| `finch rm <service>` | Remove a service. |
| `finch update` | Self-update this binary and restart the serve cleanly. |
| `finch revoke-tokens` | De-authorize every CLI login (including this box). |
| `finch guide` | The full agent operating manual. |
| `finch help` | Command overview, first-time setup, and worked automation examples. |

Because the CLI token is a tenant-admin credential, an agent can run the whole
loop — introspect, serve, test, and grant/revoke access — from the command line.

`finch version --json` is the stable local-binary identity contract used by
SDKs and deployment checks:

```json
{"schema_version":1,"product":"finch","version":"1.6.0","os":"linux","arch":"amd64"}
```

`version` is the stamped Finch release version without a leading `v`; `os` and
`arch` use Go's platform names. Existing schema-1 fields will not be removed or
change meaning.

## Quick start

```bash
# 1. install (or `go build -o finch .` from this directory)
curl -fsSL https://finchmcp.com/install | sh

# 2. log in — prints https://<hub>/cli?code=WXYZ-1234 ; approve it on any device
finch login --hub https://finchmcp.com

# 3. expose a local service (running on :8000) as the service "printer"
finch add printer --service http://127.0.0.1:8000

# 4. serve it — prints the public URL, e.g. https://<slug>.finchmcp.com/printer/
finch run
```

`finch add` writes/extends `finch.yml`; `finch run` serves it. Add more
services with more `finch add` calls — one process fronts them all.

## Provision a new box from an already-authed one (no human)

```bash
# on the authed box, mint a token and pipe it to the new box over SSH.
# `--token -` reads stdin, so this tenant-admin token never reaches the remote
# argv (/proc/<pid>/cmdline, world-readable) or either shell's history:
finch token | ssh user@newbox "finch login --token -"
ssh user@newbox "finch add api --service http://127.0.0.1:9000 && finch run"
```

`finch token` mints a fresh, epoch-bound CLI token (revocable via `finch
revoke-tokens`). The human approval only exists for your very first box; after
that every box is a scripted one-liner.

## `finch.yml` — the manifest (cloudflared-style)

One `finch run` serves many local services, each as its own service, over one
outbound link. The manifest holds **no secrets** — it's a pure wiring table of
`app_path → service`. See [`finch.example.yml`](finch.example.yml).

```yaml
hub: https://finchmcp.com        # default; omit for prod
box: mac-mini                # this box's name (default: hostname)
credentials-dir: ~/.finch        # where `finch add` writes per-app credentials

# Each rule forwards one local service.
#   app_path → the public URL segment: https://<your-slug>.finchmcp.com/<app_path>/
#              (and the service id). By default finch forwards only
#              …/<app_path>/mcp (it's an MCP tunnel first). Set forward_all: true
#              (or point service at a base path) to forward the whole subtree — for
#              a website or any non-MCP HTTP app.
ingress:
  - app_path: printer
    service: http://127.0.0.1:8000
  - app_path: transcribe
    service: http://127.0.0.1:8001
  - app_path: www                    # a plain website needs the whole subtree
    service: http://127.0.0.1:3000
    forward_all: true
```

`finch run` looks for the manifest in the working directory, then
`~/.finch/finch.yml`, then `~/.config/finch/finch.yml` (or pass `--config`).
Enrollment is a separate one-time step that keeps secrets out of the manifest:
`finch add` (or `finch enroll --ticket` on a box with no CLI login) trades a
one-shot ticket for a refresh credential under `credentials-dir/`. On later runs the agent resumes from that credential. If a
rule has no credential yet, or the hub rejects it (the service was removed or
revoked), that rule waits — without calling the hub — until `finch add` writes
a new one; its siblings keep serving.

## Docker

The agent runs as a container too — a tunnel sidecar next to your MCP server.
All state (login, credentials, `finch.yml`) lives under `/data`, so one volume
persists everything:

```bash
docker build -t finch-agent ./agent
docker run --rm -it -v finch-data:/data finch-agent login --hub https://finchmcp.com --headless
docker run --rm -v finch-data:/data finch-agent add hello --service http://host.docker.internal:8000
docker run -d --restart unless-stopped -v finch-data:/data finch-agent   # = finch run
```

The image's entrypoint is the `finch` binary (default command `run`), so any
subcommand works via `docker run`. For the full sidecar pattern — agent + MCP
server as compose services, enrolled by compose DNS name — see
[`examples/docker-compose/`](../examples/docker-compose/). Inside a container,
upgrade by rebuilding/pulling the image, not `finch update`.

## Auth & credentials

- **`finch login`** saves a long-lived **CLI token** (a tenant-admin credential,
  ~30 days) to `~/.finch/cli.json` (`0600`). On a box without a browser, use
  `finch login --headless` and approve on your phone, or pipe a token from a
  logged-in box (`finch token | ssh box 'finch login --token -'`).
  `FINCH_CLI_TOKEN` in the environment works too. Passing the token as an
  argument still works but warns — argv is world-readable and persists in shell
  history.
- **`finch add`** uses that token to enroll services.
- **`finch run`** holds the relay open and **auto-approves** the services it
  serves when you're logged in (the CLI-token holder is the tenant admin). If
  you're not logged in, approve with `finch approve <app_path>` from a box that is.
- Per-service **refresh credentials** live under `credentials-dir/` and survive
  restarts/reboots — "authenticate once", like ngrok's authtoken.
- Callers reach a service with a `finch_` key (`finch keys mint`), through
  OAuth (MCP clients such as claude.ai custom connectors sign in to finch), or
  with no auth at all after `finch auth <app_path> public`.

## Single-service mode (existing installs)

Boxes enrolled with the original one-liner run a single service straight from
flags, with no manifest:

```bash
finch join --hub https://finchmcp.com --upstream http://127.0.0.1:8000
```

It resumes from `--state` (default `~/.finch/agent.json`). `--ticket` (or
`FINCH_TICKET`, or `--ticket -` on stdin) is still accepted so those command
lines keep working after an update; a ticket only matters on first join. New
boxes should use `finch add` + `finch run`.

If the hub revokes a single-service credential, recover with `finch login` and
`finch add <app_path> --service <url>`. The running process notices the new
`finch.yml` and switches to serving it, with no restart.

## Flags (run / join)

| Flag | Default | What |
|---|---|---|
| `--hub` | `https://finchmcp.com` (or `$FINCH_HUB`) | finch hub base URL |
| `--config` | `finch.yml` (auto-detected) | manifest to serve (`finch run`) |
| `--box` | hostname (or `$FINCH_BOX`) | this box's name |
| `--upstream` | `http://127.0.0.1:8000` | local service (single-service mode) |
| `--state` | `~/.finch/agent.json` | persisted per-box refresh credential (single-service mode) |
| `--ticket` | — | one-shot enrollment ticket (single-service mode, first run only) |
| `--forward-all` | off | forward the whole loopback host, not just `/mcp` (single-service mode) |

## How it relays

On connect the agent dials `wss://<hub>/<service>/<box>/_connect?ct=<token>`
and parks the socket. For each request frame the hub sends, the agent forwards
it to the matching local `service`, streams the response back (`head` →
`chunk…` → `end`), and confines forwarded paths to `/mcp` by default (or the
service's base path; `forward_all` / `--forward-all` opts out to the whole host) —
an SSRF guard. The caller's `finch_` key never reaches your box — the hub strips it.

## Build / test

```bash
go build -o finch .         # local binary
go test ./...               # unit + golden relay-vector tests
go vet ./...
```

Release binaries (macOS/Linux × amd64/arm64, plus Linux armv6/armv7) are cut by
GoReleaser on a `v*` tag and fetched by the `curl | sh` installer.
