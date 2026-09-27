# finch CLI fixtures

finch-bar learns everything by running `finch … --json`. These files are what
finch printed, so the tests can check finch-bar against the real contract.
Each file is one invocation: `args`, `exit`, `stdout`, `stderr`.

- `1.7.1/` was **recorded** from a finch 1.7.1 binary built from the `v1.7.1`
  tag, run with a throwaway `HOME` against a small local fake hub. Two things
  were rewritten after recording: the temporary home directory became
  `/Users/you`, and the fake hub's loopback address became
  `https://finchmcp.com`.
- `1.8.0/` is **written by hand** from the 1.8.0 contract (status and fleet
  gain `url`, status gains `logged_in` next to `loggedIn`, `finch update`
  reports `{"updated":false}` when current, `finch test` reports a rejected MCP
  handshake plainly). It also covers outcomes that can't be recorded without
  touching a real account or the machine's launchd/systemd (service install and
  uninstall). Re-record these against a 1.8.0 binary once it ships.
- `1.6.0/version.json` was recorded from a real finch 1.6.0 binary.
  `1.6.0/update.json` is written by hand.
- `1.5.10/` was **recorded** from a finch built from the `v1.5.10` tag, except
  `update.json` (written by hand; a real run replaces the binary). finch 1.5
  has no `version` command: `version.json` shows `--version --json` failing at
  flag parsing, and `version-subcommand.json` shows `version --json` falling
  through to the relay agent (exit 0, nothing on stdout), which is why
  finch-bar asks with the flag form.
- Every `version.json` is `finch --version --json`. For 1.6.0 and 1.7.1 the
  payload was recorded from `finch version --json`; both forms print the same
  thing (checked against binaries built from those tags).

`internal/fakefinch` serves these to the tests as a fake `finch` on `PATH`. It
refuses a fixture whose `args` don't match the command it was asked to run.
