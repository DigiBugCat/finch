//go:build unix

package core

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestUnixControlListener_ServesHandlerAndCleansUp(t *testing.T) {
	dir := filepath.Join(shortTempDir(t), "finch")
	socketPath := filepath.Join(dir, "control.sock")
	listener, err := NewUnixControlListener(socketPath, NewControlHandler(NewDynamicRegistry(nil)), UnixControlListenerOptions{})
	if err != nil {
		t.Fatal(err)
	}
	serveDone := make(chan error, 1)
	go func() { serveDone <- listener.Serve() }()

	assertMode(t, dir, 0o700)
	assertMode(t, socketPath, 0o600)

	client := unixHTTPClient(socketPath)
	body := []byte(`{"app_path":"media","upstream":"http://127.0.0.1:7342"}`)
	resp, err := client.Post("http://finch/v1/registrations", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		got, _ := io.ReadAll(resp.Body)
		t.Fatalf("register status=%d body=%s", resp.StatusCode, got)
	}
	var status ServiceStatus
	if err := json.NewDecoder(resp.Body).Decode(&status); err != nil {
		t.Fatal(err)
	}
	if status.AppPath != "media" || status.LeaseID == "" {
		t.Fatalf("unexpected registration: %+v", status)
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := listener.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-serveDone; err != nil {
		t.Fatalf("Serve returned %v", err)
	}
	if _, err := os.Lstat(socketPath); !os.IsNotExist(err) {
		t.Fatalf("socket remains after shutdown: %v", err)
	}
	if err := listener.Shutdown(ctx); err != nil {
		t.Fatalf("second shutdown: %v", err)
	}
}

func TestUnixControlListener_RequestedGroupMode(t *testing.T) {
	dir := filepath.Join(shortTempDir(t), "finch")
	gid := os.Getegid()
	l, err := NewUnixControlListener(filepath.Join(dir, "control.sock"), http.NotFoundHandler(), UnixControlListenerOptions{SocketMode: 0o660, GroupID: &gid})
	if err != nil {
		t.Fatal(err)
	}
	defer l.Shutdown(context.Background())
	assertMode(t, dir, 0o750)
	assertMode(t, l.Path(), 0o660)
}

func TestUnixControlListener_HasBoundedHTTPServer(t *testing.T) {
	dir := filepath.Join(shortTempDir(t), "finch")
	l, err := NewUnixControlListener(filepath.Join(dir, "control.sock"), http.NotFoundHandler(), UnixControlListenerOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer l.Shutdown(context.Background())
	if l.server.ReadHeaderTimeout <= 0 || l.server.ReadTimeout <= 0 || l.server.WriteTimeout <= 0 || l.server.IdleTimeout <= 0 {
		t.Fatalf("unbounded control server timeouts: %+v", l.server)
	}
	if l.server.MaxHeaderBytes <= 0 || l.server.MaxHeaderBytes > 32<<10 {
		t.Fatalf("unexpected MaxHeaderBytes=%d", l.server.MaxHeaderBytes)
	}
}

func TestUnixControlListener_RejectsOversizedHeaders(t *testing.T) {
	dir := filepath.Join(shortTempDir(t), "finch")
	l, err := NewUnixControlListener(filepath.Join(dir, "control.sock"), NewControlHandler(NewDynamicRegistry(nil)), UnixControlListenerOptions{})
	if err != nil {
		t.Fatal(err)
	}
	go l.Serve()
	defer l.Shutdown(context.Background())
	conn, err := net.Dial("unix", l.Path())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
	_, _ = fmt.Fprintf(conn, "GET /v1/services HTTP/1.1\r\nHost: finch\r\nX-Oversized: %s\r\n\r\n", strings.Repeat("a", 64<<10))
	resp, err := http.ReadResponse(bufio.NewReader(conn), &http.Request{Method: http.MethodGet})
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusRequestHeaderFieldsTooLarge {
		t.Fatalf("oversized header status=%d", resp.StatusCode)
	}
}

func TestUnixControlListener_TimesOutTrickledBody(t *testing.T) {
	dir := filepath.Join(shortTempDir(t), "finch")
	l, err := NewUnixControlListener(filepath.Join(dir, "control.sock"), NewControlHandler(NewDynamicRegistry(nil)), UnixControlListenerOptions{})
	if err != nil {
		t.Fatal(err)
	}
	// Keep production at 10s; shorten this instance to exercise the same server
	// deadline without slowing the suite.
	l.server.ReadTimeout = 75 * time.Millisecond
	go l.Serve()
	defer l.Shutdown(context.Background())
	conn, err := net.Dial("unix", l.Path())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(time.Second))
	_, _ = fmt.Fprint(conn, "POST /v1/registrations HTTP/1.1\r\nHost: finch\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{")
	if _, err := http.ReadResponse(bufio.NewReader(conn), &http.Request{Method: http.MethodPost}); err != nil {
		t.Fatalf("slow body did not receive a bounded response: %v", err)
	}
}

func TestUnixControlListener_ReplacesOnlyStaleSocket(t *testing.T) {
	dir := filepath.Join(shortTempDir(t), "finch")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	socketPath := filepath.Join(dir, "control.sock")
	stale, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := stale.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(socketPath); err != nil {
		t.Skipf("platform removed closed Unix socket automatically: %v", err)
	}

	l, err := NewUnixControlListener(socketPath, http.NotFoundHandler(), UnixControlListenerOptions{})
	if err != nil {
		t.Fatalf("stale socket was not replaced: %v", err)
	}
	defer l.Shutdown(context.Background())
	assertMode(t, socketPath, 0o600)
}

func TestUnixControlListener_RejectsActiveSocket(t *testing.T) {
	dir := filepath.Join(shortTempDir(t), "finch")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	socketPath := filepath.Join(dir, "control.sock")
	active, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatal(err)
	}
	defer active.Close()

	if _, err := NewUnixControlListener(socketPath, http.NotFoundHandler(), UnixControlListenerOptions{}); err == nil {
		t.Fatal("active socket was replaced")
	}
	conn, err := net.Dial("unix", socketPath)
	if err != nil {
		t.Fatalf("incumbent socket was disrupted: %v", err)
	}
	conn.Close()
}

func TestUnixControlListener_RejectsUnsafePathsAndModes(t *testing.T) {
	tests := []struct {
		name  string
		setup func(t *testing.T, dir, socketPath string)
		mode  os.FileMode
	}{
		{name: "regular file", setup: func(t *testing.T, _, socketPath string) {
			if err := os.WriteFile(socketPath, []byte("keep"), 0o600); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "symlink", setup: func(t *testing.T, dir, socketPath string) {
			target := filepath.Join(dir, "target")
			if err := os.WriteFile(target, nil, 0o600); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(target, socketPath); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "insecure directory", setup: func(t *testing.T, dir, _ string) {
			if err := os.Chmod(dir, 0o755); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "world socket mode", mode: 0o666},
		{name: "implicit group access", mode: 0o660},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := filepath.Join(shortTempDir(t), "finch")
			if err := os.Mkdir(dir, 0o700); err != nil {
				t.Fatal(err)
			}
			socketPath := filepath.Join(dir, "control.sock")
			if tt.setup != nil {
				tt.setup(t, dir, socketPath)
			}
			_, err := NewUnixControlListener(socketPath, http.NotFoundHandler(), UnixControlListenerOptions{SocketMode: tt.mode})
			if err == nil {
				t.Fatal("unsafe path or mode was accepted")
			}
		})
	}
}

func TestUnixControlListener_RejectsMismatchedSharedDirectoryGroup(t *testing.T) {
	dir := filepath.Join(shortTempDir(t), "finch")
	if err := os.Mkdir(dir, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0o750); err != nil {
		t.Fatal(err)
	}
	wrongGID := os.Getegid() + 1
	if _, err := NewUnixControlListener(filepath.Join(dir, "control.sock"), http.NotFoundHandler(), UnixControlListenerOptions{
		SocketMode: 0o660,
		GroupID:    &wrongGID,
	}); err == nil {
		t.Fatal("shared directory with mismatched gid was accepted")
	}
}

func TestUnixControlListener_ShutdownDoesNotRemoveReplacement(t *testing.T) {
	dir := filepath.Join(shortTempDir(t), "finch")
	l, err := NewUnixControlListener(filepath.Join(dir, "control.sock"), http.NotFoundHandler(), UnixControlListenerOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(l.Path()); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(l.Path(), []byte("replacement"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := l.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(l.Path())
	if err != nil || string(got) != "replacement" {
		t.Fatalf("replacement path changed: %q, %v", got, err)
	}
}

func unixHTTPClient(socketPath string) *http.Client {
	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", socketPath)
	}}
	return &http.Client{Transport: transport, Timeout: 2 * time.Second}
}

func assertMode(t *testing.T, path string, want os.FileMode) {
	t.Helper()
	info, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != want {
		t.Fatalf("%s mode=%04o, want %04o", path, got, want)
	}
}

func shortTempDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "fctl-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return dir
}
