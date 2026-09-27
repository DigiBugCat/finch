package core

// run_status.go — `finch run`'s local readiness signal. A config run writes
// <credentials-dir>/finch-run.status (0600) with one entry per ingress rule
// and rewrites it on every relay transition: connecting → connected (the hub
// accepted the relay socket), reconnecting (link down, retrying), or
// credential_error (the saved credential is missing or the hub rejected it;
// the relay waits for `finch add` to replace it). `finch service install`
// reads it to tell a serve that is actually connected from a process that is
// merely alive.
//
// Why a local file and not the hub's fleet view (/api/cli/state): the file is
// written by the very process the service manager just started (its pid and
// start time are in it, so a stale file from an earlier run is ignored), it
// names the reason a relay is down (a rejected credential, a dial failure),
// and it needs no CLI login — a box enrolled with a join ticket may have none.
// The hub's per-service "online" flag cannot tell this box's new process from
// another box serving the same service, or from a connection the hub has not
// yet noticed is gone.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Relay states in finch-run.status.
const (
	relayConnecting      = "connecting"
	relayConnected       = "connected"
	relayReconnecting    = "reconnecting"
	relayCredentialError = "credential_error"
)

type relayStatus struct {
	State    string `json:"state"`
	Error    string `json:"error,omitempty"`
	Upstream string `json:"upstream,omitempty"`
	Since    int64  `json:"since"` // unix seconds of the last transition
}

type serveReport struct {
	PID int `json:"pid"`
	// Started is when this `finch run` began serving, in unix nanoseconds.
	Started int64                  `json:"started"`
	Relays  map[string]relayStatus `json:"relays"`
}

// runStatusPath is the status file of a config run over credentialsDir. Its
// name cannot collide with a credential (<app_path>.json) or the run lock.
func runStatusPath(credentialsDir string) string {
	return filepath.Join(credentialsDir, "finch-run.status")
}

func readRunStatus(path string) *serveReport {
	b, err := readCredentialFile(path, credentialStateLimit)
	if err != nil || b == nil {
		return nil
	}
	var st serveReport
	if json.Unmarshal(b, &st) != nil || st.Relays == nil {
		return nil
	}
	return &st
}

// runStatusWriter serializes one run's relay transitions into its status file.
type runStatusWriter struct {
	mu   sync.Mutex
	path string
	st   serveReport
}

func newRunStatusWriter(cfg *config) *runStatusWriter {
	w := &runStatusWriter{
		path: runStatusPath(cfg.CredentialsDir),
		st:   serveReport{PID: os.Getpid(), Started: time.Now().UnixNano(), Relays: map[string]relayStatus{}},
	}
	now := time.Now().Unix()
	for _, ing := range cfg.Ingress {
		w.st.Relays[ing.AppPath] = relayStatus{State: relayConnecting, Upstream: ing.Service, Since: now}
	}
	w.flushLocked()
	return w
}

// reporter returns the transition callback for one relay.
func (w *runStatusWriter) reporter(appPath string) func(state, detail string) {
	return func(state, detail string) {
		w.mu.Lock()
		defer w.mu.Unlock()
		cur := w.st.Relays[appPath]
		if cur.State == state && cur.Error == detail {
			return
		}
		cur.State, cur.Error, cur.Since = state, detail, time.Now().Unix()
		w.st.Relays[appPath] = cur
		w.flushLocked()
	}
}

func (w *runStatusWriter) flushLocked() {
	b, err := json.Marshal(w.st)
	if err != nil {
		return
	}
	// Best effort: a status file that cannot be written only costs
	// `finch service install` its readiness check, never the serve itself.
	_ = writeCredentialFile(w.path, append(b, '\n'))
}

// remove deletes the status file on a clean shutdown, unless another run has
// since replaced it.
func (w *runStatusWriter) remove() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if st := readRunStatus(w.path); st != nil && st.PID == w.st.PID && st.Started == w.st.Started {
		_ = os.Remove(w.path)
	}
}
