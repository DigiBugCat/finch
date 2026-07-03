//go:build tray

package main

import (
	"os"
	"sort"

	"gopkg.in/yaml.v3"
)

// manifest is a read-only view of finch.yml — just enough for the tray to shape
// its menu (service rows + the dashboard link). The relay engine (core) parses
// the same file authoritatively; this never writes it.
type manifest struct {
	Hub     string `yaml:"hub"`
	Box     string `yaml:"box"`
	Ingress []struct {
		AppPath string `yaml:"app_path"`
	} `yaml:"ingress"`
}

func loadManifest(path string) manifest {
	var m manifest
	if b, err := os.ReadFile(path); err == nil {
		_ = yaml.Unmarshal(b, &m)
	}
	return m
}

// readAppPaths returns the manifest's app_paths in a stable (sorted) order so the
// menu rows don't reshuffle between launches.
func readAppPaths(path string) []string {
	set := map[string]struct{}{}
	for _, ing := range loadManifest(path).Ingress {
		if ing.AppPath != "" {
			set[ing.AppPath] = struct{}{}
		}
	}
	return sortedAppPaths(set)
}

// readHub returns the manifest's hub URL, or "" if unset/unreadable.
func readHub(path string) string { return loadManifest(path).Hub }

// readBox returns the manifest's box name, or "" if unset/unreadable.
func readBox(path string) string { return loadManifest(path).Box }

// sortedAppPaths returns the keys of set in stable (sorted) order, so the menu
// rows don't reshuffle between reloads.
func sortedAppPaths(set map[string]struct{}) []string {
	out := make([]string, 0, len(set))
	for k := range set {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
