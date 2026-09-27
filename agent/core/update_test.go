package core

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
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

func TestResolveUpdateRestartModePreventsUpdaterFromStartingBareRelay(t *testing.T) {
	tests := []struct {
		name, requested string
		tunnel, serving bool
		want            string
		wantErr         bool
	}{
		{name: "managed auto", requested: "auto", tunnel: true, want: "service"},
		{name: "separate updater auto", requested: "auto", want: "none"},
		{name: "serving auto", requested: "auto", serving: true, want: "self"},
		{name: "separate updater self", requested: "self", wantErr: true},
		{name: "unknown", requested: "typo", wantErr: true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := resolveUpdateRestartMode(tc.requested, tc.tunnel, tc.serving)
			if (err != nil) != tc.wantErr || got != tc.want {
				t.Fatalf("mode=%q err=%v, want mode=%q wantErr=%v", got, err, tc.want, tc.wantErr)
			}
		})
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

// A failure writing the new binary next to the old one is this machine's
// problem (INTERNAL, reinstall), not the hub's (UPSTREAM): the contract tells
// an agent to retry the network for UPSTREAM.
func TestUpdateFailuresAreClassifiedBySide(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, "NEW")
	}))
	defer srv.Close()
	srv404 := httptest.NewServer(http.NotFoundHandler())
	defer srv404.Close()

	locked := t.TempDir()
	dst := filepath.Join(locked, "finch")
	if err := os.WriteFile(dst, []byte("OLD"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(locked, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(locked, 0o755) })
	if os.Getuid() == 0 {
		t.Skip("root can write a 0555 directory")
	}

	var ce *cliError
	err := updateFailure(downloadAndSwap(srv.URL+"/releases/x", dst))
	if !errors.As(err, &ce) || ce.Code != codeInternal || ce.Next != "curl -fsSL https://finchmcp.com/install | sh" {
		t.Fatalf("unwritable install dir: %#v", err)
	}
	err = updateFailure(downloadAndSwap(srv404.URL+"/releases/x", dst))
	if !errors.As(err, &ce) || ce.Code != codeUpstream {
		t.Fatalf("hub 404: %#v", err)
	}
	if b, _ := os.ReadFile(dst); string(b) != "OLD" {
		t.Fatalf("dst clobbered: %q", b)
	}
}

func TestDownloadAndSwap_RejectsResourceExhaustionWithoutTouchingDestination(t *testing.T) {
	for _, tc := range []struct {
		name    string
		handler http.Handler
	}{
		{name: "declared oversize", handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Length", "9")
			_, _ = w.Write([]byte("123456789"))
		})},
		{name: "chunked oversize", handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.(http.Flusher).Flush()
			_, _ = w.Write([]byte("123456789"))
		})},
		{name: "empty", handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {})},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			dst := filepath.Join(dir, "finch")
			if err := os.WriteFile(dst, []byte("OLD"), 0o755); err != nil {
				t.Fatal(err)
			}
			srv := httptest.NewServer(tc.handler)
			defer srv.Close()
			if err := downloadAndSwapWithLimit(t.Context(), srv.URL, dst, 8); err == nil {
				t.Fatal("unsafe download accepted")
			}
			if b, _ := os.ReadFile(dst); string(b) != "OLD" {
				t.Fatalf("failed download replaced destination with %q", b)
			}
			matches, _ := filepath.Glob(filepath.Join(dir, ".finch-update-*"))
			if len(matches) != 0 {
				t.Fatalf("failed download leaked temp files: %v", matches)
			}
		})
	}
}

func TestHubLatestVersion_RejectsOversizedOrMalformedResponse(t *testing.T) {
	for _, body := range []string{
		`{"latest":"` + strings.Repeat("x", int(maxVersionResponseBytes)) + `"}`,
		`{"latest":"v1"}{"latest":"v2"}`,
	} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, body) }))
		if _, err := hubLatestVersion(srv.URL); err == nil {
			t.Errorf("unsafe version response accepted (length %d)", len(body))
		}
		srv.Close()
	}
}

// performUpdate must no-op (updated=false, no download) when the hub reports
// the current version: at /api/cli/version (1.8 hubs; the only version route
// the finchmcp.com apex sends to the hub), or at /api/version (older hubs).
func TestPerformUpdateNoopWhenCurrent(t *testing.T) {
	for _, route := range []string{"/api/cli/version", "/api/version"} {
		downloads := 0
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch {
			case r.URL.Path == route:
				_ = json.NewEncoder(w).Encode(map[string]string{"latest": agentVersion})
			case strings.HasPrefix(r.URL.Path, "/releases/"):
				downloads++
				fmt.Fprint(w, "BIN")
			default:
				http.NotFound(w, r)
			}
		}))
		_, updated, err := performUpdate(srv.URL, false)
		srv.Close()
		if err != nil {
			t.Fatal(err)
		}
		if updated || downloads != 0 {
			t.Fatalf("%s: expected no-op (updated=%v downloads=%d)", route, updated, downloads)
		}
	}
}
