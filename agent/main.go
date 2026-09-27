// Command finch is the service agent binary and CLI (macOS and Linux). All
// logic lives in the core package (github.com/digibugcat/finch/agent/core).
//
// Release builds stamp the version onto core via:
//
//	-ldflags "-X github.com/digibugcat/finch/agent/core.agentVersion=<v>"
package main

import "github.com/digibugcat/finch/agent/core"

func main() { core.Main() }
