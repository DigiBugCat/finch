# finch agent (`agent/`)

The box-side daemon. It runs on any always-on box (Mac mini, Raspberry Pi,
old laptop), **dials out** to the finch hub over a single WebSocket, and relays
each request the hub sends down to your local service(s). finch is a
protocol-agnostic tunnel — the service can be an MCP server, a website, or any
HTTP/WebSocket app. Nothing listens on the box; no ports are opened.

A single Go binary with a few subcommands:

| Command | What it does |
|---|---|
| `finch login` | Log in to your tenant via the browser (like `gh auth login`). |
| `finch add <app_path> --service <url>` | Enroll a service and append an `ingress` rule to `finch.yml`. |
| `finch enroll <app_path> --ticket <t>` | Save a box-side credential from a dashboard ticket (one time; no CLI login needed). |
| `finch run` | Serve every rule in `finch.yml` — dials out, auto-approves, holds the relay open. |
| `finch status` | Am I logged in (which tenant)? What does `finch.yml` serve? |
| `finch fleet` (alias `ls`) | List this account's services + state. |
| `finch test <service>` | List a service's MCP tools (does-it-work check). |
| `finch call <service> <tool> [--args '{…}']` | Invoke one tool through the hub. |
| `finch keys [list \| mint <label> --service <id> \| revoke <id>]` | Manage the client `finch_` keys callers present (grant + revoke access). |
| `finch token` | Mint a fresh CLI token — provision a new box with no browser. |
| `finch approve <path>` | Approve a service (clear the pending gate). Usually automatic. |
| `finch rm <service>` | Remove a service. |
| `finch revoke-tokens` | De-authorize every CLI login (including this box). |
| `finch join --ticket … --upstream …` | Legacy single-service mode straight from flags (no config file). |
| `finch help` | Command overview, first-time setup, and the **agent/automation** guide. |

Every command is non-interactive and supports `--json`. Because the CLI token is
a tenant-admin credential, an agent can run the whole loop — introspect, serve,
test, and grant/revoke access — from the command line, no dashboard. Run
`finch help` for the worked automation examples.

## Provision a new box from an already-authed one (no human)

```bash
# on the authed box, mint a token and hand it to the new box over SSH:
ssh user@newbox "finch login --token $(finch token)"
ssh user@newbox "finch add api --service http://127.0.0.1:9000 && finch run"
```

`finch token` mints a fresh, epoch-bound CLI token (revocable via `finch
revoke-tokens` or the dashboard). The human approval only exists for your very
first box; after that every box is a scripted one-liner.

## Quick start (the modern flow)

```bash
# 1. build (until release binaries are cut)
go build -o finch .

# 2. log in — opens the dashboard to approve a short code
./finch login --hub https://finchmcp.com
#   → opens https://<hub>/cli?code=WXYZ-1234 ; click "Approve" ; done.

# 3. expose a local service (running on :8000) as the service "printer"
./finch add printer --service http://127.0.0.1:8000

# 4. serve it — prints the public URL, e.g. https://<slug>.finchmcp.com/printer/
./finch run
```

`finch add` writes/extends `finch.yml`; `finch run` serves it. Add more
services with more `finch add` calls — one process fronts them all.

## `finch.yml` — the manifest (cloudflared-style)

One `finch run` serves many local services, each as its own service, over one
outbound link. The manifest holds **no secrets** — it's a pure wiring table of
`app_path → service`. See [`finch.example.yml`](finch.example.yml).

```yaml
hub: https://finchmcp.com        # default; omit for prod
box: mac-mini                # this box's name (default: hostname)
credentials-dir: ~/.finch        # where `finch enroll` writes per-app credentials

# Each rule forwards one local service.
#   app_path → the public URL segment: https://<your-slug>.finchmcp.com/<app_path>/
#              (and the service name in the dashboard). By default finch forwards
#              only …/<app_path>/mcp (it's an MCP tunnel first). Set forward_all: true
#              (or point service at a base path) to forward the whole subtree — for a
#              website or any non-MCP HTTP app.
ingress:
  - app_path: printer
    service: http://127.0.0.1:8000
  - app_path: transcribe
    service: http://127.0.0.1:8001
  - app_path: www                    # a plain website needs the whole subtree
    service: http://127.0.0.1:3000
    forward_all: true
```

Enrollment is a separate one-time step that keeps the ticket out of the manifest:
`finch enroll printer --ticket <t>` (or `finch add`, which does it for you when
logged in) trades the one-shot dashboard ticket for a refresh credential under
`credentials-dir/`. On later runs the agent resumes from that credential, so no
ticket is ever needed again.

## Docker

The agent runs as a container too — a tunnel sidecar next to your MCP server.
All state (login, credentials, `finch.yml`) lives under `/data`, so one volume
persists everything:

```bash
docker build -t finch-agent ./agent
docker run --rm -v finch-data:/data finch-agent login --hub https://finchmcp.com <token>
docker run --rm -v finch-data:/data finch-agent add hello --service http://host.docker.internal:8000
docker run -d --restart unless-stopped -v finch-data:/data finch-agent   # = finch run
```

The entrypoint is a minimal wrapper that dispatches to the binary (default
command `run`), so any subcommand still works via `docker run`. For
the full sidecar pattern — agent + MCP server as compose
services, enrolled by compose DNS name — see
[`examples/docker-compose/`](../examples/docker-compose/). Inside a container,
upgrade by rebuilding/pulling the image, not `finch update`.

For AviaryMCP, the default first run needs no bootstrap secret: `finch run`
starts the control socket, the SDK registers in `needs_enrollment`, and the
scoped browser device flow installs the service credential without exposing it
to the application container. The dynamic entrypoint deliberately does not
consume a legacy one-shot ticket: those credentials contain no approved
routes/edge-auth manifest and therefore cannot authorize an AviaryMCP relay.

```bash
docker run -d --restart unless-stopped \
  -e FINCH_APP_PATH=hello \
  -e FINCH_HUB=https://finchmcp.com \
  -e FINCH_BOX=media-container \
  -e FINCH_CREDENTIALS_DIR=/data/.finch \
  -v finch-data:/data \
  finch-agent
```

`FINCH_HUB`, `FINCH_BOX`, and `FINCH_CREDENTIALS_DIR` are the zero-config
daemon defaults. `FINCH_APP_PATH` must be the final Finch service slug. The
application container should never mount `/data`; it receives only the
permissioned control socket. Explicit `finch enroll --ticket` remains available
for legacy `finch.yml` services outside this dynamic path.

AviaryMCP sidecars additionally share a Unix control socket on an ephemeral
volume. Give the app and Finch distinct UIDs and only a dedicated supplemental
group, with a `0750` directory and `0660` socket. The app group can connect but
cannot unlink or replace the socket. Membership in that group is a powerful
local capability; use one mutually trusted application group per Finch
sidecar (or owner-only `0600` for a same-UID process). The current pilot API is
full-trust within that group, including lease management; do not share it
across mutually untrusted applications. Future multi-tenant sidecars require
SO_PEERCRED ownership checks or per-app sockets. Default host installs remain
owner-only (`0700`/`0600`).

## Auth & credentials

- **`finch login`** saves a long-lived **CLI token** (a tenant credential, ~90
  days) to `~/.finch/cli.json` (`0600`). You can also paste one directly:
  `finch login --hub <hub> <token>` (mint it in the dashboard → **Settings →
  CLI access → Generate**). The browser flow is the easy path.
- **`finch add`** uses that token to enroll services — no dashboard tickets to
  copy.
- **`finch run`** holds the relay open and **auto-approves** the services it
  serves when you're logged in (the CLI-token holder is the tenant admin), so
  there's no separate dashboard approval step. If you're not logged in (e.g. a
  ticket-only box), approve in the dashboard or with `finch approve <app_path>`.
- Per-service **refresh credentials** live under `credentials-dir/` and survive
  restarts/reboots — "authenticate once", like ngrok's authtoken.

## Legacy single-service mode

For one server straight from flags, without a config file:

```bash
finch join --hub https://finchmcp.com --ticket <ticket> --upstream http://127.0.0.1:8000
```

`--ticket` is a one-shot enrollment ticket from the dashboard ("Add box").
After first join, the agent resumes from `--state` (default `~/.finch/agent.json`)
ticketless.

## Flags (run / join)

| Flag | Default | What |
|---|---|---|
| `--hub` | `https://finchmcp.com` | finch hub base URL |
| `--config` | `finch.yml` (auto-detected) | manifest to serve (`finch run`) |
| `--ticket` | — | one-shot enrollment ticket (first run, single-service mode) |
| `--box` | hostname | this box's name |
| `--upstream` | `http://127.0.0.1:8000` | local service (single-service mode) |
| `--state` | `~/.finch/agent.json` | persisted per-box refresh credential |
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

Release binaries (mac/linux × amd64/arm64) are cut by GoReleaser on a `v*` tag
and fetched by the `curl | sh` installer.
