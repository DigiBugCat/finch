//go:build unix

package core

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"time"
)

const defaultControlSocketMode fs.FileMode = 0o600

// UnixControlListenerOptions configures the local control listener. SocketMode
// defaults to 0600. Group access (for example, 0660 on a shared container
// volume) must be requested explicitly; world access is always rejected.
type UnixControlListenerOptions struct {
	SocketMode fs.FileMode
	// GroupID opts into a shared-container control socket. When present, the
	// parent directory is required to be 0750 and owned by the current UID and
	// this GID; the socket must grant group access (normally 0660). Without it,
	// the historical owner-only 0700/0600 contract remains mandatory.
	GroupID *int
}

// UnixControlListener serves the Finch control API over a permission-restricted
// Unix stream socket. It is deliberately independent from the relay lifecycle.
type UnixControlListener struct {
	path     string
	listener *net.UnixListener
	server   *http.Server
	identity fs.FileInfo

	closeOnce sync.Once
	closeErr  error
}

// NewUnixControlListener creates and binds a Unix-only HTTP listener. The
// socket's parent directory must be owner-controlled and mode 0700. A stale
// Unix stream socket is removed, but every other existing path is rejected.
// The caller should call Serve and defer Shutdown.
func NewUnixControlListener(socketPath string, handler http.Handler, options UnixControlListenerOptions) (*UnixControlListener, error) {
	if handler == nil {
		return nil, errors.New("control listener handler is required")
	}
	absPath, err := filepath.Abs(socketPath)
	if err != nil || absPath != filepath.Clean(socketPath) {
		return nil, fmt.Errorf("control socket path must be absolute and clean: %q", socketPath)
	}
	if filepath.Base(absPath) == "." || filepath.Base(absPath) == string(filepath.Separator) {
		return nil, fmt.Errorf("control socket path must name a socket: %q", socketPath)
	}

	mode := options.SocketMode
	if mode == 0 {
		mode = defaultControlSocketMode
	}
	if mode != mode.Perm() || mode&0o007 != 0 || mode&0o600 != 0o600 {
		return nil, fmt.Errorf("control socket mode %04o must grant owner read/write and no world access", mode)
	}
	groupMode := options.GroupID != nil
	if groupMode && mode&0o060 != 0o060 {
		return nil, fmt.Errorf("shared control socket mode %04o must grant group read/write", mode)
	}
	if !groupMode && mode&0o070 != 0 {
		return nil, fmt.Errorf("control socket group access requires an explicit group id")
	}
	if err := prepareControlSocketDirectory(filepath.Dir(absPath), options.GroupID); err != nil {
		return nil, err
	}
	if err := removeStaleControlSocket(absPath); err != nil {
		return nil, err
	}

	addr := &net.UnixAddr{Name: absPath, Net: "unix"}
	listener, err := net.ListenUnix("unix", addr)
	if err != nil {
		return nil, fmt.Errorf("listen on control socket %q: %w", absPath, err)
	}
	// Disable net.UnixListener's unconditional unlink-on-close behavior. The
	// identity-checked shutdown path below must not remove a replacement path.
	listener.SetUnlinkOnClose(false)
	cleanup := func() {
		_ = listener.Close()
		_ = os.Remove(absPath)
	}
	if err := os.Chmod(absPath, mode); err != nil {
		cleanup()
		return nil, fmt.Errorf("set control socket mode: %w", err)
	}
	if groupMode {
		if err := os.Chown(absPath, os.Geteuid(), *options.GroupID); err != nil {
			cleanup()
			return nil, fmt.Errorf("set control socket group: %w", err)
		}
	}
	identity, err := os.Lstat(absPath)
	if err != nil {
		cleanup()
		return nil, fmt.Errorf("inspect bound control socket: %w", err)
	}

	return &UnixControlListener{
		path: absPath, listener: listener, identity: identity,
		server: &http.Server{
			Handler:           handler,
			ReadHeaderTimeout: 5 * time.Second,
			ReadTimeout:       10 * time.Second,
			WriteTimeout:      30 * time.Second,
			IdleTimeout:       60 * time.Second,
			MaxHeaderBytes:    16 << 10,
		},
	}, nil
}

// Path returns the absolute filesystem path of the bound socket.
func (l *UnixControlListener) Path() string { return l.path }

// Serve blocks while serving HTTP. Shutdown causes Serve to return nil.
func (l *UnixControlListener) Serve() error {
	err := l.server.Serve(l.listener)
	if errors.Is(err, http.ErrServerClosed) || errors.Is(err, net.ErrClosed) {
		return nil
	}
	return err
}

// Shutdown stops the HTTP server and removes the socket if the path still
// refers to the socket created by this listener. It is safe to call repeatedly.
func (l *UnixControlListener) Shutdown(ctx context.Context) error {
	l.closeOnce.Do(func() {
		serverErr := l.server.Shutdown(ctx)
		listenerErr := l.listener.Close()
		removeErr := removeOwnedControlSocket(l.path, l.identity)
		l.closeErr = errors.Join(ignoreClosedError(serverErr), ignoreClosedError(listenerErr), removeErr)
	})
	return l.closeErr
}

func prepareControlSocketDirectory(dir string, groupID *int) error {
	wantMode := fs.FileMode(0o700)
	if groupID != nil {
		// Group members need search permission to connect to the 0660 socket,
		// but no directory write permission: they cannot unlink or replace it.
		wantMode = 0o750
	}
	_, statErr := os.Lstat(dir)
	created := errors.Is(statErr, fs.ErrNotExist)
	if statErr != nil && !created {
		return fmt.Errorf("inspect control socket directory %q: %w", dir, statErr)
	}
	if created {
		if err := os.MkdirAll(dir, wantMode); err != nil {
			return fmt.Errorf("create control socket directory %q: %w", dir, err)
		}
		if err := os.Chmod(dir, wantMode); err != nil {
			return fmt.Errorf("set control socket directory mode: %w", err)
		}
		if groupID != nil {
			if err := os.Chown(dir, os.Geteuid(), *groupID); err != nil {
				return fmt.Errorf("set control socket directory group: %w", err)
			}
		}
	}
	info, err := os.Lstat(dir)
	if err != nil {
		return fmt.Errorf("inspect control socket directory %q: %w", dir, err)
	}
	if !info.IsDir() || info.Mode()&fs.ModeSymlink != 0 {
		return fmt.Errorf("control socket directory %q is not a directory", dir)
	}
	if info.Mode().Perm() != wantMode {
		return fmt.Errorf("control socket directory %q has mode %04o; require %04o", dir, info.Mode().Perm(), wantMode)
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || int(stat.Uid) != os.Geteuid() {
		return fmt.Errorf("control socket directory %q is not owned by the current user", dir)
	}
	if groupID != nil && int(stat.Gid) != *groupID {
		return fmt.Errorf("control socket directory %q has gid %d; require %d", dir, stat.Gid, *groupID)
	}
	return nil
}

func removeStaleControlSocket(socketPath string) error {
	before, err := os.Lstat(socketPath)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect existing control socket path: %w", err)
	}
	if before.Mode()&fs.ModeSocket == 0 {
		return fmt.Errorf("refusing to replace unsafe existing control socket path %q", socketPath)
	}

	conn, dialErr := net.DialTimeout("unix", socketPath, 250*time.Millisecond)
	if dialErr == nil {
		_ = conn.Close()
		return fmt.Errorf("control socket %q is already active", socketPath)
	}
	if !errors.Is(dialErr, syscall.ECONNREFUSED) && !errors.Is(dialErr, fs.ErrNotExist) {
		return fmt.Errorf("cannot prove existing control socket %q is stale: %w", socketPath, dialErr)
	}
	after, err := os.Lstat(socketPath)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("reinspect stale control socket: %w", err)
	}
	if !os.SameFile(before, after) {
		return fmt.Errorf("control socket %q changed while checking staleness", socketPath)
	}
	if err := os.Remove(socketPath); err != nil {
		return fmt.Errorf("remove stale control socket: %w", err)
	}
	return nil
}

func removeOwnedControlSocket(socketPath string, identity fs.FileInfo) error {
	current, err := os.Lstat(socketPath)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect control socket during shutdown: %w", err)
	}
	if !os.SameFile(identity, current) {
		return nil
	}
	if err := os.Remove(socketPath); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("remove control socket during shutdown: %w", err)
	}
	return nil
}

func ignoreClosedError(err error) error {
	if errors.Is(err, http.ErrServerClosed) || errors.Is(err, net.ErrClosed) {
		return nil
	}
	return err
}
