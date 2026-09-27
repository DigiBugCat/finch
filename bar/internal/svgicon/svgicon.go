// Package svgicon rasterizes the small, flat SVGs finch-bar's icons are drawn
// in: filled <path>, <circle> and <rect> elements (no strokes, gradients or
// transforms) inside one viewBox. It is only as big as the icons need, and it
// refuses anything it does not understand rather than drawing it wrong.
package svgicon

import (
	"encoding/xml"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"io"
	"math"
	"strconv"
	"strings"
	"unicode"

	"golang.org/x/image/vector"
)

// Shape is one filled element of the document, in viewBox units.
type Shape struct {
	ID     string
	Fill   color.NRGBA
	Hidden bool
	path   []segment
}

// Doc is a parsed SVG: its viewBox and its shapes in document order.
type Doc struct {
	MinX, MinY, Width, Height float64
	Shapes                    []Shape
}

// Shape returns the shape with the given id.
func (d *Doc) Shape(id string) (Shape, bool) {
	for _, s := range d.Shapes {
		if s.ID == id {
			return s, true
		}
	}
	return Shape{}, false
}

type segKind int

const (
	segMove segKind = iota
	segLine
	segCube
	segClose
)

type segment struct {
	kind segKind
	pts  [3][2]float64
}

// Parse reads an SVG document.
func Parse(r io.Reader) (*Doc, error) {
	dec := xml.NewDecoder(r)
	var doc *Doc
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		se, ok := tok.(xml.StartElement)
		if !ok {
			continue
		}
		attrs := map[string]string{}
		for _, a := range se.Attr {
			attrs[a.Name.Local] = a.Value
		}
		switch se.Name.Local {
		case "svg":
			if doc != nil {
				return nil, fmt.Errorf("nested <svg> is not supported")
			}
			vb, err := numbers(attrs["viewBox"])
			if err != nil || len(vb) != 4 || vb[2] <= 0 || vb[3] <= 0 {
				return nil, fmt.Errorf("<svg> needs a viewBox of four numbers with a positive size, got %q", attrs["viewBox"])
			}
			doc = &Doc{MinX: vb[0], MinY: vb[1], Width: vb[2], Height: vb[3]}
		case "path", "circle", "rect":
			if doc == nil {
				return nil, fmt.Errorf("<%s> outside <svg>", se.Name.Local)
			}
			for _, unsupported := range []string{"transform", "stroke", "style", "opacity", "fill-opacity", "clip-path", "mask", "filter"} {
				if _, ok := attrs[unsupported]; ok {
					return nil, fmt.Errorf("<%s id=%q>: the %s attribute is not supported", se.Name.Local, attrs["id"], unsupported)
				}
			}
			fill, err := parseColor(attrs["fill"])
			if err != nil {
				return nil, fmt.Errorf("<%s id=%q>: %v", se.Name.Local, attrs["id"], err)
			}
			var segs []segment
			switch se.Name.Local {
			case "path":
				segs, err = parsePath(attrs["d"])
			case "circle":
				segs, err = circle(attrs)
			case "rect":
				segs, err = rect(attrs)
			}
			if err != nil {
				return nil, fmt.Errorf("<%s id=%q>: %v", se.Name.Local, attrs["id"], err)
			}
			doc.Shapes = append(doc.Shapes, Shape{
				ID:     attrs["id"],
				Fill:   fill,
				Hidden: attrs["visibility"] == "hidden" || attrs["display"] == "none",
				path:   segs,
			})
		case "g", "defs", "use", "line", "polyline", "polygon", "ellipse", "text", "image", "linearGradient", "radialGradient":
			return nil, fmt.Errorf("<%s> is not supported", se.Name.Local)
		}
	}
	if doc == nil {
		return nil, fmt.Errorf("no <svg> element")
	}
	return doc, nil
}

func numbers(s string) ([]float64, error) {
	fields := strings.FieldsFunc(s, func(r rune) bool { return r == ',' || unicode.IsSpace(r) })
	out := make([]float64, 0, len(fields))
	for _, f := range fields {
		v, err := strconv.ParseFloat(f, 64)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, nil
}

func attrNum(attrs map[string]string, name string, def float64, required bool) (float64, error) {
	s, ok := attrs[name]
	if !ok {
		if required {
			return 0, fmt.Errorf("missing %s", name)
		}
		return def, nil
	}
	v, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	if err != nil {
		return 0, fmt.Errorf("%s: %v", name, err)
	}
	return v, nil
}

func parseColor(s string) (color.NRGBA, error) {
	s = strings.TrimSpace(s)
	if len(s) != 7 || s[0] != '#' {
		return color.NRGBA{}, fmt.Errorf("fill must be a #rrggbb color, got %q", s)
	}
	v, err := strconv.ParseUint(s[1:], 16, 32)
	if err != nil {
		return color.NRGBA{}, fmt.Errorf("fill must be a #rrggbb color, got %q", s)
	}
	return color.NRGBA{R: uint8(v >> 16), G: uint8(v >> 8), B: uint8(v), A: 0xff}, nil
}

// kappa places cubic control points that approximate a quarter circle.
const kappa = 0.5522847498

func circle(attrs map[string]string) ([]segment, error) {
	cx, err := attrNum(attrs, "cx", 0, false)
	if err != nil {
		return nil, err
	}
	cy, err := attrNum(attrs, "cy", 0, false)
	if err != nil {
		return nil, err
	}
	r, err := attrNum(attrs, "r", 0, true)
	if err != nil {
		return nil, err
	}
	if r <= 0 {
		return nil, fmt.Errorf("r must be positive")
	}
	return ellipseArcs(cx, cy, r), nil
}

func ellipseArcs(cx, cy, r float64) []segment {
	k := r * kappa
	return []segment{
		{kind: segMove, pts: [3][2]float64{{cx + r, cy}}},
		{kind: segCube, pts: [3][2]float64{{cx + r, cy + k}, {cx + k, cy + r}, {cx, cy + r}}},
		{kind: segCube, pts: [3][2]float64{{cx - k, cy + r}, {cx - r, cy + k}, {cx - r, cy}}},
		{kind: segCube, pts: [3][2]float64{{cx - r, cy - k}, {cx - k, cy - r}, {cx, cy - r}}},
		{kind: segCube, pts: [3][2]float64{{cx + k, cy - r}, {cx + r, cy - k}, {cx + r, cy}}},
		{kind: segClose},
	}
}

func rect(attrs map[string]string) ([]segment, error) {
	var v [5]float64
	for i, name := range []string{"x", "y", "width", "height", "rx"} {
		n, err := attrNum(attrs, name, 0, name == "width" || name == "height")
		if err != nil {
			return nil, err
		}
		v[i] = n
	}
	x, y, w, h, r := v[0], v[1], v[2], v[3], v[4]
	if w <= 0 || h <= 0 {
		return nil, fmt.Errorf("width and height must be positive")
	}
	r = math.Min(math.Max(r, 0), math.Min(w, h)/2)
	k := r * (1 - kappa)
	return []segment{
		{kind: segMove, pts: [3][2]float64{{x + r, y}}},
		{kind: segLine, pts: [3][2]float64{{x + w - r, y}}},
		{kind: segCube, pts: [3][2]float64{{x + w - k, y}, {x + w, y + k}, {x + w, y + r}}},
		{kind: segLine, pts: [3][2]float64{{x + w, y + h - r}}},
		{kind: segCube, pts: [3][2]float64{{x + w, y + h - k}, {x + w - k, y + h}, {x + w - r, y + h}}},
		{kind: segLine, pts: [3][2]float64{{x + r, y + h}}},
		{kind: segCube, pts: [3][2]float64{{x + k, y + h}, {x, y + h - k}, {x, y + h - r}}},
		{kind: segLine, pts: [3][2]float64{{x, y + r}}},
		{kind: segCube, pts: [3][2]float64{{x, y + k}, {x + k, y}, {x + r, y}}},
		{kind: segClose},
	}, nil
}

// parsePath understands the M, L, H, V, C and Z commands (absolute and
// relative) — everything the finch glyph uses.
func parsePath(d string) ([]segment, error) {
	toks, err := tokenizePath(d)
	if err != nil {
		return nil, err
	}
	var segs []segment
	var cur, start [2]float64
	var cmd byte
	i := 0
	next := func() (float64, error) {
		if i >= len(toks) || toks[i].cmd != 0 {
			return 0, fmt.Errorf("command %c is missing a number", cmd)
		}
		v := toks[i].num
		i++
		return v, nil
	}
	point := func(rel bool) ([2]float64, error) {
		x, err := next()
		if err != nil {
			return [2]float64{}, err
		}
		y, err := next()
		if err != nil {
			return [2]float64{}, err
		}
		if rel {
			return [2]float64{cur[0] + x, cur[1] + y}, nil
		}
		return [2]float64{x, y}, nil
	}
	for i < len(toks) {
		if toks[i].cmd != 0 {
			cmd = toks[i].cmd
			i++
		} else if cmd == 0 {
			return nil, fmt.Errorf("path data must start with a command")
		}
		rel := cmd >= 'a' && cmd <= 'z'
		switch cmd {
		case 'M', 'm':
			p, err := point(rel && len(segs) > 0)
			if err != nil {
				return nil, err
			}
			segs = append(segs, segment{kind: segMove, pts: [3][2]float64{p}})
			cur, start = p, p
			// Further coordinate pairs after a moveto are implicit linetos.
			if cmd == 'M' {
				cmd = 'L'
			} else {
				cmd = 'l'
			}
		case 'L', 'l':
			p, err := point(rel)
			if err != nil {
				return nil, err
			}
			segs = append(segs, segment{kind: segLine, pts: [3][2]float64{p}})
			cur = p
		case 'H', 'h':
			x, err := next()
			if err != nil {
				return nil, err
			}
			if rel {
				x += cur[0]
			}
			cur = [2]float64{x, cur[1]}
			segs = append(segs, segment{kind: segLine, pts: [3][2]float64{cur}})
		case 'V', 'v':
			y, err := next()
			if err != nil {
				return nil, err
			}
			if rel {
				y += cur[1]
			}
			cur = [2]float64{cur[0], y}
			segs = append(segs, segment{kind: segLine, pts: [3][2]float64{cur}})
		case 'C', 'c':
			var pts [3][2]float64
			for j := range pts {
				p, err := point(rel)
				if err != nil {
					return nil, err
				}
				pts[j] = p
			}
			segs = append(segs, segment{kind: segCube, pts: pts})
			cur = pts[2]
		case 'Z', 'z':
			segs = append(segs, segment{kind: segClose})
			cur = start
			if i < len(toks) && toks[i].cmd == 0 {
				return nil, fmt.Errorf("numbers after Z")
			}
		default:
			return nil, fmt.Errorf("path command %c is not supported", cmd)
		}
	}
	if len(segs) == 0 || segs[0].kind != segMove {
		return nil, fmt.Errorf("path data must start with M")
	}
	return segs, nil
}

type pathToken struct {
	cmd byte
	num float64
}

func tokenizePath(d string) ([]pathToken, error) {
	var toks []pathToken
	for i := 0; i < len(d); {
		c := d[i]
		switch {
		case c == ',' || c == ' ' || c == '\t' || c == '\n' || c == '\r':
			i++
		case (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z'):
			if c == 'e' || c == 'E' {
				return nil, fmt.Errorf("unexpected %q in path data", c)
			}
			toks = append(toks, pathToken{cmd: c})
			i++
		default:
			j := i
			if d[j] == '-' || d[j] == '+' {
				j++
			}
			digits := false
			for j < len(d) && ((d[j] >= '0' && d[j] <= '9') || d[j] == '.') {
				digits = true
				j++
			}
			if j < len(d) && (d[j] == 'e' || d[j] == 'E') {
				j++
				if j < len(d) && (d[j] == '-' || d[j] == '+') {
					j++
				}
				for j < len(d) && d[j] >= '0' && d[j] <= '9' {
					j++
				}
			}
			if !digits {
				return nil, fmt.Errorf("unexpected %q in path data", c)
			}
			v, err := strconv.ParseFloat(d[i:j], 64)
			if err != nil {
				return nil, fmt.Errorf("bad number %q in path data", d[i:j])
			}
			toks = append(toks, pathToken{num: v})
			i = j
		}
	}
	return toks, nil
}

// Layer is one shape drawn onto a canvas: filled with Fill, or — when Clear is
// set — erasing whatever is under it (a knock-out) instead. Grow enlarges a
// circle's radius, in viewBox units, so a knock-out can leave a gap around a
// badge.
type Layer struct {
	Shape Shape
	Fill  color.NRGBA
	Clear bool
	Grow  float64
}

// Render draws layers, in order, onto a transparent size×size canvas that
// maps the document's viewBox (which must be square) onto it.
func (d *Doc) Render(size int, layers []Layer) (*image.NRGBA, error) {
	if d.Width != d.Height {
		return nil, fmt.Errorf("viewBox must be square to render a square icon")
	}
	scale := float64(size) / d.Width
	dst := image.NewNRGBA(image.Rect(0, 0, size, size))
	for _, l := range layers {
		segs := l.Shape.path
		if l.Grow != 0 {
			cx, cy, r, ok := circleOf(segs)
			if !ok {
				return nil, fmt.Errorf("shape %q: only circles can grow", l.Shape.ID)
			}
			segs = ellipseArcs(cx, cy, r+l.Grow)
		}
		z := vector.NewRasterizer(size, size)
		tx := func(p [2]float64) (float32, float32) {
			return float32((p[0] - d.MinX) * scale), float32((p[1] - d.MinY) * scale)
		}
		for _, s := range segs {
			switch s.kind {
			case segMove:
				z.MoveTo(tx(s.pts[0]))
			case segLine:
				z.LineTo(tx(s.pts[0]))
			case segCube:
				ax, ay := tx(s.pts[0])
				bx, by := tx(s.pts[1])
				cx, cy := tx(s.pts[2])
				z.CubeTo(ax, ay, bx, by, cx, cy)
			case segClose:
				z.ClosePath()
			}
		}
		mask := image.NewAlpha(dst.Bounds())
		z.DrawOp = draw.Over
		z.Draw(mask, mask.Bounds(), image.Opaque, image.Point{})
		composite(dst, mask, l)
	}
	return dst, nil
}

// composite applies one rasterized layer: source-over for a fill, or a
// coverage-weighted erase for a knock-out.
func composite(dst *image.NRGBA, mask *image.Alpha, l Layer) {
	for i, m := range mask.Pix {
		if m == 0 {
			continue
		}
		p := dst.Pix[i*4 : i*4+4 : i*4+4]
		if l.Clear {
			p[3] = uint8((uint32(p[3])*uint32(255-m) + 127) / 255)
			continue
		}
		// Source-over in straight (non-premultiplied) alpha.
		sa := uint32(l.Fill.A) * uint32(m) / 255
		da := uint32(p[3])
		oa := sa + da*(255-sa)/255
		if oa == 0 {
			continue
		}
		mix := func(s, d uint8) uint8 {
			return uint8((uint32(s)*sa + uint32(d)*da*(255-sa)/255 + oa/2) / oa)
		}
		p[0], p[1], p[2], p[3] = mix(l.Fill.R, p[0]), mix(l.Fill.G, p[1]), mix(l.Fill.B, p[2]), uint8(oa)
	}
}

// circleOf recovers the centre and radius of a shape made by ellipseArcs.
func circleOf(segs []segment) (cx, cy, r float64, ok bool) {
	if len(segs) != 6 || segs[0].kind != segMove || segs[2].kind != segCube {
		return 0, 0, 0, false
	}
	right := segs[0].pts[0]
	left := segs[2].pts[2]
	if right[1] != left[1] {
		return 0, 0, 0, false
	}
	return (right[0] + left[0]) / 2, right[1], (right[0] - left[0]) / 2, true
}
