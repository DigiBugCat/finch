// Command genicons renders finch-bar's icons from the SVGs in assets/.
//
//	go run ./tools/genicons -svg assets/finch.svg -out internal/icons
//	    writes the tray icons (internal/icons/*.png, committed and embedded)
//	go run ./tools/genicons -svg assets/finch.svg -out internal/icons -check
//	    fails if the committed tray icons no longer match finch.svg (CI)
//	go run ./tools/genicons -app assets/app-icon.svg -iconset dist/AppIcon.iconset -png dist/finch-bar.png
//	    writes the application icon: a macOS .iconset (for iconutil) and/or
//	    one 256px PNG (the Linux .desktop icon); used at package time
package main

import (
	"bytes"
	"flag"
	"fmt"
	"image"
	"image/png"
	"os"
	"path/filepath"

	"github.com/DigiBugCat/finch/bar/internal/iconspec"
	"github.com/DigiBugCat/finch/bar/internal/svgicon"
)

func main() {
	svgPath := flag.String("svg", "", "tray glyph SVG (assets/finch.svg)")
	out := flag.String("out", "", "directory for the tray icon PNGs")
	check := flag.Bool("check", false, "compare against the PNGs in -out instead of writing them")
	appSVG := flag.String("app", "", "application icon SVG (assets/app-icon.svg)")
	iconset := flag.String("iconset", "", "with -app: write a macOS .iconset directory here")
	pngOut := flag.String("png", "", "with -app: write a 256px PNG here")
	flag.Parse()

	var err error
	switch {
	case *svgPath != "" && *out != "":
		err = trayIcons(*svgPath, *out, *check)
	case *appSVG != "" && (*iconset != "" || *pngOut != ""):
		err = appIcons(*appSVG, *iconset, *pngOut)
	default:
		flag.Usage()
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "genicons:", err)
		os.Exit(1)
	}
}

func parse(path string) (*svgicon.Doc, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	doc, err := svgicon.Parse(f)
	if err != nil {
		return nil, fmt.Errorf("%s: %v", path, err)
	}
	return doc, nil
}

func encode(img image.Image) ([]byte, error) {
	var buf bytes.Buffer
	enc := png.Encoder{CompressionLevel: png.BestCompression}
	if err := enc.Encode(&buf, img); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func trayIcons(svgPath, out string, check bool) error {
	doc, err := parse(svgPath)
	if err != nil {
		return err
	}
	stale := 0
	for _, v := range iconspec.Variants {
		img, err := v.Render(doc)
		if err != nil {
			return fmt.Errorf("%s: %v", v.File, err)
		}
		path := filepath.Join(out, v.File)
		if check {
			if err := compare(path, img); err != nil {
				fmt.Fprintf(os.Stderr, "genicons: %s: %v\n", path, err)
				stale++
			}
			continue
		}
		b, err := encode(img)
		if err != nil {
			return err
		}
		if err := os.WriteFile(path, b, 0o644); err != nil {
			return err
		}
	}
	if stale > 0 {
		return fmt.Errorf("%d tray icon(s) do not match %s; run: go generate ./internal/icons", stale, svgPath)
	}
	return nil
}

// compare checks a committed PNG against a fresh render. It allows a small
// per-channel difference: the rasterizer's accumulation differs by a rounding
// step between amd64 (SIMD) and arm64, which is not a change to the icon.
func compare(path string, want *image.NRGBA) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	got, err := png.Decode(f)
	if err != nil {
		return err
	}
	if got.Bounds() != want.Bounds() {
		return fmt.Errorf("size %v, want %v", got.Bounds().Size(), want.Bounds().Size())
	}
	const tolerance = 3 << 8 // in 16-bit color units
	b := want.Bounds()
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			r1, g1, b1, a1 := got.At(x, y).RGBA()
			r2, g2, b2, a2 := want.At(x, y).RGBA()
			for _, d := range [][2]uint32{{r1, r2}, {g1, g2}, {b1, b2}, {a1, a2}} {
				if diff(d[0], d[1]) > tolerance {
					return fmt.Errorf("pixel (%d,%d) differs from a fresh render", x, y)
				}
			}
		}
	}
	return nil
}

func diff(a, b uint32) uint32 {
	if a > b {
		return a - b
	}
	return b - a
}

// appIconSizes are the macOS .iconset entries iconutil expects.
var appIconSizes = []struct {
	name string
	px   int
}{
	{"icon_16x16.png", 16}, {"icon_16x16@2x.png", 32},
	{"icon_32x32.png", 32}, {"icon_32x32@2x.png", 64},
	{"icon_128x128.png", 128}, {"icon_128x128@2x.png", 256},
	{"icon_256x256.png", 256}, {"icon_256x256@2x.png", 512},
	{"icon_512x512.png", 512}, {"icon_512x512@2x.png", 1024},
}

func appIcons(svgPath, iconset, pngOut string) error {
	doc, err := parse(svgPath)
	if err != nil {
		return err
	}
	layers := make([]svgicon.Layer, 0, len(doc.Shapes))
	for _, s := range doc.Shapes {
		if !s.Hidden {
			layers = append(layers, svgicon.Layer{Shape: s, Fill: s.Fill})
		}
	}
	write := func(path string, px int) error {
		img, err := doc.Render(px, layers)
		if err != nil {
			return err
		}
		b, err := encode(img)
		if err != nil {
			return err
		}
		return os.WriteFile(path, b, 0o644)
	}
	if iconset != "" {
		if err := os.MkdirAll(iconset, 0o755); err != nil {
			return err
		}
		for _, s := range appIconSizes {
			if err := write(filepath.Join(iconset, s.name), s.px); err != nil {
				return err
			}
		}
	}
	if pngOut != "" {
		if err := write(pngOut, 256); err != nil {
			return err
		}
	}
	return nil
}
