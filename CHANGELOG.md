# Changelog

What changed in each finch release, in plain words. Versions are the `finch`
CLI's; the hub and website ship continuously and are listed with the release
they shipped alongside. Pull request numbers refer to
[DigiBugCat/finch](https://github.com/DigiBugCat/finch/pulls?q=is%3Apr).

Install or update with `curl -fsSL https://finchmcp.com/install | sh`, or run
`finch update`.

## [Unreleased]

Planned as 1.8.0.

### CLI

- Typing `finch` on its own prints the help. `finch help <command>` and
  `finch <command> -h` print that command's usage, flags and an example.
- `finch login` opens your browser and waits for you to approve; people no
  longer need the two-step `--start` / `--poll` flow, which stays for agents.
- `finch update` says when you already have the latest version and exits
  without downloading; `--force` reinstalls anyway.
- Re-running `finch add <name> --service <url>` for an existing service
  updates its local address instead of creating `<name>-2`.
- `finch add --forward-all` forwards every path of the service, for web apps
  and REST APIs. Without it only `/<name>/mcp` is forwarded, as before.
- `finch rm <name>` also removes the service from `finch.yml` and deletes its
  saved credential on this machine.
- New `finch logs <name> [--limit N] [--json]`: recent calls with time, route,
  caller, status and duration.
- `finch status` and `finch fleet` show each service's public URL (`url` in
  `--json`). `finch status --json` also reports `logged_in`; `loggedIn` stays
  for compatibility.
- New `finch uninstall [--json]`: stops and removes the background service,
  deletes local credentials and configuration, revokes the keys this machine
  created with `finch connect`, removes the client entries finch added, and
  prints what it did and how to delete the binary.
- `finch test` reports a server that rejects the MCP handshake plainly, instead
  of saying it cannot check FastMCP servers.

### Hub

- When your local server is down, callers get a JSON 502 naming the service
  ("finch reached the machine, but the local service isn't answering") instead
  of a raw connection error that exposed the local address.
- An MCP request without credentials gets the 401 OAuth challenge even while
  the machine is offline, so connectors such as claude.ai can start sign-in.
- Authentication errors say which problem it is: no key, an unknown or revoked
  key, or a key that is not allowed for this service.
- Error messages no longer mention "tenant"; an unknown address says there is
  no finch account there. Unknown hub API paths answer 404 instead of 401.

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
  name, so tools or arguments containing `finch_` are no longer altered (#41).
- The website reaches the hub over a private Cloudflare service binding (#39).

### Removed

- The web dashboard, team workspaces, access-control rules, the browser login
  wall, device enrollment and "test in chat". Everything they did is either a
  CLI command now or gone (#43, #44, #45).
- The tray app and the Android SDK (#44).
- Data from the removed team features: other members, invitations, groups,
  access rules and access requests were deleted by a one-time migration, and
  keys labelled for other people were revoked (#47).

### Security

- Fixed twelve verified findings from a security review and hardened
  transport and input handling across the hub, website and agent (#25).
- Fixed revocations that did not fully remove access (#30) and further
  hardening from production audits (#27, #29, #31, #33, #34).
- Fixed production sign-in after the hardening (#37).

[Unreleased]: https://github.com/DigiBugCat/finch/compare/v1.7.1...HEAD
[1.7.1]: https://github.com/DigiBugCat/finch/compare/v1.7.0...v1.7.1
[1.7.0]: https://github.com/DigiBugCat/finch/compare/v1.6.0...v1.7.0
