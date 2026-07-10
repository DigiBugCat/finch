//go:build unix

package core

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"strings"
	"time"
)

func readRuntimeServices() ([]ServiceStatus, error) {
	socketPath := defaultControlSocketPath()
	if configured := strings.TrimSpace(os.Getenv("FINCH_CONTROL_SOCKET")); configured != "" {
		socketPath = configured
	}
	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", socketPath)
	}}
	client := &http.Client{Transport: transport, Timeout: time.Second}
	defer transport.CloseIdleConnections()
	resp, err := client.Get("http://finch/v1/services")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("control status returned %s", resp.Status)
	}
	var body struct {
		Services []ServiceStatus `json:"services"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return nil, err
	}
	return body.Services, nil
}
