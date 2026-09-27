//go:build darwin || linux

package instance

import (
	"errors"
	"testing"
)

func TestSecondLockIsRefused(t *testing.T) {
	dir := t.TempDir()
	first, err := Lock(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Lock(dir); !errors.Is(err, ErrRunning) {
		t.Fatalf("second Lock = %v, want ErrRunning", err)
	}
	first.Close()
	again, err := Lock(dir)
	if err != nil {
		t.Fatalf("Lock after release = %v", err)
	}
	again.Close()
}
