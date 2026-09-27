package icons

import (
	"bytes"
	"image"
	"image/png"
	"os"
	"testing"

	"github.com/DigiBugCat/finch/bar/internal/iconspec"
	"github.com/DigiBugCat/finch/bar/internal/svgicon"
)

func decode(t *testing.T, b []byte) image.Image {
	t.Helper()
	img, err := png.Decode(bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	return img
}

func TestEveryStateHasIcons(t *testing.T) {
	for _, s := range []State{OK, Busy, Alert, Idle} {
		tmpl, regular := For(s)
		if got := decode(t, tmpl).Bounds().Dx(); got != 32 {
			t.Errorf("%v template is %dpx wide, want 32", s, got)
		}
		if got := decode(t, regular).Bounds().Dx(); got != 64 {
			t.Errorf("%v regular is %dpx wide, want 64", s, got)
		}
	}
}

func TestTemplatesAreBlackAndAlpha(t *testing.T) {
	// macOS tints a template by its alpha; any color would be discarded, and
	// a white pixel would vanish in light mode.
	for _, s := range []State{OK, Busy, Alert, Idle} {
		tmpl, _ := For(s)
		img := decode(t, tmpl)
		b := img.Bounds()
		opaque := 0
		for y := b.Min.Y; y < b.Max.Y; y++ {
			for x := b.Min.X; x < b.Max.X; x++ {
				r, g, bl, a := img.At(x, y).RGBA()
				if r != 0 || g != 0 || bl != 0 {
					t.Fatalf("%v template has a colored pixel at (%d,%d)", s, x, y)
				}
				if a > 0 {
					opaque++
				}
			}
		}
		if opaque < 100 {
			t.Fatalf("%v template is nearly empty (%d pixels)", s, opaque)
		}
	}
}

func TestStatesLookDifferent(t *testing.T) {
	seen := map[string]State{}
	for _, s := range []State{OK, Busy, Alert, Idle} {
		tmpl, regular := For(s)
		for _, b := range [][]byte{tmpl, regular} {
			if other, dup := seen[string(b)]; dup {
				t.Fatalf("%v and %v share an icon", s, other)
			}
			seen[string(b)] = s
		}
	}
}

// TestCommittedIconsMatchSVG fails when assets/finch.svg or iconspec changed
// without regenerating: run `go generate ./internal/icons`.
func TestCommittedIconsMatchSVG(t *testing.T) {
	f, err := os.Open("../../assets/finch.svg")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	doc, err := svgicon.Parse(f)
	if err != nil {
		t.Fatal(err)
	}
	for _, v := range iconspec.Variants {
		want, err := v.Render(doc)
		if err != nil {
			t.Fatal(err)
		}
		b, err := files.ReadFile(v.File)
		if err != nil {
			t.Fatalf("%s is not committed: %v", v.File, err)
		}
		got := decode(t, b)
		if got.Bounds() != want.Bounds() {
			t.Fatalf("%s is %v, want %v", v.File, got.Bounds(), want.Bounds())
		}
		const tolerance = 3 << 8 // rasterizer rounding differs by architecture
		for y := 0; y < want.Bounds().Dy(); y++ {
			for x := 0; x < want.Bounds().Dx(); x++ {
				r1, g1, b1, a1 := got.At(x, y).RGBA()
				r2, g2, b2, a2 := want.At(x, y).RGBA()
				for _, d := range [][2]uint32{{r1, r2}, {g1, g2}, {b1, b2}, {a1, a2}} {
					if max(d[0], d[1])-min(d[0], d[1]) > tolerance {
						t.Fatalf("%s differs from finch.svg at (%d,%d); run: go generate ./internal/icons", v.File, x, y)
					}
				}
			}
		}
	}
}
