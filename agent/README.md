# finch agent (`agent/`)

The box-side CLI and daemon, for macOS and Linux. It runs on any always-on box
(Mac mini, Raspberry Pi, old laptop), **dials out** to the finch hub over a
single WebSocket, and relays each request the hub sends down to your local
service(s). finch is a protocol-agnostic tunnel — the service can be an MCP
server, a website, or any HTTP/WebSocket app. Nothing listens on the box; no
ports are opened.

A single Go binary with a few subcommands. It is built to be driven end to end
by an AI agent: every command takes `--json`, uses fixed exit codes, and never
prompts. `finch guide` prints the agent manual (the same flow as
[finchmcp.com/agents.md](../web/public/agents.md)).

| Command | What it does |
|---|---|
| `finch login --start` | Start a login and return at once: prints the sign-in link + code and saves the pending login to `~/.finch/login-pending.json` (0600). |
| `finch login --poll` | Poll that login once: exit 0 approved (credential saved), 10 pending, 11 expired. |
| `finch login` | The same login in one blocking step (like `gh auth login`); `--headless` skips opening a browser. |
| `finch add <name> --service <url> [--public]` | Enroll a service, append an `ingress` rule to `finch.yml`, print its public URL. `--public` makes it open (no key). |
| `finch service install\|uninstall\|status` | Run `finch run` as a login service: launchd LaunchAgent `~/Library/LaunchAgents/com.finchmcp.finch.plist` (macOS) or systemd user unit `finch.service` (Linux). Idempotent. |
| `finch connect <name> --client claude-code\|cursor\|codex\|json` | Mint a `finch_` key for one client and write it into that client's config without printing it (`json` prints an `mcpServers` snippet — the only mode that shows the key). Re-running it for `cursor` or `codex` revokes the key the replaced entry used. |
| `finch test <name>` | List a service's MCP tools through the hub; non-zero exit when the call fails. |
| `finch call <name> <tool> [--args '{…}']` | Invoke one tool through the hub; a tool error exits 1. |
| `finch run` | Serve every rule in `finch.yml` in the foreground — dials out, auto-approves, holds the relay open. |
| `finch status` | Logged in? Login pending? What does `finch.yml` serve? Is the service installed and running? Always exits 0. |
| `finch fleet` (alias `ls`) | List this account's services + state. |
| `finch keys [list \| mint <label> --service <name> \| revoke <id>]` | Manage the client `finch_` keys callers present (grant + revoke access). |
| `finch auth <name> public\|key` | Serve a service with no auth, or require a `finch_` key (the default). |
| `finch rm <name>` | Remove a service. |
| `finch domain [ls \| add <hostname> \| rm <hostname>]` | Manage custom hostnames. |
| `finch token` | Mint a fresh CLI token — set up another machine with no browser. |
| `finch enroll <name> --ticket -` | One time, on a box with no CLI login: trade a one-shot join ticket (stdin, or `FINCH_TICKET`) for a saved credential. |
| `finch approve <name>` | Approve a service (clear the pending gate). Usually automatic. |
| `finch update` | Self-update this binary and restart the serve cleanly (through launchd/systemd when `finch service` manages it). |
| `finch revoke-tokens` | De-authorize every CLI login (including this box). |
| `finch version [--json]` | Print this binary's version and platform. |
| `finch guide` / `finch help` | The agent manual / the command overview. |

## The JSON and exit-code contract

Agents branch on these, so they are stable (add fields; never repurpose them):

| Exit | Meaning | `--json` error code |
|---|---|---|
| 0 | ok | |
| 1 | error | `NOT_FOUND`, `UPSTREAM`, `INTERNAL` |
| 2 | usage | `USAGE` |
| 10 | waiting for login approval | `APPROVAL_PENDING` |
| 11 | login code expired | `EXPIRED` |
| 12 | not logged in (or the login was revoked) | `NOT_LOGGED_IN` |

With `--json`, every success payload on stdout carries `"schema_version":1`
(lists are wrapped: `{"schema_version":1,"services":[…]}`), and every error goes
to stderr as one line:

```json
{"schema_version":1,"error":{"code":"NOT_LOGGED_IN","message":"not logged in","next":"finch login --start"}}
```

`next`, when present, is the command to run next. `finch login --poll` reports
its outcome on stdout instead (`{"schema_version":1,"status":"pending"}` with
exit 10, `"expired"` with exit 11). The contract lives in
[`core/cli_contract.go`](core/cli_contract.go).

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
# 1. install (or `go build -o finch .` from this directory). Never uses sudo:
#    /usr/local/bin when writable, else ~/.local/bin; FINCH_INSTALL_DIR overrides.
curl -fsSL https://finchmcp.com/install | sh

# 2. log in — two steps for an agent (a human can run plain `finch login`)
finch login --start          # prints https://finchmcp.com/cli?code=WXYZ-2345 ; approve it on any device
finch login --poll           # repeat every few seconds until it exits 0

# 3. publish a local service (running on :8000) as "notes"; prints the public URL
finch add notes --service http://127.0.0.1:8000

# 4. keep it running as a login service (or `finch run` in the foreground)
finch service install

# 5. check it, then wire it into an MCP client
finch test notes
finch connect notes --client claude-code
```

`finch add` writes/extends `finch.yml`; `finch run` (and the service) serves
it. Add more services with more `finch add` calls — one process fronts them
all — then re-run `finch service install` so the service restarts onto the new
manifest.

## Background service

`finch service install` pins `finch run --config <absolute finch.yml>` in a
per-user unit, with the manifest's directory as the working directory:

- **macOS** — `~/Library/LaunchAgents/com.finchmcp.finch.plist`, loaded with
  `launchctl bootstrap gui/<uid>`; `RunAtLoad` + `KeepAlive`; logs to
  `~/.finch/finch.log`.
- **Linux** — `~/.config/systemd/user/finch.service` (honours
  `$XDG_CONFIG_HOME`), `Restart=always`, enabled and restarted via
  `systemctl --user`; logs in `journalctl --user -u finch.service`. On a
  headless box, `sudo loginctl enable-linger $USER` keeps it running without a
  login session; `install` reports `"linger": false` and a note when it is off.

Re-running `install` rewrites and reloads the unit, so it is safe after moving
the binary or adding a service. `uninstall` stops and removes it; `status`
reports `installed` and `running`. Only one serve per box can hold the relay, so
stop a foreground `finch run` before installing (install warns when one holds
the lock).

## Provision a new box from an already-authed one (no human)

```bash
# on the authed box, mint a token and pipe it to the new box over SSH.
# `--token -` reads stdin, so this tenant-admin token never reaches the remote
# argv (/proc/<pid>/cmdline, world-readable) or either shell's history:
finch token | ssh user@newbox "finch login --token -"
ssh user@newbox "finch add api --service http://127.0.0.1:9000 && finch service install"
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

- **`finch login`** (or `--start` + `--poll`) saves a long-lived **CLI token** (a tenant-admin credential,
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
