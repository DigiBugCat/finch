// Command finch-bar is a menu bar companion for the finch CLI on macOS and
// Linux. It has no finch logic of its own: it runs `finch … --json` and shows
// what finch says. See README.md.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"fyne.io/systray"

	"github.com/DigiBugCat/finch/bar/internal/app"
	"github.com/DigiBugCat/finch/bar/internal/autostart"
	"github.com/DigiBugCat/finch/bar/internal/desktop"
	"github.com/DigiBugCat/finch/bar/internal/finch"
	"github.com/DigiBugCat/finch/bar/internal/icons"
	"github.com/DigiBugCat/finch/bar/internal/instance"
	"github.com/DigiBugCat/finch/bar/internal/model"
	"github.com/DigiBugCat/finch/bar/internal/tray"
)

// version is stamped by the release build (-X main.version=1.8.0).
var version = "dev"

const usageText = `finch-bar: finch in your menu bar

Usage:
  finch-bar                         show the menu bar item
  finch-bar --print                 print what the menu shows, then exit
  finch-bar --install-login-item    open finch-bar when you log in
  finch-bar --uninstall-login-item  stop opening it at login
  finch-bar --version               print finch-bar's version

Flags:
  --finch <path>   the finch binary to use (default: finch on PATH, then
                   ~/.local/bin, /usr/local/bin, /opt/homebrew/bin;
                   or set FINCH_BAR_FINCH)

finch-bar runs the finch command-line tool for everything it shows. Install
finch with:  ` + finch.InstallCommand + `
More: https://finchmcp.com/docs/menu-bar
`

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

func run(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("finch-bar", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	finchPath := fs.String("finch", os.Getenv("FINCH_BAR_FINCH"), "")
	install := fs.Bool("install-login-item", false, "")
	uninstall := fs.Bool("uninstall-login-item", false, "")
	printOnly := fs.Bool("print", false, "")
	showVersion := fs.Bool("version", false, "")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			fmt.Fprint(stdout, usageText)
			return 0
		}
		fmt.Fprintf(stderr, "finch-bar: %v\n\n%s", err, usageText)
		return 2
	}
	if fs.NArg() > 0 {
		fmt.Fprintf(stderr, "finch-bar: unexpected argument %q\n\n%s", fs.Arg(0), usageText)
		return 2
	}

	switch {
	case *showVersion:
		fmt.Fprintf(stdout, "finch-bar %s (%s/%s)\n", version, runtime.GOOS, runtime.GOARCH)
		return 0
	case *install && *uninstall:
		fmt.Fprintln(stderr, "finch-bar: pass --install-login-item or --uninstall-login-item, not both")
		return 2
	case *install, *uninstall:
		return loginItemCommand(*install, stdout, stderr)
	}

	home, _ := os.UserHomeDir()
	locate := func() (string, error) { return finch.Locate(*finchPath, os.Getenv("PATH"), home) }

	if *printOnly {
		return printMenu(locate, stdout)
	}

	cache, err := os.UserCacheDir()
	if err != nil {
		cache = filepath.Join(home, ".cache")
	}
	lock, err := instance.Lock(filepath.Join(cache, "finch-bar"))
	if errors.Is(err, instance.ErrRunning) {
		fmt.Fprintln(stderr, "finch-bar: already running (look for the finch in your menu bar)")
		return 0
	}
	if err != nil {
		fmt.Fprintf(stderr, "finch-bar: %v\n", err)
		return 1
	}
	defer lock.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	systray.Run(func() { onReady(ctx, locate) }, cancel)
	return 0
}

func loginItem() (autostart.LoginItem, error) {
	exe, err := os.Executable()
	if err == nil {
		exe, err = filepath.EvalSymlinks(exe)
	}
	if err != nil {
		return autostart.LoginItem{}, fmt.Errorf("could not find finch-bar's own path: %v", err)
	}
	home, _ := os.UserHomeDir()
	return autostart.LoginItem{GOOS: runtime.GOOS, Home: home, ConfigHome: os.Getenv("XDG_CONFIG_HOME"), Exe: exe}, nil
}

func loginItemCommand(install bool, stdout, stderr io.Writer) int {
	li, err := loginItem()
	if err == nil && !li.Supported() {
		err = autostart.ErrUnsupported
	}
	if err != nil {
		fmt.Fprintf(stderr, "finch-bar: %v\n", err)
		return 1
	}
	path, _ := li.Path()
	if install {
		if err := li.Install(); err != nil {
			fmt.Fprintf(stderr, "finch-bar: %v\n", err)
			return 1
		}
		fmt.Fprintf(stdout, "finch-bar will open when you log in (%s)\n", path)
		return 0
	}
	if err := li.Uninstall(); err != nil {
		fmt.Fprintf(stderr, "finch-bar: %v\n", err)
		return 1
	}
	fmt.Fprintf(stdout, "finch-bar won't open at login any more (removed %s)\n", path)
	return 0
}

func newApp(locate func() (string, error), render func(model.State, []model.Item)) *app.App {
	cfg := app.Config{
		Locate:   locate,
		NewFinch: func(bin string) app.Finch { return finch.New(bin) },
		Desktop:  desktop.New(runtime.GOOS),
		Render:   render,
		Quit:     systray.Quit,
	}
	if li, err := loginItem(); err == nil && li.Supported() {
		cfg.LoginItem = li
	}
	return app.New(cfg)
}

func onReady(ctx context.Context, locate func() (string, error)) {
	template, regular := icons.For(icons.Idle)
	if runtime.GOOS == "darwin" {
		systray.SetTemplateIcon(template, regular)
	} else {
		systray.SetIcon(regular)
		systray.SetTitle("finch")
	}
	systray.SetTooltip("finch")

	var a *app.App
	t := tray.New(func(act model.Action) { a.Do(ctx, act) })
	a = newApp(locate, t.Render)
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case <-systray.TrayOpenedCh:
				a.Refresh()
			}
		}
	}()
	go a.Run(ctx)
}

// printMenu polls once and prints the menu as text: the same view as the
// menu bar, for a terminal, a headless box, or a bug report.
func printMenu(locate func() (string, error), stdout io.Writer) int {
	a := newApp(locate, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	a.Poll(ctx)
	writeMenu(stdout, a.Menu(), 0)
	return 0
}

func writeMenu(w io.Writer, items []model.Item, depth int) {
	pad := strings.Repeat("    ", depth)
	for _, it := range items {
		switch {
		case it.Separator:
			if depth == 0 {
				fmt.Fprintln(w, pad+"────────")
			}
		case it.Hidden:
		default:
			mark := "  "
			if it.Checkbox && it.Checked {
				mark = "✓ "
			} else if it.Checkbox {
				mark = "☐ "
			}
			suffix := ""
			if len(it.Children) > 0 {
				suffix = " ▸"
			}
			fmt.Fprintf(w, "%s%s%s%s\n", pad, mark, it.Title, suffix)
			writeMenu(w, it.Children, depth+1)
		}
	}
}
