//go:build unix

package core

import (
	"context"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type controlRuntimeOptions struct {
	SocketPath                 string
	SocketMode                 fs.FileMode
	GroupID                    *int
	AllowedVerificationOrigins []string
	RunRelay                   relayRunFunc
}

func runConfig(cfg *config) {
	options, err := controlRuntimeOptionsFromEnv()
	if err != nil {
		log.Fatalf("finch: %v", err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := runControlRuntime(ctx, cfg, options); err != nil {
		log.Fatalf("finch: %v", err)
	}
}

func runControlRuntime(ctx context.Context, cfg *config, options controlRuntimeOptions) error {
	if cfg == nil {
		return fmt.Errorf("config is required")
	}
	if cfg.CredentialsDir == "" {
		cfg.CredentialsDir = filepath.Dir(defaultStatePath())
	}
	if _, err := enrollmentVerificationOrigins(cfg.hubBase(), options.AllowedVerificationOrigins); err != nil {
		return fmt.Errorf("configure Aviary verification origins: %w", err)
	}
	release, ok := lockState(filepath.Join(cfg.CredentialsDir, "finch-run"))
	if !ok {
		return fmt.Errorf("another finch run already serves %s — refusing to start a second relay", cfg.CredentialsDir)
	}
	defer release()
	registry := NewDynamicRegistry(staticServicesFromConfig(cfg))
	controlHandler := NewControlHandler(registry)
	enrollment, err := NewServiceEnrollmentCoordinator(ServiceEnrollmentCoordinatorOptions{
		Hub: cfg.Hub, Machine: cfg.Box, CredentialDirectory: cfg.CredentialsDir, HTTPClient: controlPlaneHTTPClient,
		AllowedVerificationOrigins: options.AllowedVerificationOrigins,
		OnCredential:               func(string) { registry.NotifyCredentialChanged() },
	})
	if err != nil {
		return fmt.Errorf("configure service enrollment: %w", err)
	}
	enrollmentHandler := NewServiceEnrollmentControlHandler(enrollment)
	mux := http.NewServeMux()
	mux.Handle("POST /v1/enrollments", enrollmentHandler)
	mux.Handle("GET /v1/enrollments/{id}", enrollmentHandler)
	mux.Handle("/", controlHandler)
	listener, err := NewUnixControlListener(options.SocketPath, mux, UnixControlListenerOptions{
		SocketMode: options.SocketMode,
		GroupID:    options.GroupID,
	})
	if err != nil {
		return err
	}
	serveErr := make(chan error, 1)
	listenerFailure := make(chan error, 1)
	go func() { serveErr <- listener.Serve() }()
	// Preserve legacy best-effort self-approval without gating the control
	// socket or any relay on an optional admin API call. Each service is
	// independent so one hung legacy hub request cannot block its siblings.
	autoApproveStaticServicesAsync(cfg)

	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() {
		if err := <-serveErr; err != nil {
			log.Printf("finch: control listener failed: %v", err)
			listenerFailure <- err
		}
		cancel()
	}()

	runner := options.RunRelay
	if runner == nil {
		runner = configRelayRunner(cfg, registry)
	}
	log.Printf("finch: control socket ready at %s; %d static service(s)", listener.Path(), len(cfg.Ingress))
	reconcileErr := runRelayReconciler(runCtx, registry, runner)

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer shutdownCancel()
	if err := listener.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("shut down control listener: %w", err)
	}
	select {
	case err := <-listenerFailure:
		return fmt.Errorf("control listener failed: %w", err)
	default:
	}
	return reconcileErr
}

func autoApproveStaticServicesAsync(cfg *config) {
	cred := loadCliCredQuiet()
	if cred == nil || cred.Hub != cfg.hubBase() {
		return
	}
	for _, ing := range cfg.Ingress {
		appPath := ing.AppPath
		go func() {
			if err := cliApprove(cred, appPath); err != nil {
				log.Printf("finch[%s]: auto-approve skipped (%v) — approve in the dashboard if it stays pending", appPath, err)
			}
		}()
	}
}

func controlRuntimeOptionsFromEnv() (controlRuntimeOptions, error) {
	options := controlRuntimeOptions{SocketPath: defaultControlSocketPath(), SocketMode: 0o600}
	if value := strings.TrimSpace(os.Getenv("FINCH_CONTROL_SOCKET")); value != "" {
		options.SocketPath = value
	}

	groupValue := strings.TrimSpace(os.Getenv("FINCH_CONTROL_GROUP"))
	if groupValue != "" {
		gid, err := lookupControlGroup(groupValue)
		if err != nil {
			return options, err
		}
		options.GroupID = &gid
		options.SocketMode = 0o660
	}
	if value := strings.TrimSpace(os.Getenv("FINCH_CONTROL_SOCKET_MODE")); value != "" {
		n, err := strconv.ParseUint(strings.TrimPrefix(value, "0o"), 8, 32)
		if err != nil {
			return options, fmt.Errorf("FINCH_CONTROL_SOCKET_MODE %q is not an octal mode", value)
		}
		options.SocketMode = fs.FileMode(n)
	}
	if options.SocketMode&0o070 != 0 && options.GroupID == nil {
		return options, fmt.Errorf("FINCH_CONTROL_SOCKET_MODE grants group access but FINCH_CONTROL_GROUP is not set")
	}
	if value := strings.TrimSpace(os.Getenv("FINCH_AVIARY_VERIFICATION_ORIGINS")); value != "" {
		for _, origin := range strings.Split(value, ",") {
			origin = strings.TrimSpace(origin)
			if origin == "" {
				return options, fmt.Errorf("FINCH_AVIARY_VERIFICATION_ORIGINS contains an empty origin")
			}
			options.AllowedVerificationOrigins = append(options.AllowedVerificationOrigins, origin)
		}
		if len(options.AllowedVerificationOrigins) > 8 {
			return options, fmt.Errorf("FINCH_AVIARY_VERIFICATION_ORIGINS allows at most 8 origins")
		}
	}
	return options, nil
}

func defaultControlSocketPath() string {
	if runtimeDir := strings.TrimSpace(os.Getenv("XDG_RUNTIME_DIR")); runtimeDir != "" {
		return filepath.Join(runtimeDir, "finch", "control.sock")
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		fallback, _ := filepath.Abs(filepath.Join(".finch", "run", "control.sock"))
		return fallback
	}
	return filepath.Join(home, ".finch", "run", "control.sock")
}

func lookupControlGroup(value string) (int, error) {
	if gid, err := strconv.Atoi(value); err == nil {
		if gid < 0 {
			return 0, fmt.Errorf("FINCH_CONTROL_GROUP must be a non-negative gid or group name")
		}
		return gid, nil
	}
	group, err := user.LookupGroup(value)
	if err != nil {
		return 0, fmt.Errorf("look up FINCH_CONTROL_GROUP %q: %w", value, err)
	}
	gid, err := strconv.Atoi(group.Gid)
	if err != nil || gid < 0 {
		return 0, fmt.Errorf("group %q returned invalid gid %q", value, group.Gid)
	}
	return gid, nil
}
