package main

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/DigiBugCat/finch/bar/internal/autostart"
	"github.com/DigiBugCat/finch/bar/internal/finch"
)

// The docs page (web/app/docs/menu-bar) tells people what to download and
// what finch-bar needs. These checks keep it in step with the release
// workflow and the code.

func readRepoFile(t *testing.T, rel string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", rel))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestDocsAssetsAreTheOnesReleased(t *testing.T) {
	docs := readRepoFile(t, "web/app/docs/menu-bar/page.tsx")
	release := readRepoFile(t, ".github/workflows/release.yml")
	sign := readRepoFile(t, "bar/scripts/sign-macos.sh")
	linux := readRepoFile(t, "bar/scripts/package-linux.sh")

	assets := regexp.MustCompile(`finch-bar-[a-z0-9$-]+\.(?:zip|tar\.gz)`).FindAllString(docs, -1)
	seen := map[string]bool{}
	for _, asset := range assets {
		seen[asset] = true
		switch {
		case strings.HasPrefix(asset, "finch-bar-darwin-"):
			if !strings.Contains(sign, `asset="`+asset+`"`) {
				t.Errorf("docs name %s, which sign-macos.sh never produces", asset)
			}
		case asset == "finch-bar-linux-$arch.tar.gz":
			if !strings.Contains(linux, `name="finch-bar-linux-$arch"`) || !strings.Contains(release, "finch-bar-linux-${{ matrix.arch }}.tar.gz") {
				t.Errorf("docs name %s, which the Linux release job does not upload", asset)
			}
		default:
			t.Errorf("docs name an asset the release does not produce: %s", asset)
		}
	}
	for _, want := range []string{"finch-bar-darwin-universal.zip", "finch-bar-linux-$arch.tar.gz"} {
		if !seen[want] {
			t.Errorf("the docs no longer mention %s", want)
		}
	}
	for _, arch := range []string{"arch: amd64", "arch: arm64"} {
		if !strings.Contains(release, arch) {
			t.Errorf("release.yml does not build %s, which the docs promise", arch)
		}
	}
}

func TestDocsRequirementsMatchTheCode(t *testing.T) {
	docs := readRepoFile(t, "web/app/docs/menu-bar/page.tsx")
	for _, want := range []string{
		"finch " + finch.MinVersion + " or later",
		autostart.Label + ".plist",
		"~/.config/autostart/finch-bar.desktop",
		"--install-login-item",
		"--uninstall-login-item",
		"FINCH_BAR_FINCH",
		"AppIndicator and\n          KStatusNotifierItem Support",
	} {
		if !strings.Contains(docs, want) {
			t.Errorf("the menu bar docs do not say %q", want)
		}
	}
	plist := readRepoFile(t, "bar/packaging/darwin/Info.plist")
	if !strings.Contains(plist, "<string>"+autostart.Label+"</string>") || !strings.Contains(plist, "<key>LSUIElement</key>\n\t<true/>") {
		t.Error("Info.plist must use the bundle id " + autostart.Label + " and set LSUIElement")
	}
	if !strings.Contains(plist, "<key>CFBundleExecutable</key>\n\t<string>finch-bar</string>") {
		t.Error("the docs run /Applications/finch-bar.app/Contents/MacOS/finch-bar; Info.plist must name that executable")
	}
}

// Neither install puts finch-bar on PATH right away: macOS installs only the
// .app, and ~/.local/bin often joins PATH at the next login. So every command
// the docs and the Linux README.txt give runs finch-bar by its full path.
func TestInstructionsRunFinchBarByFullPath(t *testing.T) {
	docs := readRepoFile(t, "web/app/docs/menu-bar/page.tsx")
	readme := readRepoFile(t, "bar/scripts/package-linux.sh")
	bare := regexp.MustCompile(`(?m)^\s*finch-bar (--|&)`)
	for name, text := range map[string]string{"the menu bar docs": docs, "README.txt": readme} {
		if m := bare.FindString(text); m != "" {
			t.Errorf("%s run finch-bar by name (%q); use its full path", name, strings.TrimSpace(m))
		}
	}
	for _, want := range []string{
		"/Applications/finch-bar.app/Contents/MacOS/finch-bar --uninstall-login-item",
		"rm -f ~/Library/LaunchAgents/" + autostart.Label + ".plist",
		"~/.local/bin/finch-bar &amp;",
		"Exec=$HOME/.local/bin/finch-bar",
		"finch-bar-darwin-universal-unsigned.zip",
	} {
		if !strings.Contains(docs, want) {
			t.Errorf("the menu bar docs do not say %q", want)
		}
	}
	if !strings.Contains(readme, `Exec=\$HOME/.local/bin/finch-bar`) {
		t.Error("README.txt no longer writes the application-menu entry with finch-bar's full path")
	}
}
