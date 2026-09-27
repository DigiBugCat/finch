// Package iconspec defines finch-bar's tray icon variants and how each one is
// drawn from assets/finch.svg. tools/genicons renders them into
// internal/icons, which embeds the PNGs.
package iconspec

import (
	"fmt"
	"image"
	"image/color"

	"github.com/DigiBugCat/finch/bar/internal/svgicon"
)

// State is what the icon tells you at a glance.
type State int

const (
	// OK: every service is connected.
	OK State = iota
	// Busy: something is in progress or waiting on you (sign-in pending,
	// services still connecting).
	Busy
	// Alert: something is wrong (a service offline, the background service
	// stopped, finch unreachable).
	Alert
	// Idle: finch is not set up yet (not installed, too old, not signed in,
	// nothing published).
	Idle
)

func (s State) String() string {
	switch s {
	case OK:
		return "ok"
	case Busy:
		return "busy"
	case Alert:
		return "alert"
	case Idle:
		return "idle"
	}
	return fmt.Sprintf("State(%d)", int(s))
}

// Indigo Wash colors the icons use (tokens.json; the Chalkboard values where a
// color has to read on a dark panel).
var (
	black      = color.NRGBA{A: 0xff}
	indigoWash = color.NRGBA{R: 0x9d, G: 0xb3, B: 0xc8, A: 0xff}
	ochre      = color.NRGBA{R: 0xe0, G: 0xa8, B: 0x4a, A: 0xff}
	leaf       = color.NRGBA{R: 0x8c, G: 0xc0, B: 0xa0, A: 0xff}
	vermilion  = color.NRGBA{R: 0xee, G: 0x8c, B: 0x70, A: 0xff}
)

// Sizes: macOS draws the status item at 16pt, so 32px covers Retina; Linux
// panels scale the pixmap themselves, so 64px leaves room for large panels.
const (
	templateSize = 32
	linuxSize    = 64
)

// badgeGap is the transparent ring (in viewBox units) cut around the badge so
// it reads as separate from the bird at 16pt.
const badgeGap = 1.6

// Variant is one generated tray icon.
type Variant struct {
	File  string
	Size  int
	State State
	// Template marks a macOS template image: only its alpha is used, and the
	// menu bar tints it for light and dark mode.
	Template bool
}

// Variants lists every tray icon, in the order go generate writes them.
var Variants = []Variant{
	{File: "template-ok.png", Size: templateSize, State: OK, Template: true},
	{File: "template-busy.png", Size: templateSize, State: Busy, Template: true},
	{File: "template-alert.png", Size: templateSize, State: Alert, Template: true},
	{File: "template-idle.png", Size: templateSize, State: Idle, Template: true},
	{File: "linux-ok.png", Size: linuxSize, State: OK},
	{File: "linux-busy.png", Size: linuxSize, State: Busy},
	{File: "linux-alert.png", Size: linuxSize, State: Alert},
	{File: "linux-idle.png", Size: linuxSize, State: Idle},
}

// Render draws a variant from the parsed finch.svg.
func (v Variant) Render(doc *svgicon.Doc) (*image.NRGBA, error) {
	need := func(id string) (svgicon.Shape, error) {
		s, ok := doc.Shape(id)
		if !ok {
			return svgicon.Shape{}, fmt.Errorf("finch.svg has no shape with id %q", id)
		}
		return s, nil
	}
	body, err := need("body")
	if err != nil {
		return nil, err
	}
	head, err := need("head")
	if err != nil {
		return nil, err
	}
	beak, err := need("beak")
	if err != nil {
		return nil, err
	}
	badge, err := need("badge")
	if err != nil {
		return nil, err
	}

	birdFill, beakFill := indigoWash, ochre
	if v.Template {
		birdFill, beakFill = black, black
	}
	layers := []svgicon.Layer{
		{Shape: body, Fill: birdFill},
		{Shape: head, Fill: birdFill},
		{Shape: beak, Fill: beakFill},
	}

	switch v.State {
	case OK:
		if !v.Template {
			layers = append(layers, badgeLayers(badge, leaf, false)...)
		}
	case Busy:
		if v.Template {
			layers = append(layers, badgeLayers(badge, black, true)...)
		} else {
			layers = append(layers, badgeLayers(badge, ochre, false)...)
		}
	case Alert:
		if v.Template {
			layers = append(layers, badgeLayers(badge, black, false)...)
		} else {
			layers = append(layers, badgeLayers(badge, vermilion, false)...)
		}
	case Idle:
	default:
		return nil, fmt.Errorf("unknown icon state %d", v.State)
	}
	img, err := doc.Render(v.Size, layers)
	if err != nil || v.State != Idle {
		return img, err
	}
	// Idle is the whole bird faded, drawn opaque first so the head and body
	// do not show a darker overlap where they meet.
	for i := 3; i < len(img.Pix); i += 4 {
		img.Pix[i] = uint8((uint32(img.Pix[i])*idleAlpha + 127) / 255)
	}
	return img, nil
}

// idleAlpha fades the idle icon to about 45%.
const idleAlpha = 115

// badgeLayers cuts a gap around the badge, then paints it: a solid dot, or
// with ring set a hollow one (the template "working on it" mark).
func badgeLayers(badge svgicon.Shape, fill color.NRGBA, ring bool) []svgicon.Layer {
	out := []svgicon.Layer{
		{Shape: badge, Clear: true, Grow: badgeGap},
		{Shape: badge, Fill: fill},
	}
	if ring {
		out = append(out, svgicon.Layer{Shape: badge, Clear: true, Grow: -2.6})
	}
	return out
}
