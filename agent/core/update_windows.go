//go:build windows

package core

import (
	"fmt"
	"os"
	"os/exec"
)

// syscallExec has no in-place exec on Windows (no execve). Instead we spawn the
// new binary as a fresh process, inheriting stdio, and exit — the closest clean
// handoff available. A running serve is briefly down until the child's relay
// reconnects, same as the unix self-exec's ~1s blip.
func syscallExec(path string, argv []string) error {
	cmd := exec.Command(path, argv[1:]...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	cmd.Env = os.Environ()
	if err := cmd.Start(); err != nil {
		return err
	}
	fmt.Println("finch: started new binary (pid", cmd.Process.Pid, ")")
	os.Exit(0)
	return nil
}

func runningAsServe() bool {
	return len(os.Args) > 1 && os.Args[1] == "run"
}
