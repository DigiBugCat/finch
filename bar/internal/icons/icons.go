// Package icons holds finch-bar's tray icons: PNGs generated from
// assets/finch.svg (see iconspec) and embedded in the binary.
//
// macOS gets template images (black plus alpha; the menu bar tints them for
// light and dark mode), so state shows as a badge shape: none when all is
// well, a hollow ring while something is in progress, a solid dot when
// something needs attention, and a dimmed bird when finch is not set up.
// Linux panels do not tint icons, so there the badge carries color instead.
package icons

//go:generate go run ../../tools/genicons -svg ../../assets/finch.svg -out .

import (
	"embed"
	"fmt"

	"github.com/DigiBugCat/finch/bar/internal/iconspec"
)

// State is what the icon tells you at a glance.
type State = iconspec.State

// The icon states.
const (
	OK    = iconspec.OK
	Busy  = iconspec.Busy
	Alert = iconspec.Alert
	Idle  = iconspec.Idle
)

//go:embed *.png
var files embed.FS

// For returns the icon bytes for a state: the macOS template image and the
// colored image other platforms use.
func For(s State) (template, regular []byte) {
	return mustRead(fmt.Sprintf("template-%s.png", s)), mustRead(fmt.Sprintf("linux-%s.png", s))
}

func mustRead(name string) []byte {
	b, err := files.ReadFile(name)
	if err != nil {
		// Every state has a committed PNG; TestEveryStateHasIcons guards it.
		panic("finch-bar: missing embedded icon " + name)
	}
	return b
}
