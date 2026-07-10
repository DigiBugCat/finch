//go:build !unix

package core

// Platforms without Unix domain sockets retain the legacy finch.yml runtime.
// Dynamic registration remains unavailable until an equivalently local,
// authenticated control transport is designed for them.
func runConfig(cfg *config) { runLegacyConfig(cfg) }
