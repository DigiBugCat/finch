package model

import (
	"strings"
)

// Shape is a menu's structure without its text: item IDs, separators,
// checkboxes and submenus. Two menus with the same shape can be updated in
// place (titles, enabled, checked); a different shape means rebuilding,
// which on macOS would close a menu the user has open, so it happens only
// when items come or go.
func Shape(items []Item) string {
	var b strings.Builder
	writeShape(&b, items)
	return b.String()
}

func writeShape(b *strings.Builder, items []Item) {
	for _, it := range items {
		switch {
		case it.Separator:
			b.WriteString("-|")
		default:
			b.WriteString(it.ID)
			if it.Checkbox {
				b.WriteString("[x]")
			}
			if len(it.Children) > 0 {
				b.WriteString("{")
				writeShape(b, it.Children)
				b.WriteString("}")
			}
			b.WriteString("|")
		}
	}
}

// Flatten lists every non-separator item, parents before their children.
func Flatten(items []Item) []Item {
	var out []Item
	for _, it := range items {
		if it.Separator {
			continue
		}
		out = append(out, it)
		out = append(out, Flatten(it.Children)...)
	}
	return out
}
