# Publish an MCP server with finch

You are an AI agent, and your human wants a local MCP server (or any local HTTP
app) reachable at a public `https://` URL. finch does that from this machine
without opening a port: the machine dials out to the finch hub, and callers
reach the service at `https://<slug>.finchmcp.com/<name>/mcp`.

You drive everything with the `finch` CLI on macOS or Linux. Every command
below accepts `--json`. Decide what to do from the exit code and the JSON, not
from prose. You need the human exactly once: to approve the login in a browser.

Example request from a human:

> Read https://finchmcp.com/agents.md and use finch to publish my MCP server on
> http://127.0.0.1:8000 as notes. Show me the sign-in link when you get it. Run
> it as a background service, check it with finch test, then connect it to this
> agent.

In the steps below, `notes` is the service name and `http://127.0.0.1:8000` is
the local server. Use the name and URL your human gave you.

## Before you start

Check what is already set up:

```sh
finch status --json
```

- Exit code 127, or `command not found`: finch is not installed yet. Go to step 1.
- The output has no `"schema_version":1`, or the command fails: this finch is
  too old for these steps (older versions print `{"loggedIn":…}` without a
  `schema_version`). Go to step 1 to install the current one, even though a
  `finch` is already on `PATH`.
- `"loggedIn": true`: skip step 2.
- `"login_pending": true`: a login is waiting for approval. Go to step 2 and
  poll; do not start a new one.
- `"ingress"` lists the services this machine already publishes, and
  `"service"` shows whether the background service is `installed` and `running`.

Also confirm the local server answers before you publish it, for example
`curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:8000/mcp`. Any HTTP
status means it is listening; a connection error means it is not running.

## 1. Install finch

```sh
curl -fsSL https://finchmcp.com/install | sh
```

The installer never asks for a password. It installs to `/usr/local/bin` when
that is writable and to `~/.local/bin` otherwise, and prints a `PATH` hint in
the second case. Set `FINCH_INSTALL_DIR` to choose the directory. If `finch` is
still not found afterwards, run it by its full path (for example
`~/.local/bin/finch`) for the rest of this session.

If the installer warns that another `finch` on `PATH` shadows the new one (an
older copy in a root-owned `/usr/local/bin`, say), plain `finch` still runs the
old binary. Use the full path the installer printed after `Next:` for every
command in this session, and tell your human they can remove the old copy.
Then run `finch status --json` again (by that path) and check that it has
`"schema_version":1`.

## 2. Log in (the one human step)

Start the login. This returns immediately:

```sh
finch login --start --json
```

```json
{"schema_version":1,"user_code":"WXYZ-2345","verification_uri_complete":"https://finchmcp.com/cli?code=WXYZ-2345","expires_in":600,"interval":3}
```

Show your human the `verification_uri_complete` link and the `user_code`, and
ask them to open the link on any device (a phone is fine), sign in, and approve
the code. Then poll once every `interval` seconds:

```sh
finch login --poll --json
```

| Exit | Output | What to do |
|---|---|---|
| `0` | `{"schema_version":1,"status":"approved","account":"…"}` | Logged in. Go on to step 3. |
| `10` | `{"schema_version":1,"status":"pending"}` | Wait `interval` seconds and poll again. |
| `11` | `{"schema_version":1,"status":"expired"}` | The code expired (after `expires_in` seconds). Run `finch login --start --json` again and show the new link. |

Keep polling until exit `0` or `11`. The login credential is saved for you in
`~/.finch/`. You never see it, and you must never print, log, or paste it.

## 3. Publish the service

```sh
finch add notes --service http://127.0.0.1:8000 --json
```

```json
{"schema_version":1,"app_path":"notes","auth":"key","config":"/home/you/.finch/finch.yml","service":"http://127.0.0.1:8000","url":"https://brave-finch-12.finchmcp.com/notes/mcp"}
```

`url` is the public endpoint. Tell your human what it is. By default, callers
need a `finch_` key (step 6 creates one for this agent). Add `--public` only if
your human explicitly asked for an open endpoint that anyone with the URL can
call.

If the hub registered the name under a different slug, `app_path` shows it. Use
`app_path` as the name in every later command.

## 4. Run it as a background service

```sh
finch service install --json
```

```json
{"schema_version":1,"binary":"/usr/local/bin/finch","config":"/home/you/.finch/finch.yml","installed":true,"linger":true,"log":"journalctl --user -u finch.service","manager":"systemd","running":true,"unit":"/home/you/.config/systemd/user/finch.service"}
```

This runs `finch run` as a login service: a launchd LaunchAgent on macOS, a
systemd user unit on Linux. It starts at login and restarts if it exits.
Running it again is safe, and it is required after publishing another service
with `finch add`: the service reads `finch.yml` only when it starts, and
`install` restarts it. Check it at any time with `finch service status --json`.

On Linux, when the output has `"linger": false`, tell your human that
`sudo loginctl enable-linger <user>` keeps finch running after they log out
(it matters on a headless box). Do not run `sudo` yourself.

If the output has `notes`, relay them. For example, a `finch run` already
running in a terminal must be stopped so the service can take over.

## 5. Check it

```sh
finch test notes --json
```

```json
{"schema_version":1,"ok":true,"service":"notes","tools":[{"name":"search","description":"Search notes"}]}
```

Exit `0` means the MCP server answered `tools/list` through the public relay.
Any other exit code means it did not; read `error.message` and `error.next`.
Right after `finch service install`, the relay can take a few seconds to
connect. If you get `UPSTREAM`, wait 5 seconds and try again, up to 3 times.

A failed `finch test` is not always proof that the service is down.
`finch test` sends one stateless `tools/list` through the hub, without an MCP
session. Many Streamable-HTTP servers, including FastMCP and the Python MCP
SDK in their default mode, reject that with HTTP 406 or 400
`Missing session ID`. In that case `error.message` says the service is
reachable through finch. Do not retry. Go on to step 6, and tell your human
that `finch test` could not check this server, so they should confirm it from
the connected client. For other `UPSTREAM` failures, show your human the
message. A 401 or 404 in it came from their MCP server, not from finch.

## 6. Connect it to an MCP client

```sh
finch connect notes --client claude-code --json
```

This creates a new `finch_` key for that client, scoped to this one service,
and writes it into the client's configuration without printing it:

| `--client` | What it does |
|---|---|
| `claude-code` | Runs `claude mcp add --transport http notes <url> --header "Authorization: Bearer <key>"`. Needs the `claude` CLI on `PATH`. |
| `cursor` | Adds `mcpServers.notes` to `~/.cursor/mcp.json`, keeping everything else. |
| `codex` | Adds `[mcp_servers.notes]` to `~/.codex/config.toml`, keeping everything else. |
| `json` | Prints an `mcpServers` JSON snippet, key included. Use it only for a client finch cannot configure, and write it straight into that client's config file. |

Pick the client you are running in. The JSON output has a `key_id`, never the
key. Running it again for `cursor` or `codex` is safe: it replaces the entry
and revokes the key the old entry used (`revoked_key_ids`). The client usually has to reload its MCP servers (or restart) before the
new server appears. Tell your human that.

## Errors

With `--json`, every failure prints one line to stderr:

```json
{"schema_version":1,"error":{"code":"NOT_LOGGED_IN","message":"not logged in","next":"finch login --start"}}
```

When `next` is present, it is the command to run next. Exit codes are
`0` ok, `1` error, `2` usage, `10` waiting for approval, `11` expired, and
`12` not logged in.

| Code | Exit | What it means | Next command |
|---|---|---|---|
| `NOT_LOGGED_IN` | 12 | No saved login, or it expired or was revoked. | `finch login --start --json`, then poll (step 2). |
| `APPROVAL_PENDING` | 10 | A login was started but not approved yet. | `finch login --poll --json` every `interval` seconds. |
| `EXPIRED` | 11 | The login code expired before approval. | `finch login --start --json` and show the new link. |
| `NOT_FOUND` | 1 | The service, pending login, or client does not exist here. | The `next` field: `finch add …`, `finch login --start`, or `finch connect … --client json`. |
| `UPSTREAM` | 1 | The hub or your MCP server failed: unreachable, offline, an HTTP error from the server itself, or an MCP error. | Check the local server is running, then `finch service status --json`; retry `finch test <name> --json`. If the message says the service is reachable but needs an MCP session, go on to `finch connect` (step 6). |
| `USAGE` | 2 | The command line was wrong. | Fix the arguments; `finch help` lists every command. |
| `INTERNAL` | 1 | A local problem, such as an unwritable file or a service manager error. | Read `message`; tell your human if you cannot fix it. |

## Security rules

- Never print, log, echo, or paste the finch login token or a `finch_` key,
  including into chat, commit messages, or files you show your human. `finch
  connect` exists so you never handle a key. Use `--client json` only when no
  other client fits.
- Never read or copy `~/.finch/cli.json`, `~/.finch/login-pending.json`, or the
  per-service credential files. finch reads them; you do not need to.
- Only show your human the `verification_uri_complete` link and `user_code`.
  Never approve a login yourself, and never ask your human for their password.
- Do not add `--public` unless your human asked for an open endpoint.
- Do not pass tokens as command-line arguments. To move a login to another
  machine, pipe it: `finch token | ssh host 'finch login --token -'`.
- Publish only the local service your human named. finch forwards only
  `/<name>/mcp` unless the manifest sets `forward_all: true`.
- To undo: `finch service uninstall` stops the background service,
  `finch rm notes` removes the service, and `finch keys revoke <key_id>` cuts
  off one client.

## Reference

- `finch guide` prints this manual from the installed binary.
- `finch help` lists every command. The CLI reference is at
  https://finchmcp.com/docs/cli.
- Machine-readable overview: https://finchmcp.com/llms.txt
