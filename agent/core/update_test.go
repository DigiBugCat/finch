package core

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// updateArch must produce a goreleaser asset suffix for every platform we
// publish (amd64/arm64 pass through; 32-bit arm maps to armv6/armv7).
func TestUpdateArch(t *testing.T) {
	got := updateArch()
	switch runtime.GOARCH {
	case "amd64", "arm64":
		if got != runtime.GOARCH {
			t.Fatalf("updateArch() = %q, want %q", got, runtime.GOARCH)
		}
	case "arm":
		if got != "armv6" && got != "armv7" {
			t.Fatalf("updateArch() = %q, want armv6/armv7", got)
		}
	default:
		t.Skipf("unpublished GOARCH %s", runtime.GOARCH)
	}
}

// downloadAndSwap: a failed download must never touch the destination binary,
// and a successful one must atomically replace it with executable bits.
func TestDownloadAndSwap(t *testing.T) {
	dir := t.TempDir()
	dst := filepath.Join(dir, "finch")
	if err := os.WriteFile(dst, []byte("OLD"), 0o755); err != nil {
		t.Fatal(err)
	}

	// Failure: hub 404 → dst untouched.
	srv404 := httptest.NewServer(http.NotFoundHandler())
	defer srv404.Close()
	if err := downloadAndSwap(srv404.URL+"/releases/x", dst); err == nil {
		t.Fatal("expected error on 404 download")
	}
	if b, _ := os.ReadFile(dst); string(b) != "OLD" {
		t.Fatalf("dst clobbered by failed download: %q", b)
	}

	// Success: dst atomically replaced, executable.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, "NEW")
	}))
	defer srv.Close()
	if err := downloadAndSwap(srv.URL+"/releases/x", dst); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(dst)
	if err != nil || string(b) != "NEW" {
		t.Fatalf("dst = %q, %v; want NEW", b, err)
	}
	if fi, _ := os.Stat(dst); fi.Mode()&0o111 == 0 {
		t.Fatalf("dst not executable: %v", fi.Mode())
	}
}

// performUpdate must no-op (updated=false, no download) when the hub reports
// the current version at /api/version.
func TestPerformUpdateNoopWhenCurrent(t *testing.T) {
	downloads := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/version" {
			_ = json.NewEncoder(w).Encode(map[string]string{"latest": agentVersion})
			return
		}
		downloads++
		fmt.Fprint(w, "BIN")
	}))
	defer srv.Close()

	_, updated, err := performUpdate(srv.URL, false)
	if err != nil {
		t.Fatal(err)
	}
	if updated || downloads != 0 {
		t.Fatalf("expected no-op (updated=%v downloads=%d)", updated, downloads)
	}
}
