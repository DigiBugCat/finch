//go:build tools

// Package tools pins build-only tool dependencies that no binary imports, so
// `go mod tidy` keeps them in go.mod instead of dropping them.
//
// gomobile (and transitively golang.org/x/mobile/bind, the JNI glue) builds the
// Android SDK in ./mobile via scripts/build-aar.sh. This blank import is the
// standard Go tool-dependency pattern; the `tools` build tag means it is never
// part of a normal build, so the CLI binary and the mobile package are
// unaffected — it only influences the module graph.
package tools

import _ "golang.org/x/mobile/cmd/gomobile"
