//go:build darwin || linux

// Package instance keeps one finch-bar per user: a second copy (opened from
// Finder while the login item already started one, say) exits quietly.
package instance

import (
	"errors"
	"os"
	"path/filepath"
	"syscall"
)

// ErrRunning means another finch-bar holds the lock.
var ErrRunning = errors.New("finch-bar is already running")

// Lock takes the per-user lock in dir, holding it until the process exits.
func Lock(dir string) (*os.File, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(filepath.Join(dir, "finch-bar.lock"), os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return nil, ErrRunning
		}
		return nil, err
	}
	return f, nil
}
