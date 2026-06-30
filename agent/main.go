// Command finch is the appliance agent binary. All logic lives in the importable
// core package (github.com/digibugcat/finch/agent/core) so the same relay engine
// can be embedded elsewhere — e.g. the gomobile-bound Android SDK in ../mobile.
//
// Release builds stamp the version onto core via:
//   -ldflags "-X github.com/digibugcat/finch/agent/core.agentVersion=<v>"
package main

import "github.com/digibugcat/finch/agent/core"

func main() { core.Main() }
