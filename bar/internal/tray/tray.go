// Package tray draws finch-bar's menu with fyne.io/systray.
package tray

import (
	"runtime"
	"sync"

	"fyne.io/systray"

	"github.com/DigiBugCat/finch/bar/internal/icons"
	"github.com/DigiBugCat/finch/bar/internal/model"
)

// Tray is the status item: its icon, tooltip and menu.
type Tray struct {
	onAction func(model.Action)

	mu      sync.Mutex
	shape   string
	items   map[string]*systray.MenuItem
	current map[string]model.Item
	icon    icons.State
	iconSet bool
	tooltip string
}

// New returns a Tray that reports clicks to onAction. Call it from
// systray's onReady.
func New(onAction func(model.Action)) *Tray {
	return &Tray{onAction: onAction, items: map[string]*systray.MenuItem{}, current: map[string]model.Item{}}
}

// Render shows a state and its menu, updating items in place when the menu's
// shape is unchanged.
func (t *Tray) Render(st model.State, items []model.Item) {
	t.mu.Lock()
	defer t.mu.Unlock()

	if !t.iconSet || st.Icon != t.icon {
		template, regular := icons.For(st.Icon)
		if runtime.GOOS == "darwin" {
			systray.SetTemplateIcon(template, regular)
		} else {
			systray.SetIcon(regular)
		}
		t.icon, t.iconSet = st.Icon, true
	}
	if tip := "finch: " + st.Headline; tip != t.tooltip {
		systray.SetTooltip(tip)
		t.tooltip = tip
	}

	if shape := model.Shape(items); shape != t.shape {
		systray.ResetMenu()
		t.items = map[string]*systray.MenuItem{}
		t.current = map[string]model.Item{}
		t.build(nil, items)
		t.shape = shape
		return
	}
	for _, it := range model.Flatten(items) {
		mi, ok := t.items[it.ID]
		if !ok {
			continue
		}
		t.apply(mi, t.current[it.ID], it, false)
		t.current[it.ID] = it
	}
}

func (t *Tray) build(parent *systray.MenuItem, items []model.Item) {
	for _, it := range items {
		if it.Separator {
			if parent == nil {
				systray.AddSeparator()
			} else {
				parent.AddSeparator()
			}
			continue
		}
		var mi *systray.MenuItem
		switch {
		case parent == nil && it.Checkbox:
			mi = systray.AddMenuItemCheckbox(it.Title, it.Tooltip, it.Checked)
		case parent == nil:
			mi = systray.AddMenuItem(it.Title, it.Tooltip)
		case it.Checkbox:
			mi = parent.AddSubMenuItemCheckbox(it.Title, it.Tooltip, it.Checked)
		default:
			mi = parent.AddSubMenuItem(it.Title, it.Tooltip)
		}
		t.apply(mi, model.Item{Title: it.Title, Tooltip: it.Tooltip, Checked: it.Checked}, it, true)
		t.items[it.ID] = mi
		t.current[it.ID] = it
		if len(it.Children) > 0 {
			t.build(mi, it.Children)
		} else {
			go t.listen(it.ID, mi)
		}
	}
}

// apply brings a live item from old to it.
func (t *Tray) apply(mi *systray.MenuItem, old, it model.Item, fresh bool) {
	if it.Title != old.Title {
		mi.SetTitle(it.Title)
	}
	if it.Tooltip != old.Tooltip {
		mi.SetTooltip(it.Tooltip)
	}
	if fresh || it.Disabled != old.Disabled {
		if it.Disabled {
			mi.Disable()
		} else {
			mi.Enable()
		}
	}
	if it.Checkbox && it.Checked != old.Checked {
		if it.Checked {
			mi.Check()
		} else {
			mi.Uncheck()
		}
	}
	if fresh || it.Hidden != old.Hidden {
		if it.Hidden {
			mi.Hide()
		} else if !fresh {
			mi.Show()
		}
	}
}

// listen forwards an item's clicks until the item is removed (its channel
// closes on ResetMenu).
func (t *Tray) listen(id string, mi *systray.MenuItem) {
	for range mi.ClickedCh {
		t.mu.Lock()
		it, ok := t.current[id]
		t.mu.Unlock()
		if ok && !it.Disabled && it.Action.Kind != model.ActNone {
			t.onAction(it.Action)
		}
	}
}
