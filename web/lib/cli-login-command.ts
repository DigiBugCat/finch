// The `finch login` command the dashboard hands a user to paste on a box
// (Settings → CLI access). This is the HIGHEST-VOLUME path for the ~30-day
// tenant-admin CLI token: every doc routes users to that copy button.
//
// It used to build `finch login --hub <hub> <token>`, which puts the token on
// argv the moment it is pasted — world-readable via /proc/<pid>/cmdline for the
// life of the process, and persisted verbatim into ~/.bash_history / ~/.zsh_history.
// Instead we emit a quoted heredoc so the token arrives on the login process's
// STDIN, which the CLI already accepts via `--token -` (resolveCliToken,
// agent/core/cli.go:485). Keep this byte-identical in shape to the CLI's own
// loginCommand (agent/core/cli.go:994) — `finch token --login` prints the same
// thing, and users compare the two.

// Quoted at the use site (<<'...'), so the shell expands NOTHING in the body: a
// token containing $, `, or \ is delivered byte-for-byte. The body cannot end
// the heredoc early either — that needs a line equal to the delimiter, and the
// token is one whole line with no newline in it (it is a bearer token, carried
// in an Authorization header, where a newline is not representable).
export const CLI_LOGIN_HEREDOC_DELIMITER = 'FINCH_CLI_TOKEN';

// cliLoginArgv is the part of the command a shell actually sees as arguments.
// It is token-free by construction, which is exactly why the UI renders THIS
// rather than slicing a fixed prefix off the full command: a redaction that
// depends on the token sitting past character N silently stops redacting the
// day the hub URL gets shorter.
export function cliLoginArgv(hub: string): string {
  return `finch login --hub ${hub} --token - <<'${CLI_LOGIN_HEREDOC_DELIMITER}'`;
}

// cliLoginCommand is the full clipboard payload: argv line, token line,
// terminator. Multi-line, but it pastes and runs as one unit in any POSIX
// shell, and no helper process (echo/printf) re-leaks the token through its own
// argv on the way in.
export function cliLoginCommand(hub: string, token: string): string {
  return `${cliLoginArgv(hub)}\n${token}\n${CLI_LOGIN_HEREDOC_DELIMITER}`;
}
