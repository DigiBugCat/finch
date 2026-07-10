//go:build !unix

package core

import (
	"fmt"
	"os"
)

// Platforms without Unix domain sockets retain the legacy finch.yml runtime.
// Dynamic registration remains unavailable until an equivalently local,
// authenticated control transport is designed for them.
func runConfig(cfg *config) { runLegacyConfig(cfg) }

func runAviaryServe(args []string) {
	if len(args) != 0 {
		fmt.Fprintln(os.Stderr, "usage: finch aviary serve")
		os.Exit(2)
	}
	fmt.Fprintln(os.Stderr, "finch: aviary serve requires Unix domain socket support")
	os.Exit(1)
}
