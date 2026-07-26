package core

import (
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
)

// validateHubTransportURL enforces Finch's transport boundary: a hub outside
// the local machine must use TLS. Plain HTTP remains available for local
// development servers addressed explicitly through localhost or a loopback IP.
func validateHubTransportURL(raw string) (string, error) {
	raw = strings.TrimRight(strings.TrimSpace(raw), "/")
	if raw == "" {
		raw = "https://finchmcp.com"
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.Hostname() == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return "", fmt.Errorf("invalid Finch hub %q", raw)
	}
	switch strings.ToLower(u.Scheme) {
	case "https":
	case "http":
		if !isLoopbackHost(u.Hostname()) {
			return "", fmt.Errorf("insecure Finch hub %q: HTTPS is required for non-loopback hosts", raw)
		}
	default:
		return "", fmt.Errorf("invalid Finch hub %q: expected an http(s) URL", raw)
	}
	return raw, nil
}

// validateRelayTransportURL applies the equivalent rule to the relay plane.
// A Worker-provided connectUrl is untrusted input until this check succeeds.
func validateRelayTransportURL(raw string) error {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Host == "" || u.Hostname() == "" || u.User != nil || u.Fragment != "" {
		return fmt.Errorf("invalid Finch relay URL")
	}
	switch strings.ToLower(u.Scheme) {
	case "wss":
		return nil
	case "ws":
		if isLoopbackHost(u.Hostname()) {
			return nil
		}
		return fmt.Errorf("insecure Finch relay URL: WSS is required for non-loopback hosts")
	default:
		return fmt.Errorf("invalid Finch relay URL: expected a ws(s) URL")
	}
}

// validateHTTPTransportURL protects secondary Finch downloads and redirects.
// It intentionally shares the same localhost-only development exception as
// hub control-plane calls.
func validateHTTPTransportURL(raw string) error {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Host == "" || u.Hostname() == "" || u.User != nil || u.Fragment != "" {
		return fmt.Errorf("invalid Finch HTTP URL")
	}
	switch strings.ToLower(u.Scheme) {
	case "https":
		return nil
	case "http":
		if isLoopbackHost(u.Hostname()) {
			return nil
		}
		return fmt.Errorf("insecure Finch HTTP URL: HTTPS is required for non-loopback hosts")
	default:
		return fmt.Errorf("invalid Finch HTTP URL: expected an http(s) URL")
	}
}

// parseUpstreamTransportURL applies Finch's transport boundary to the final
// agent-to-service hop. Local MCP servers may use plain HTTP over loopback;
// services on any other host must use HTTPS so configuring a LAN or remote
// upstream cannot silently weaken the relay's encrypted transport guarantee.
func parseUpstreamTransportURL(raw string) (*url.URL, error) {
	raw = strings.TrimRight(strings.TrimSpace(raw), "/")
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, fmt.Errorf("upstream %q is not a valid absolute http(s) URL without credentials, query, or fragment", raw)
	}
	switch strings.ToLower(u.Scheme) {
	case "https":
	case "http":
		if !isLocalServiceHost(u.Hostname()) {
			return nil, fmt.Errorf("invalid upstream transport: plaintext HTTP is allowed only for loopback or local container hostnames")
		}
	default:
		return nil, fmt.Errorf("invalid upstream transport: expected an http(s) URL")
	}
	return u, nil
}

func isLocalServiceHost(host string) bool {
	host = strings.TrimSuffix(strings.ToLower(strings.TrimSpace(host)), ".")
	if isLoopbackHost(host) || host == "host.docker.internal" {
		return true
	}
	// Docker Compose and similar container networks expose services through
	// single-label DNS names. Dotted DNS names and non-loopback IPs remain TLS-
	// only so this exception cannot silently cover a LAN or Internet endpoint.
	if host == "" || strings.Contains(host, ".") || net.ParseIP(host) != nil {
		return false
	}
	for i, r := range host {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || (r == '-' && i > 0 && i < len(host)-1) {
			continue
		}
		return false
	}
	return true
}

func isLoopbackHost(host string) bool {
	host = strings.TrimSuffix(strings.ToLower(strings.TrimSpace(host)), ".")
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// secureRedirectPolicy permits normal HTTPS redirects while preventing an
// established TLS request from being redirected onto plaintext. Local HTTP
// development may redirect only to another transport-valid destination.
func secureRedirectPolicy(req *http.Request, via []*http.Request) error {
	if len(via) >= 10 {
		return fmt.Errorf("stopped after 10 Finch redirects")
	}
	if err := validateHTTPTransportURL(req.URL.String()); err != nil {
		return err
	}
	if len(via) > 0 && strings.EqualFold(via[len(via)-1].URL.Scheme, "https") && !strings.EqualFold(req.URL.Scheme, "https") {
		return fmt.Errorf("refusing Finch HTTPS transport downgrade to %q", req.URL.Redacted())
	}
	return nil
}

var secureRedirectHTTPClient = &http.Client{CheckRedirect: secureRedirectPolicy}
