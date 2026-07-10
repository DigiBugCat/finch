//go:build !windows

package core

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLockState_FailsClosedOnUnsafeLockPath(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "target")
	if err := os.WriteFile(target, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	statePath := filepath.Join(dir, "state")
	if err := os.Symlink(target, statePath+".lock"); err != nil {
		t.Fatal(err)
	}
	if release, ok := lockState(statePath); ok || release != nil {
		t.Fatal("unsafe lock path failed open")
	}
}

func TestLockState_FailsClosedOnInsecureCredentialDirectory(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "credentials")
	if err := os.Mkdir(dir, 0o777); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0o777); err != nil {
		t.Fatal(err)
	}
	if release, ok := lockState(filepath.Join(dir, "state")); ok || release != nil {
		t.Fatal("world-writable credential directory was accepted")
	}
	info, _ := os.Lstat(dir)
	if got := info.Mode().Perm(); got != 0o777 {
		t.Fatalf("lock attempt silently changed directory mode to %04o", got)
	}
}
