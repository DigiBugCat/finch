# Publish an MCP server with finch

You are an AI agent, and your human wants a local MCP server (or any local HTTP
app) reachable at a public `https://` URL. finch does that from this machine
without opening a port: the machine dials out to the finch hub, and callers
reach the service at `https://<slug>.finchmcp.com/<name>/mcp`.

You drive everything with the `finch` CLI on macOS or Linux. Every command
below accepts `--json`, and JSON field names are `snake_case`. Decide what to
do from the exit code and the JSON, not from prose. You need the human exactly
once: to approve the login in a browser.

The `<slug>` in that URL is your human's account address: a name finch gives
the account at sign-up (for example `brave-finch-12`). It is the same for
every service they publish.

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
- The output has no `"schema_version":1`, its `"version"` is below `1.8.0`, or
  the command fails: this finch is too old for these steps (finch 1.7 has no
  `finch logs` or `finch uninstall`, and re-running `finch add` there creates
  a second service instead of updating the first). Go to step 1 and install
  finch 1.8.0 or later, even though a `finch` is already on `PATH`.
- `"logged_in": true`: skip step 2.
- `"login_pending": true`: a login is waiting for approval. Go to step 2 and
  poll; do not start a new one. While it is pending, `"logged_in"` is `false`
  even if an older login is saved, because that login is blocked until the
  new one resolves.
- `"ingress"` lists the services this machine already publishes, each with its
  local `service` URL and, once logged in, its public `url`. `"service"` shows
  whether the background service is `installed` and `running`.

Also confirm the local server answers before you publish it, for example
`curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:8000/mcp`. Any HTTP
status means it is listening; a connection error means it is not running.

## 1. Install finch

```sh
curl -fsSL https://finchmcp.com/install | sh
```

The installer never asks for a password. It installs to `/usr/local/bin` when
you can write it and no other user can, and to `~/.local/bin` otherwise, and
prints a `PATH` hint in the second case. Its last lines name the version it
installed and the next steps. Set `FINCH_INSTALL_DIR` to choose the
directory; it refuses one that other users can write (group- or world-writable
without the sticky bit) and says how to fix that. If `finch` is
still not found afterwards, run it by its full path (for example
`~/.local/bin/finch`) for the rest of this session.

If the installer warns that another `finch` on `PATH` shadows the new one (an
older copy in a root-owned `/usr/local/bin`, say), plain `finch` still runs the
old binary. Use the full path the installer printed after `Next:` for every
command in this session, and tell your human they can remove the old copy.
Then run `finch status --json` again (by that path) and check that it has
`"schema_version":1` and a `"version"` of `1.8.0` or later.

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

Until the poll resolves, every other command exits `10` with
`APPROVAL_PENDING`, even when an older login is saved: a started login may be
for another account, so finch does not act on the old one in the meantime. If
your human decides not to approve it, `finch login --cancel --json` drops the
started login and the saved one works again.

Plain `finch login` (no `--start`) blocks until approval and has no `--json`
form. Always use `--start` and `--poll`.

## 3. Publish the service

```sh
finch add notes --service http://127.0.0.1:8000 --json
```

```json
{"schema_version":1,"app_path":"notes","auth":"key","config":"/home/you/.finch/finch.yml","forward_all":false,"service":"http://127.0.0.1:8000","url":"https://brave-finch-12.finchmcp.com/notes/mcp"}
```

`url` is the public endpoint. Tell your human what it is. By default, callers
need a `finch_` key (step 6 creates one for this agent). Add `--public` only if
your human explicitly asked for an open endpoint that anyone with the URL can
call.

By default finch forwards only `/notes/mcp`, the MCP endpoint. For a web app
or a REST API, add `--forward-all`: finch then forwards every path under
`/notes/`, and `url` ends in `/notes/`.

Service names are lowercase letters, digits and dashes, so finch may adjust
the name you give it (`My_Notes` becomes `my-notes`). `app_path` is the name it
used; use it in every later command. If the name is already taken by a
service another machine publishes, `finch add` exits `2` with `USAGE`: ask your
human for another name.

To change the local URL later (a new port, say), run the same `finch add`
again with the new `--service`. It updates the service in place, keeping its
name and public URL, and the payload has `"updated":true`. Then run
`finch service install --json` again so the background service picks it up.

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

Exit `0` means `finch run` is running and every service's relay has connected
to the hub (the payload's `relays` lists each one). If `finch run` does not come
up, or a relay has not connected within about 20 seconds, `install` exits `1`
with `INTERNAL`; the unit stays installed, and `error.message` names the log to
read and any reason finch already knows. A common one is a `finch run` already
serving in a terminal: ask your human to stop it (Ctrl-C), then run
`finch service install --json` again. Another is a rejected or missing
credential: `error.next` is then the `finch add <name> --service <url>` that
replaces it.

On Linux, when the output has `"linger": false`, tell your human that
`sudo loginctl enable-linger <user>` keeps finch running after they log out
(it matters on a headless box). Do not run `sudo` yourself.

If the output has `notes`, relay them to your human.

## 5. Check it

```sh
finch test notes --json
```

```json
{"schema_version":1,"ok":true,"service":"notes","tools":[{"name":"search","description":"Search notes"}]}
```

Exit `0` means the MCP server answered `tools/list` through the public relay,
in a full MCP session (initialize first, like any MCP client). Any other exit
code means it did not; read `error.message` and `error.next`. Right after
`finch service install`, the relay can take a few seconds to connect. If you
get `UPSTREAM`, wait 5 seconds and try again, up to 3 times.

What an `UPSTREAM` message means:

- It says nothing answers at `http://127.0.0.1:8000`: finch is connected, but
  the local server is not running (or listens on another port). Ask your human to start
  it, then run `finch test notes --json` again.
- It says `notes is offline`: no machine that publishes it is connected to finch. Run
  `finch service status --json`; if it is not running, run
  `finch service install --json`.
- It says the server rejected the MCP handshake: finch reached the server, and
  the server refused the MCP session. Show your human the message.
- A 401 or 404 in the message came from their MCP server, not from finch.

## 6. Connect it to an MCP client

```sh
finch connect notes --client claude-code --json
```

This creates a new `finch_` key for that client, scoped to this one service,
and writes it into the client's configuration without printing it:

| `--client` | What it does |
|---|---|
| `claude-code` | Adds `notes` to Claude Code for the current directory's project (`claude mcp add-json`, local scope). The key goes to `~/.finch/connect/notes.claude-code.json` (mode 0600), and the entry's `headersHelper` reads it from there, so the key never appears in a command line. Claude Code runs the helper only in a workspace your human has trusted. Needs the `claude` CLI on `PATH`. |
| `cursor` | Adds `mcpServers.notes` to `~/.cursor/mcp.json`, keeping everything else. |
| `codex` | Adds `[mcp_servers.notes]` to `~/.codex/config.toml`, keeping everything else. A name with a `.` is quoted: `[mcp_servers."notes.v2"]`. |
| `json` | Prints an `mcpServers` JSON snippet, key included. Use it only for a client finch cannot configure, and write it straight into that client's config file. |

Pick the client you are running in. The JSON output has a `key_id`, never the
key. Running it again is safe for `claude-code`, `cursor` and `codex`: it
replaces the entry and revokes the key the old entry used (`revoked_key_ids`),
so re-running it is how you rotate a key. For `claude-code`, every project on
this machine connected to the same service shares the headers file, so they
all move to the new key. The client usually has to reload its MCP servers (or
restart) before the new server appears. Tell your human that.

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
| `APPROVAL_PENDING` | 10 | A login was started but not approved yet. It blocks every other command, even with an older login saved. | `finch login --poll --json` every `interval` seconds, or `finch login --cancel --json` to drop it. |
| `EXPIRED` | 11 | The login code expired before approval. | `finch login --start --json` and show the new link. |
| `NOT_FOUND` | 1 | The service, pending login, or client does not exist here. | The `next` field: `finch add …`, `finch login --start`, or `finch connect … --client json`. |
| `UPSTREAM` | 1 | The hub or your MCP server failed: unreachable, offline, an HTTP error from the server itself, or an MCP error. | Check the local server is running, then `finch service status --json`; retry `finch test <name> --json`. Step 5 lists what each message means. |
| `USAGE` | 2 | The command line was wrong. | Fix the arguments; `next` is the command's help (`finch <command> -h`), and `finch help` lists every command. |
| `INTERNAL` | 1 | A local problem, such as an unwritable file, a service manager error, or a background service that did not start or stop. | Read `message`; tell your human if you cannot fix it. |

## Security rules

- Never print, log, echo, or paste the finch login token or a `finch_` key,
  including into chat, commit messages, or files you show your human. `finch
  connect` exists so you never handle a key. Use `--client json` only when no
  other client fits.
- Never read or copy `~/.finch/cli.json`, `~/.finch/login-pending.json`, the
  `~/.finch/connect/` headers files, or the per-service credential files.
  finch and your MCP client read them; you do not need to.
- Only show your human the `verification_uri_complete` link and `user_code`.
  Never approve a login yourself, and never ask your human for their password.
- Do not add `--public` unless your human asked for an open endpoint.
- Do not pass tokens as command-line arguments. To move a login to another
  machine, pipe it: `finch token | ssh host 'finch login --token -'`.
- Publish only the local service your human named. finch forwards only
  `/<name>/mcp` unless the service was added with `--forward-all`. Add
  `--forward-all` only when your human asked to publish a web app or API.
- Do not run `finch rm` or `finch uninstall` unless your human asked for it.

## Later: logs, changes, removal

- `finch fleet --json` lists every service in the account with its `state`
  and public `url`.
- `finch logs notes --json` shows the most recent calls to a service: `time`,
  `route`, `caller` (the key's label, `public`, or `finch-cli` for
  `finch test`), `status` and `ms`. Add `--limit 5` for fewer. finch keeps no
  request or response bodies.
- `finch add notes --service <new url> --json` changes where a service points
  (see step 3).
- `finch keys revoke <key_id> --json` cuts off one client.
- `finch rm notes --json` removes the service from the account, from
  `finch.yml`, and its saved credential on this machine, and restarts the
  background service if it runs. When that was the last service and the
  background service is installed, its `"next"` is `finch service uninstall`.
  If this machine's `notes` belongs to another account than the one you are
  logged in to, it exits `2` with `USAGE` and changes nothing: ask your human
  whether to log in to that account or to run `finch rm notes --local-only`,
  which removes it from this machine only and leaves it in its account.
- `finch service uninstall --json` stops the background service (it exits `1`
  and keeps the unit if finch could not be stopped).
- `finch uninstall --json` removes everything finch set up on this machine:
  the background service, the keys `finch connect` created here (revoked,
  `revoked_key_ids`), the client entries it wrote, and `~/.finch`. Services
  stay in the account. On a machine set up before finch 1.8 it cannot tell
  which keys were its own, so it revokes none and lists the likely ones in
  `candidate_key_ids`; show them to your human rather than revoking them.
  It does not delete the `finch` binary; its output says how
  (`remove_binary`).

## Reference

- `finch guide` prints this manual from the installed binary.
- `finch help` lists every command, and `finch help <command>` (or
  `finch <command> -h`) shows one command's flags and an example. The CLI
  reference is at https://finchmcp.com/docs/cli.
- Machine-readable overview: https://finchmcp.com/llms.txt
