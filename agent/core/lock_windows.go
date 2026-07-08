//go:build windows

package core

// lockState is a no-op on Windows: the duplicate-`finch run` guard targets the
// systemd-vs-manual race on the Linux box, and a Windows tray/service install
// doesn't hit that path. Returns a held lock so callers proceed unguarded.
func lockState(statePath string) (release func(), ok bool) {
	return func() {}, true
}
