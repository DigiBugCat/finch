package main

// dialog.go — tiny native input/alert dialogs, so the tray can take text (an
// appliance name + service URL) that a systray menu can't. Uses whatever ships
// with the OS: osascript on macOS, zenity on Linux, PowerShell on Windows. Every
// helper degrades to a no-op / (,"",false) if the tool is missing, so a headless
// box never blocks.

import (
	"os/exec"
	"runtime"
	"strings"
)

// askText prompts for a single line of text, pre-filled with def. Returns the
// entered text and true, or ("", false) if the user cancelled or no dialog tool
// is available.
func askText(title, prompt, def string) (string, bool) {
	switch runtime.GOOS {
	case "darwin":
		// `text returned of (display dialog …)` prints just the entry; a Cancel
		// makes osascript exit non-zero, which we read as "cancelled".
		script := "text returned of (display dialog " + qAS(prompt) +
			" default answer " + qAS(def) +
			" with title " + qAS(title) +
			" buttons {\"Cancel\", \"OK\"} default button \"OK\")"
		out, err := exec.Command("osascript", "-e", script).Output()
		if err != nil {
			return "", false
		}
		return strings.TrimRight(string(out), "\n"), true
	case "linux":
		out, err := exec.Command("zenity", "--entry",
			"--title="+title, "--text="+prompt, "--entry-text="+def).Output()
		if err != nil {
			return "", false
		}
		return strings.TrimRight(string(out), "\n"), true
	case "windows":
		ps := "[void][Reflection.Assembly]::LoadWithPartialName('Microsoft.VisualBasic');" +
			"$r=[Microsoft.VisualBasic.Interaction]::InputBox('" + psEsc(prompt) + "','" + psEsc(title) + "','" + psEsc(def) + "');" +
			"if($r -eq ''){exit 1};[Console]::Out.Write($r)"
		out, err := exec.Command("powershell", "-NoProfile", "-Command", ps).Output()
		if err != nil {
			return "", false
		}
		return strings.TrimRight(string(out), "\r\n"), true
	}
	return "", false
}

// alert shows a short informational dialog (best-effort; never blocks logic).
func alert(title, message string) {
	switch runtime.GOOS {
	case "darwin":
		script := "display dialog " + qAS(message) + " with title " + qAS(title) +
			" buttons {\"OK\"} default button \"OK\" with icon note"
		_ = exec.Command("osascript", "-e", script).Start()
	case "linux":
		_ = exec.Command("zenity", "--info", "--title="+title, "--text="+message).Start()
	case "windows":
		ps := "[void][Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms');" +
			"[System.Windows.Forms.MessageBox]::Show('" + psEsc(message) + "','" + psEsc(title) + "')"
		_ = exec.Command("powershell", "-NoProfile", "-Command", ps).Start()
	}
}

// qAS quotes a Go string as an AppleScript double-quoted literal (escaping \ and ").
func qAS(s string) string {
	s = strings.ReplaceAll(s, "\\", "\\\\")
	s = strings.ReplaceAll(s, "\"", "\\\"")
	return "\"" + s + "\""
}

// psEsc escapes a string for a PowerShell single-quoted literal.
func psEsc(s string) string { return strings.ReplaceAll(s, "'", "''") }
