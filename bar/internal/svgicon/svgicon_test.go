package svgicon

import (
	"image/color"
	"os"
	"strings"
	"testing"
)

func parseString(t *testing.T, s string) (*Doc, error) {
	t.Helper()
	return Parse(strings.NewReader(s))
}

func TestParseFinchGlyph(t *testing.T) {
	f, err := os.Open("../../assets/finch.svg")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	doc, err := Parse(f)
	if err != nil {
		t.Fatal(err)
	}
	if doc.Width != doc.Height {
		t.Fatalf("viewBox %vx%v is not square", doc.Width, doc.Height)
	}
	for _, id := range []string{"body", "head", "beak", "badge"} {
		if _, ok := doc.Shape(id); !ok {
			t.Errorf("finch.svg has no %q", id)
		}
	}
	if b, _ := doc.Shape("badge"); !b.Hidden {
		t.Error("the badge must be hidden by default")
	}
	if b, _ := doc.Shape("beak"); b.Fill != (color.NRGBA{0xe0, 0xa8, 0x4a, 0xff}) {
		t.Errorf("beak fill = %v, want Indigo Wash ochre", b.Fill)
	}
}

func TestParseRejects(t *testing.T) {
	for name, src := range map[string]string{
		"no viewBox":       `<svg><path fill="#000000" d="M0 0 L1 1 Z"/></svg>`,
		"arc command":      `<svg viewBox="0 0 10 10"><path fill="#000000" d="M0 0 A 5 5 0 0 1 10 10 Z"/></svg>`,
		"transform":        `<svg viewBox="0 0 10 10"><path fill="#000000" transform="scale(2)" d="M0 0 L1 1 Z"/></svg>`,
		"stroke":           `<svg viewBox="0 0 10 10"><path fill="#000000" stroke="#000000" d="M0 0 L1 1 Z"/></svg>`,
		"named color":      `<svg viewBox="0 0 10 10"><path fill="red" d="M0 0 L1 1 Z"/></svg>`,
		"group":            `<svg viewBox="0 0 10 10"><g><path fill="#000000" d="M0 0 L1 1 Z"/></g></svg>`,
		"missing number":   `<svg viewBox="0 0 10 10"><path fill="#000000" d="M0 0 L1 Z"/></svg>`,
		"no leading move":  `<svg viewBox="0 0 10 10"><path fill="#000000" d="L1 1 Z"/></svg>`,
		"zero radius":      `<svg viewBox="0 0 10 10"><circle fill="#000000" cx="5" cy="5" r="0"/></svg>`,
		"not svg":          `<html></html>`,
		"shape before svg": `<path fill="#000000" d="M0 0 L1 1 Z"/>`,
	} {
		if _, err := parseString(t, src); err == nil {
			t.Errorf("%s: parsed", name)
		}
	}
}

func TestParseRelativeAndShorthand(t *testing.T) {
	doc, err := parseString(t, `<svg viewBox="0 0 10 10"><path id="sq" fill="#000000" d="M1 1 h8 v8 H1 z"/></svg>`)
	if err != nil {
		t.Fatal(err)
	}
	img, err := doc.Render(10, []Layer{{Shape: doc.Shapes[0], Fill: color.NRGBA{A: 255}}})
	if err != nil {
		t.Fatal(err)
	}
	if a := img.NRGBAAt(5, 5).A; a != 255 {
		t.Fatalf("inside alpha = %d", a)
	}
	if a := img.NRGBAAt(0, 0).A; a != 0 {
		t.Fatalf("outside alpha = %d", a)
	}
}

func TestRenderKnockOut(t *testing.T) {
	doc, err := parseString(t, `<svg viewBox="0 0 20 20">
		<rect id="bg" fill="#23456b" x="0" y="0" width="20" height="20"/>
		<circle id="dot" fill="#e0a84a" cx="10" cy="10" r="4"/>
	</svg>`)
	if err != nil {
		t.Fatal(err)
	}
	bg, _ := doc.Shape("bg")
	dot, _ := doc.Shape("dot")
	img, err := doc.Render(20, []Layer{
		{Shape: bg, Fill: bg.Fill},
		{Shape: dot, Clear: true, Grow: 2},
		{Shape: dot, Fill: dot.Fill},
	})
	if err != nil {
		t.Fatal(err)
	}
	if c := img.NRGBAAt(10, 10); c != dot.Fill {
		t.Errorf("centre = %v, want the dot", c)
	}
	if a := img.NRGBAAt(14, 10).A; a != 0 { // in the gap: between radius 4 and 6
		t.Errorf("gap alpha = %d, want 0", a)
	}
	if c := img.NRGBAAt(1, 1); c != bg.Fill {
		t.Errorf("corner = %v, want the background", c)
	}
	if _, err := doc.Render(20, []Layer{{Shape: bg, Clear: true, Grow: 1}}); err == nil {
		t.Error("grew a rectangle")
	}
}

func TestRenderNeedsSquareViewBox(t *testing.T) {
	doc, err := parseString(t, `<svg viewBox="0 0 20 10"><circle fill="#000000" cx="5" cy="5" r="2"/></svg>`)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := doc.Render(16, nil); err == nil {
		t.Fatal("rendered a non-square viewBox into a square icon")
	}
}
