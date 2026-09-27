# Changelog

What changed in each finch release, in plain words. Versions are the `finch`
CLI's; the hub and website ship continuously and are listed with the release
they shipped alongside. Pull request numbers refer to
[DigiBugCat/finch](https://github.com/DigiBugCat/finch/pulls?q=is%3Apr).

Install or update with `curl -fsSL https://finchmcp.com/install | sh`, or run
`finch update`.

## [Unreleased]

## [1.8.0] - 2026-09-27

The CLI and hub changes below are #58. `/agents.md`, `/llms.txt` and
`finch guide` now use commands that need finch 1.8.0 or later.

### CLI

- Typing `finch` on its own prints the help. `finch help <command>` and
  `finch <command> -h` print that command's usage, flags and an example.
- `finch login` opens your browser and waits for you to approve; people no
  longer need the two-step `--start` / `--poll` flow, which stays for agents.
- `finch update` asks the hub for the latest version first, says when you
  already have it and exits without downloading, and reports a failed check
  instead of reinstalling; `--force` reinstalls anyway.
- Re-running `finch add <name> --service <url>` for a service this machine
  publishes updates its local address (and `--public` / `--forward-all`)
  instead of creating `<name>-2`. A name another machine publishes is refused
  with a clear message.
- `finch add --forward-all` forwards every path of the service, for web apps
  and REST APIs, when the `--service` URL has no path. Without it only
  `/<name>/mcp` is forwarded, as before; a URL with a path stays confined to
  that path either way.
- `finch rm <name>` also removes the service from `finch.yml`, deletes its
  saved credential on this machine, and restarts a running background
  service. It refuses a service enrolled under a different account than the
  one you are logged in to; `finch rm <name> --local-only` removes just this
  machine's entry and credential.
- New `finch logs <name> [--limit N] [--json]`: recent calls with time, route,
  caller, status and duration.
- `finch status` and `finch fleet` show each service's public URL (`url` in
  `--json`). `finch status --json` also reports `logged_in`; `loggedIn` stays
  for compatibility.
- New `finch uninstall [--json]`: stops and removes the background service,
  deletes local credentials and configuration, removes the client entries
  finch added, revokes the keys that `finch connect` recorded creating on this
  machine, and prints what it did and how to delete the binary. Keys created
  by an older `finch connect` were not recorded, so they are listed as
  candidates (`candidate_key_ids`) for you to revoke, not revoked.
- `finch test` says "the server rejected the MCP handshake" instead of saying
  it cannot check FastMCP servers, and names the local URL when nothing
  answers there.
- `finch connect --client codex` handles Codex configs that quote the
  `["mcp_servers"]` table name (#50).
- The agent no longer sends the local URL or its connection error to the hub.

### Hub

- When your local server is down, callers get a JSON 502 naming the service
  ("finch reached the machine, but the local service isn't answering") instead
  of a raw connection error that exposed the local address.
- An MCP request without credentials gets the 401 OAuth challenge even while
  the machine is offline, so connectors such as claude.ai can start sign-in.
  The offline 503 says what to check and sends `Retry-After`.
- Authentication errors say which problem it is: no key, an unknown or revoked
  key, or a key that is not allowed for this service.
- Error messages no longer mention "tenant"; an unknown address says there is
  no finch account there. Unknown hub API paths answer 404 and wrong methods
  405, before credentials are checked. Every 429 sends `Retry-After`.
- New `GET /api/cli/version` and `/api/cli/logs` (behind `finch update` and
  `finch logs`).
- The installer names the version it installed, suggests a shell profile line
  when the install directory is not on your `PATH`, and refuses to install
  over a directory (#50).

### Website

- New **Your fleet** page at `/fleet`: a read-only, signed-in view of your
  account address, each service's public URL, who can call it, its machines
  and recent calls. Keys are listed by label, never by value, and every action
  is shown as the `finch` command to run (#55).

### Repository

- The README is rewritten for people new to finch, with a self-hosting guide
  ([`docs/self-host.md`](docs/self-host.md), also at `/docs/self-host`) and a
  checklist of what ties the code to finchmcp.com
  ([`docs/self-host-coupling.md`](docs/self-host-coupling.md)).
- Pre-launch reviews and unbuilt designs moved to [`docs/archive/`](docs/archive/),
  each marked as historical; the relay protocol and security docs now describe
  the current code.
- New `SECURITY.md`, `CONTRIBUTING.md`, this changelog, issue and pull request
  templates, and grouped release notes that start with the install line.
- A stray build of the retired tray app was removed from the repository, and
  local build outputs are ignored (#54).

## [1.7.1] - 2026-09-27

### Fixed

- `finch service install` now sets `HOME` in the launchd and systemd unit.
  Without it, a service started with a different environment looked for its
  login and credentials in the wrong directory and never connected (#52).

## [1.7.0] - 2026-09-27

finch becomes a command-line tool that you, or an AI agent, drive end to end.
Each account belongs to one person.

### Added

- `finch service install | status | uninstall` runs finch in the background as
  a launchd LaunchAgent (macOS) or systemd user unit (Linux), with a log that
  rotates at 10 MiB (#48).
- `finch connect <name> --client claude-code|cursor|codex|json` mints a key for
  one service and writes it into the client's configuration without printing
  it. Running it again replaces the key and revokes the old one (#48).
- `finch login --start` and `--poll` (and `--cancel`) let an agent sign in
  without blocking; the human approves a link and code (#48).
- `finch add --public` opens a service to anyone with the URL (#48).
- A stable machine-readable contract: `--json` output carries
  `"schema_version": 1`, errors are one JSON line, and exit codes are fixed
  (0 ok, 1 error, 2 usage, 10 waiting for approval, 11 expired, 12 not logged
  in) (#48).
- [`/agents.md`](https://finchmcp.com/agents.md), the step-by-step guide AI
  agents follow, and `finch guide` (#48).
- `finch test` and `finch call` run a real MCP session (initialize, the call,
  then close), so FastMCP and SDK servers answer them (#49).
- A new website: the field-guide landing page, and restyled sign-in, `finch
  login` approval and docs (#46).

### Changed

- The installer never uses sudo: it installs to `/usr/local/bin` when you can
  write there and to `~/.local/bin` otherwise, verifies the binary against
  `checksums.txt` and refuses to install on a mismatch, and warns when an older
  `finch` earlier on your `PATH` would shadow the new one (#48).
- OAuth-only MCP clients (such as claude.ai custom connectors) are pointed
  straight at Clerk as the authorization server, which fixes sign-in with
  current MCP SDKs (#40).
- The relay handles MCP 2026-07-28 clients: credentials are removed by header
  name, plus any header carrying the exact bearer token presented on that
  request, so tools or arguments containing `finch_` are no longer altered
  (#41).
- The website reaches the hub over a private Cloudflare service binding (#39).

### Removed

- The web dashboard, team workspaces, access-control rules, the browser login
  wall, device enrollment and "test in chat". Everything they did is either a
  CLI command now or gone (#43, #44, #45).
- The tray app and the Android SDK (#44).
- Data from the removed team features: other members, invitations, groups,
  access rules and access requests are deleted, and keys labelled for other
  people revoked, by a one-time migration (#47). It runs for each account the
  first time that account is used after the release, so an account that has
  not been used since keeps those records until then
  ([details](docs/archive/single-user-migration.md)).

### Security

- Fixed twelve verified findings from a security review and hardened
  transport and input handling across the hub, website and agent (#25).
- Fixed revocations that did not fully remove access (#30) and further
  hardening from production audits (#27, #29, #31, #33, #34).
- Fixed production sign-in after the hardening (#37).

[Unreleased]: https://github.com/DigiBugCat/finch/compare/v1.8.0...HEAD
[1.8.0]: https://github.com/DigiBugCat/finch/compare/v1.7.1...v1.8.0
[1.7.1]: https://github.com/DigiBugCat/finch/compare/v1.7.0...v1.7.1
[1.7.0]: https://github.com/DigiBugCat/finch/compare/v1.6.0...v1.7.0
