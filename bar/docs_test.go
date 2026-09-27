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
}
