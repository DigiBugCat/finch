package core

// `finch update` and the hub-pushed remote update: fetch the release binary for
// this platform from the box's own hub, swap it atomically over this
// executable, and bring the running serve onto it.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"time"
)

// runUpdate: finch update [--hub URL] [--force] [--restart=auto|service|self|none] [--json]
//
// Restart strategy for the RUNNING serve (never leave two `finch run`
// processes fighting over the relay socket — the "superseded" flap):
//
//	service — if `finch service install` (launchd / systemd --user) manages the
//	          serve, restart it through the service manager: the old process
//	          stops BEFORE the new one starts.
//	self    — exec the freshly installed binary over THIS process (only when
//	          this process is the serve).
//	auto    — service when a managed serve is running, else self when this
//	          process serves, else none.
//	none    — swap the binary only; restart the serve yourself.
func runUpdate(c *cli, args []string) error {
	fs := newFlagSet("update")
	hubFlag := fs.String("hub", "", "finch hub base URL (defaults to the logged-in hub)")
	force := fs.Bool("force", false, "reinstall even if already on the latest version")
	restart := fs.String("restart", "auto", "how to restart the running serve: auto|service|self|none")
	fs.Bool("json", false, "JSON output")
	pos, err := c.parseArgs(fs, args)
	if err != nil {
		return err
	}
	if len(pos) != 0 {
		return usageError("update takes no positional arguments")
	}
	mode, err := resolveUpdateRestartMode(*restart, managedServeRunning(), runningAsServe())
	if err != nil {
		return usageError("%v", err)
	}

	// Hub: explicit flag, else the logged-in cli.json hub, else the prod default.
	hub := *hubFlag
	if hub == "" {
		if cred, _ := readCliCred(); cred != nil && cred.Hub != "" {
			hub = cred.Hub
		} else {
			hub = "https://finchmcp.com"
		}
	}
	hub = strings.TrimRight(hub, "/")

	self, updated, err := performUpdate(hub, *force)
	if err != nil {
		return newCLIError(codeUpstream, "", "update failed: %v", err)
	}
	if !updated {
		if c.json {
			return c.emit(map[string]any{"updated": false, "version": agentVersion})
		}
		c.printf("finch: already on the latest version (%s)\n", agentVersion)
		return nil
	}
	c.printf("finch: installed new binary at %s\n", self)

	switch mode {
	case "none":
		c.printf("finch: binary swapped — restart your serve to apply ('finch service install' manages this for you).\n")
	case "service":
		c.printf("finch: restarting the finch login service (clean handoff, no supersede)…\n")
		if err := restartManagedService(); err != nil {
			return newCLIError(codeInternal, "finch service install", "binary IS updated, but the service restart failed: %v", err)
		}
		c.printf("finch: service restarted on the new version.\n")
	case "self":
		// Re-exec this process over the new binary. syscall.Exec REPLACES the
		// process image, so a running `finch run` continues as the new version.
		reexec := []string{self}
		if runningAsServe() {
			reexec = append(reexec, "run")
		}
		c.printf("finch: re-exec onto the new binary…\n")
		if err := syscallExec(self, reexec); err != nil {
			return newCLIError(codeInternal, "", "re-exec failed: %v (binary is updated; restart manually)", err)
		}
	}
	if c.json {
		return c.emit(map[string]any{"updated": true, "binary": self, "restart": mode})
	}
	return nil
}

func resolveUpdateRestartMode(requested string, tunnelActive, currentProcessServes bool) (string, error) {
	switch requested {
	case "auto":
		if tunnelActive {
			return "service", nil
		}
		if currentProcessServes {
			return "self", nil
		}
		return "none", nil
	case "service", "none":
		return requested, nil
	case "self":
		if !currentProcessServes {
			return "", fmt.Errorf("--restart=self requires the current process to be serving; use service or none from a separate updater")
		}
		return "self", nil
	default:
		return "", fmt.Errorf("unknown --restart mode %q (use auto|service|self|none)", requested)
	}
}

// performUpdate is the shared self-update core used by BOTH `finch update` (CLI)
// and the hub-pushed remote update (relay "update" frame): version-gate against
// the hub's /api/version (skip when already current, unless force), then fetch
// $HUB/releases/finch-<os>-<arch> and atomically swap it over this executable.
// Returns the resolved binary path and whether a swap actually happened. The
// download source is ALWAYS the box's own hub — never caller-supplied — so a
// forged trigger can at worst cause a re-download of the pinned release.
func performUpdate(hub string, force bool) (self string, updated bool, err error) {
	hub, err = validateHubTransportURL(hub)
	if err != nil {
		return "", false, err
	}
	if !force {
		if latest, verr := hubLatestVersion(hub); verr == nil && latest != "" && latest == agentVersion {
			return "", false, nil
		}
	}
	// Resolve THIS executable's real path — the atomic swap target. Follow the
	// symlink so we replace the actual file, not a symlink into it.
	self, err = os.Executable()
	if err != nil {
		return "", false, fmt.Errorf("cannot locate own binary: %w", err)
	}
	if resolved, rerr := filepath.EvalSymlinks(self); rerr == nil {
		self = resolved
	}
	asset := fmt.Sprintf("finch-%s-%s", runtime.GOOS, updateArch())
	if err := downloadAndSwap(hub+"/releases/"+asset, self); err != nil {
		return self, false, err
	}
	return self, true, nil
}

// updateInFlight makes hub-pushed updates singleflight: repeated "update" frames
// (retries, double-clicks) are dropped while one attempt is running.
var updateInFlight atomic.Bool

// selfUpdateFromHub handles a hub-pushed relay "update" frame: swap the binary
// via performUpdate, then re-exec THIS process in place (same PID — safe under
// systemd and bare alike; the relay drops for ~1s and reconnects as the new
// version, so there are never two serves fighting over the socket). On any
// failure it logs and keeps serving on the old binary — a broken update must
// never take the box offline.
func selfUpdateFromHub(hub string) {
	if !updateInFlight.CompareAndSwap(false, true) {
		return
	}
	defer updateInFlight.Store(false)
	self, updated, err := performUpdate(hub, false)
	if err != nil {
		log.Printf("finch: hub-pushed update failed: %v (still serving on %s)", err, agentVersion)
		return
	}
	if !updated {
		log.Printf("finch: hub-pushed update: already on the latest version (%s)", agentVersion)
		return
	}
	log.Printf("finch: hub-pushed update installed — re-exec onto the new binary")
	if err := syscallExec(self, os.Args); err != nil {
		log.Printf("finch: re-exec failed: %v (binary is updated; restart to apply)", err)
	}
}

// updateArch maps Go's GOARCH to the goreleaser asset arch suffix (arm → armv6/
// armv7 by GOARM). Matches the naming in .goreleaser.yaml and installScript().
func updateArch() string {
	switch runtime.GOARCH {
	case "arm":
		if os.Getenv("GOARM") == "7" {
			return "armv7"
		}
		return "armv6"
	default:
		return runtime.GOARCH // amd64, arm64
	}
}

// hubLatestVersion asks the hub for the current LATEST_AGENT so `finch update`
// can no-op when already current. Best-effort: any error → "" (caller updates
// anyway). The hub exposes it at /api/version (public, unauthenticated).
func hubLatestVersion(hub string) (string, error) {
	validatedHub, err := validateHubTransportURL(hub)
	if err != nil {
		return "", err
	}
	hub = validatedHub
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, hub+"/api/version", nil)
	if err != nil {
		return "", err
	}
	res, err := secureRedirectHTTPClient.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return "", fmt.Errorf("hub %d", res.StatusCode)
	}
	payload, err := io.ReadAll(io.LimitReader(res.Body, maxVersionResponseBytes+1))
	if err != nil {
		return "", err
	}
	if int64(len(payload)) > maxVersionResponseBytes {
		return "", fmt.Errorf("version response exceeded %d bytes", maxVersionResponseBytes)
	}
	var body struct {
		Latest string `json:"latest"`
	}
	if err := json.Unmarshal(payload, &body); err != nil {
		return "", err
	}
	return body.Latest, nil
}

const (
	maxVersionResponseBytes int64 = 64 << 10
	maxAgentDownloadBytes   int64 = 256 << 20
	agentDownloadTimeout          = 10 * time.Minute
)

// downloadAndSwap fetches url to a temp file NEXT TO dst (same dir → atomic
// rename), makes it executable, then renames it over dst. Downloading to a temp
// first means a failed/partial download never bricks the running binary; the
// rename is atomic on POSIX so there's no torn-write window.
func downloadAndSwap(url, dst string) error {
	ctx, cancel := context.WithTimeout(context.Background(), agentDownloadTimeout)
	defer cancel()
	return downloadAndSwapWithLimit(ctx, url, dst, maxAgentDownloadBytes)
}

func downloadAndSwapWithLimit(ctx context.Context, url, dst string, limit int64) error {
	if limit <= 0 {
		return fmt.Errorf("invalid Finch update size limit")
	}
	if err := validateHTTPTransportURL(url); err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	res, err := secureRedirectHTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return fmt.Errorf("download %s: hub %d", url, res.StatusCode)
	}
	if res.ContentLength > limit {
		return fmt.Errorf("download %s exceeds %d bytes", url, limit)
	}
	dir := filepath.Dir(dst)
	tmp, err := os.CreateTemp(dir, ".finch-update-*")
	if err != nil {
		return fmt.Errorf("temp file in %s: %w (need write access to install dir)", dir, err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) // no-op after a successful rename
	written, err := io.Copy(tmp, io.LimitReader(res.Body, limit+1))
	if err != nil {
		tmp.Close()
		return err
	}
	if written == 0 {
		tmp.Close()
		return fmt.Errorf("download %s was empty", url)
	}
	if written > limit {
		tmp.Close()
		return fmt.Errorf("download %s exceeds %d bytes", url, limit)
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmpName, 0o755); err != nil {
		return err
	}
	if err := os.Rename(tmpName, dst); err != nil {
		return fmt.Errorf("installing over %s: %w", dst, err)
	}
	return nil
}
