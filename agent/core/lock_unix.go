//go:build !windows

package core

import (
	"os"
	"path/filepath"
	"syscall"
)

// lockState takes an exclusive, non-blocking advisory lock tied to the state
// file, so a second `finch run` on the same box+state exits instead of dialing
// out for the same slugs and superseding the incumbent relay (the "flapping /
// superseded storm" failure mode). The lock is a sidecar `<state>.lock` file —
// never the state JSON itself, which is rewritten on every token refresh.
//
// Returns (release, true) when the lock is held; the caller defers release.
// Returns (nil, false) when another process already holds it — the caller
// should log and exit. Held for the process lifetime via the flock on the open
// fd; closing the fd (release) drops it.
func lockState(statePath string) (release func(), ok bool) {
	lockPath := statePath + ".lock"
	if err := os.MkdirAll(filepath.Dir(lockPath), 0o700); err != nil {
		// Can't create the dir — don't block startup on the guard; proceed unlocked.
		return func() {}, true
	}
	f, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return func() {}, true // best-effort: never let the guard itself break run.
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		return nil, false // another finch run holds it.
	}
	return func() {
		syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
		f.Close()
	}, true
}
