package core

import (
	"net/http"
	"testing"
	"time"
)

// The hub bounds a /api/cli/call MCP exchange at 25s (worker/src/cli-call.ts
// CLI_CALL_DEADLINE_MS) and only sends response headers once it is done, so the
// CLI must wait longer than that for headers or a slow success looks like a
// transport failure.
func TestRelayCallClientOutlastsHubCallBudget(t *testing.T) {
	const hubBudget = 25 * time.Second
	tr, ok := relayCallHTTPClient.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("relayCallHTTPClient.Transport is %T, want *http.Transport", relayCallHTTPClient.Transport)
	}
	if tr.ResponseHeaderTimeout <= hubBudget {
		t.Fatalf("ResponseHeaderTimeout = %v, must exceed the hub's %v call budget", tr.ResponseHeaderTimeout, hubBudget)
	}
	if relayCallHTTPClient.Timeout <= tr.ResponseHeaderTimeout {
		t.Fatalf("client Timeout %v must exceed ResponseHeaderTimeout %v", relayCallHTTPClient.Timeout, tr.ResponseHeaderTimeout)
	}
	if relayCallHTTPClient.CheckRedirect == nil {
		t.Fatal("relayCallHTTPClient must refuse redirects like the control-plane client")
	}
}
