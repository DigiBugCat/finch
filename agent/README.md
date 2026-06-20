# finch agent (`agent/`)

The box-side daemon. It runs on any always-on machine (Mac mini, Raspberry Pi,
old laptop), **dials out** to the finch hub over a single WebSocket, and relays
each request the hub sends down to your local MCP server(s). Nothing listens on
the box; no ports are opened.

A single Go binary with a few subcommands:

| Command | What it does |
|---|---|
| `finch login` | Log in to your tenant via the browser (device-auth, like `gh auth login`). |
| `finch add <path> --service <url>` | Enroll an appliance and append an `[[ingress]]` rule to `finch.toml`. |
| `finch run` | Serve every rule in `finch.toml` — dials out, auto-approves, holds the relay open. |
| `finch status` | Am I logged in (which tenant)? What does `finch.toml` serve? |
| `finch fleet` (alias `ls`) | List this account's appliances + state. |
| `finch test <appliance>` | List an appliance's MCP tools (does-it-work check). |
| `finch call <appliance> <tool> [--args '{…}']` | Invoke one tool through the hub. |
| `finch keys [list \| mint <label> --appliance <id> \| revoke <id>]` | Manage the client `finch_` keys callers present (grant + revoke access). |
| `finch token` | Mint a fresh CLI token — provision a new box with no browser. |
| `finch approve <path>` | Approve an appliance (clear the pending gate). Usually automatic. |
| `finch rm <appliance>` | Remove an appliance. |
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
first box; after that every device is a scripted one-liner.

## Quick start (the modern flow)

```bash
# 1. build (until release binaries are cut)
go build -o finch .

# 2. log in — opens the dashboard to approve a short code
./finch login --hub https://finchmcp.com
#   → opens https://<hub>/cli?code=WXYZ-1234 ; click "Approve" ; done.

# 3. expose a local MCP server (running on :8000) as the appliance "printer"
./finch add printer --service http://127.0.0.1:8000 --name "Label Printer"

# 4. serve it — prints the public URL, e.g. https://<slug>.finchmcp.com/printer/mcp
./finch run
```

`finch add` writes/extends `finch.toml`; `finch run` serves it. Add more
services with more `finch add` calls — one process fronts them all.

## `finch.toml` — the manifest (cloudflared-style)

One `finch run` serves many local services, each as its own appliance, over one
outbound link. See [`finch.example.toml`](finch.example.toml).

```toml
hub     = "https://finchmcp.com"   # default; omit for prod
machine = "mac-mini"               # this box's name (default: hostname)
state   = "~/.finch"               # dir holding per-appliance refresh credentials

# Each rule exposes one local server as an appliance.
#   path  → the public URL segment: https://<your-slug>.finchmcp.com/<path>/mcp
#           (and the appliance name in the dashboard)
[[ingress]]
name    = "Label Printer"
path    = "printer"
service = "http://127.0.0.1:8000"
ticket  = "…"                       # first run only; then state resumes

[[ingress]]
name    = "Transcriber"
path    = "transcribe"
service = "http://127.0.0.1:8001"
```

`finch add` fills in `ticket` for you (and you usually never see it). On later
runs the agent resumes from the saved refresh credential under `state/`, so no
ticket is needed.

## Auth & credentials

- **`finch login`** saves a long-lived **CLI token** (a tenant credential, ~90
  days) to `~/.finch/cli.json` (`0600`). You can also paste one directly:
  `finch login --hub <hub> <token>` (mint it in the dashboard → **Settings →
  CLI access → Generate**). The browser flow is the easy path.
- **`finch add`** uses that token to enroll appliances — no dashboard tickets to
  copy.
- **`finch run`** holds the relay open and **auto-approves** the appliances it
  serves when you're logged in (the CLI-token holder is the tenant admin), so
  there's no separate dashboard approval step. If you're not logged in (e.g. a
  ticket-only box), approve in the dashboard or with `finch approve <path>`.
- Per-appliance **refresh credentials** live under `state/` and survive
  restarts/reboots — "authenticate once", like ngrok's authtoken.

## Legacy single-service mode

For one server straight from flags, without a config file:

```bash
finch join --hub https://finchmcp.com --ticket <ticket> --upstream http://127.0.0.1:8000
```

`--ticket` is a one-shot enrollment ticket from the dashboard ("Add device").
After first join, the agent resumes from `--state` (default `~/.finch/agent.json`)
ticketless.

## Flags (run / join)

| Flag | Default | What |
|---|---|---|
| `--hub` | `https://finchmcp.com` | finch hub base URL |
| `--config` | `finch.toml` (auto-detected) | manifest to serve (`finch run`) |
| `--ticket` | — | one-shot enrollment ticket (first run, single-service mode) |
| `--machine` | hostname | this box's name |
| `--upstream` | `http://127.0.0.1:8000` | local MCP server (single-service mode) |
| `--state` | `~/.finch/agent.json` | persisted per-machine refresh credential |

## How it relays

On connect the agent dials `wss://<hub>/<appliance>/<machine>/_connect?ct=<token>`
and parks the socket. For each request frame the hub sends, the agent forwards
it to the matching local `service`, streams the response back (`head` →
`chunk…` → `end`), and confines forwarded paths to the upstream's base (an SSRF
guard). The caller's `finch_` key never reaches your box — the hub strips it.

## Build / test

```bash
go build -o finch .         # local binary
go test ./...               # unit + golden relay-vector tests
go vet ./...
```

Release binaries (mac/linux × amd64/arm64) are cut by GoReleaser on a `v*` tag
and fetched by the `curl | sh` installer.
