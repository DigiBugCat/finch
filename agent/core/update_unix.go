//go:build !windows

package core

import (
	"os"
	"syscall"
)

// syscallExec replaces the current process image with argv[0]=path. On success it
// does not return (the new binary takes over the PID, fds, and relay sockets are
// closed as the old image is discarded — the new serve reconnects). Used by
// `finch update --restart self` on any box without a managing service.
func syscallExec(path string, argv []string) error {
	return syscall.Exec(path, argv, os.Environ())
}

// runningAsServe reports whether THIS process is a `finch run` (so a self-exec
// update re-execs into `run`, not a bare update loop). `finch update` is normally
// its own short-lived invocation, so this is false; it only returns true if a
// serve ever triggers an in-process update. Detected from argv[1].
func runningAsServe() bool {
	return len(os.Args) > 1 && os.Args[1] == "run"
}
