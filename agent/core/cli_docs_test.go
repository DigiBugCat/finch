package core

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// The agent-facing docs (web/public/agents.md, llms.txt) and the binary's own
// `finch guide` / `finch help` are instructions an agent executes verbatim. Every
// `finch <command> --flag` they show must exist in this binary, so a renamed
// flag or command cannot silently strand the documented flow.

var finchInvocation = regexp.MustCompile(`(?:^|[\s(|&;"'])finch ([a-z][a-z-]*)([^|&;\n"'` + "`" + `]*)`)
var flagToken = regexp.MustCompile(`(?:^|\s)--?([a-z][a-z-]*)`)

// codeSnippets returns the text a reader would run: fenced code blocks and
// inline code spans of a markdown/text file.
func codeSnippets(doc string) []string {
	var out []string
	inFence := false
	for _, line := range strings.Split(doc, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "```") {
			inFence = !inFence
			continue
		}
		if inFence {
			out = append(out, line)
			continue
		}
		parts := strings.Split(line, "`")
		for i := 1; i < len(parts); i += 2 {
			out = append(out, parts[i])
		}
	}
	return out
}

// indentedCommands returns the example lines of `finch guide`/`finch help`.
func indentedCommands(text string) []string {
	var out []string
	for _, line := range strings.Split(text, "\n") {
		if strings.HasPrefix(line, "  finch ") {
			out = append(out, line)
		}
	}
	return out
}

func checkInvocations(t *testing.T, source string, snippets []string) (problems []string, checked int) {
	t.Helper()
	helpCache := map[string]string{}
	for _, snip := range snippets {
		for _, m := range finchInvocation.FindAllStringSubmatch(snip, -1) {
			cmd, rest := m[1], m[2]
			if cmd == "run" || cmd == "join" {
				continue
			}
			if lookupCommand(cmd) == nil {
				problems = append(problems, fmt.Sprintf("%s documents `finch %s`, which is not a command", source, cmd))
				continue
			}
			checked++
			if cmd == "version" || cmd == "guide" || cmd == "help" {
				continue
			}
			help, ok := helpCache[cmd]
			if !ok {
				var out, errOut strings.Builder
				code, _ := runCLI([]string{cmd, "-h"}, strings.NewReader(""), &out, &errOut)
				if code != 0 {
					t.Fatalf("finch %s -h exited %d: %s", cmd, code, errOut.String())
				}
				help = out.String()
				helpCache[cmd] = help
			}
			// Drop the trailing description or comment (two spaces on).
			if i := strings.Index(rest, "  "); i >= 0 {
				rest = rest[:i]
			}
			for _, f := range flagToken.FindAllStringSubmatch(rest, -1) {
				if !strings.Contains(help, "  -"+f[1]+"\n") && !strings.Contains(help, "  -"+f[1]+" ") {
					problems = append(problems, fmt.Sprintf("%s documents `finch %s --%s`, which `finch %s -h` does not define", source, cmd, f[1], cmd))
				}
			}
		}
	}
	return problems, checked
}

func requireClean(t *testing.T, source string, snippets []string, min int) {
	t.Helper()
	problems, n := checkInvocations(t, source, snippets)
	for _, p := range problems {
		t.Error(p)
	}
	if n < min {
		t.Fatalf("%s: only %d invocations checked — did the extractor break?", source, n)
	}
}

func TestAgentDocsOnlyUseRealCommandsAndFlags(t *testing.T) {
	// The checker itself must catch a mistyped command and a mistyped flag.
	fixture := []string{"finch conect notes", "finch add notes --servce x", "finch add notes --service x --json"}
	if problems, _ := checkInvocations(t, "fixture", fixture); len(problems) != 2 {
		t.Fatalf("checker verdicts on %q: %v, want exactly 2 problems", fixture, problems)
	}
	requireClean(t, "finch guide", indentedCommands(guideText), 10)
	requireClean(t, "finch help", indentedCommands(usageText), 5)
	public := filepath.Join("..", "..", "web", "public")
	if _, err := os.Stat(public); err != nil {
		t.Skip("web/public not present (agent built outside the monorepo)")
	}
	for _, name := range []string{"agents.md", "llms.txt"} {
		b, err := os.ReadFile(filepath.Join(public, name))
		if err != nil {
			t.Fatal(err)
		}
		requireClean(t, name, codeSnippets(string(b)), 8)
	}
}

// A finch from before the contract also answers `finch status --json` (with no
// schema_version), so the pre-check must tell an agent how to recognise it and
// what to do about a shadowing copy; otherwise it skips the install and every
// later command fails with a usage error from the old binary.
func TestAgentDocsDetectAnOldFinch(t *testing.T) {
	isolate(t)
	docs := map[string]string{"finch guide": guideText}
	if b, err := os.ReadFile(filepath.Join("..", "..", "web", "public", "agents.md")); err == nil {
		docs["agents.md"] = string(b)
	}
	for name, doc := range docs {
		start := strings.Index(doc, "finch status --json")
		end := strings.Index(doc, "finch login --start --json")
		if start < 0 || end < start {
			t.Fatalf("%s: no pre-check before the login step", name)
		}
		if !strings.Contains(doc[start:end], `no "schema_version":1`) && !strings.Contains(doc[start:end], `has no `+"`"+`"schema_version":1`+"`") {
			t.Fatalf("%s: the pre-check does not say how to recognise an old finch", name)
		}
		if !strings.Contains(doc[start:end], "shadows the new one") {
			t.Fatalf("%s: the pre-check or install step does not cover a shadowing finch on PATH", name)
		}
		// 1.7.0 is the first release with the whole contract (login --cancel,
		// the pending-login block, fail-closed service install).
		if !strings.Contains(doc[start:end], "1.7.0") {
			t.Fatalf("%s: the pre-check does not say to install finch 1.7.0 or later", name)
		}
	}
	stdout, stderr, code := finch(t, "status", "--json")
	if code != 0 || !strings.HasPrefix(stdout, `{"schema_version":1,`) {
		t.Fatalf("status --json must lead with schema_version for that check: exit=%d stdout=%q stderr=%q", code, stdout, stderr)
	}
}

// The agent flow's commands must appear, in order, in agents.md and the guide.
func TestAgentDocsFollowTheContractOrder(t *testing.T) {
	flow := []string{
		"finch status --json",
		"finch login --start --json",
		"finch login --poll --json",
		"finch add notes --service http://127.0.0.1:8000 --json",
		"finch service install --json",
		"finch test notes --json",
		"finch connect notes --client claude-code",
	}
	docs := map[string]string{"finch guide": guideText}
	if b, err := os.ReadFile(filepath.Join("..", "..", "web", "public", "agents.md")); err == nil {
		docs["agents.md"] = string(b)
	}
	for name, doc := range docs {
		at := 0
		for _, step := range flow {
			i := strings.Index(doc[at:], step)
			if i < 0 {
				t.Fatalf("%s: %q missing or out of order", name, step)
			}
			at += i + len(step)
		}
	}
}
