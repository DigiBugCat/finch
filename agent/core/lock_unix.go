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
	dir := filepath.Dir(lockPath)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, false
	}
	info, err := os.Lstat(dir)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, false
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || int(stat.Uid) != os.Geteuid() {
		return nil, false
	}
	if filepath.Clean(dir) != "." && info.Mode().Perm()&0o022 != 0 {
		return nil, false
	}
	fd, err := syscall.Open(lockPath, syscall.O_CREAT|syscall.O_RDWR|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return nil, false
	}
	f := os.NewFile(uintptr(fd), lockPath)
	if f == nil {
		syscall.Close(fd)
		return nil, false
	}
	if err := f.Chmod(0o600); err != nil {
		f.Close()
		return nil, false
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
