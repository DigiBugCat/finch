package core

// `finch help`, `finch help <command>` and `finch <command> -h`. Every command
// is described once, in commandDocs: the top-level help, the per-command help
// and `finch help --json` are all rendered from it, so they cannot drift apart.
// A command's flags come from its own flag set (flag descriptions live next to
// the flag definitions), so a new flag shows up in its help automatically.

import (
	"flag"
	"fmt"
	"io"
	"sort"
	"strings"
)

// cmdDoc describes one command for the help screens.
type cmdDoc struct {
	name    string
	aliases []string
	// usage lists the synopsis lines, without the leading "finch ".
	usage   []string
	summary string
	// details is optional prose printed between the usage and the flags.
	details string
	example string
	// advanced commands are left out of the top-level help and listed by
	// `finch help advanced` instead.
	advanced bool
}

var commandDocs = []cmdDoc{
	{
		name:    "login",
		usage:   []string{"login [--headless]", "login --start | --poll | --cancel", "login --token -"},
		summary: "Sign in to finch (opens your browser and waits)",
		details: "Plain 'finch login' prints a link and a code, opens your browser, and waits\n" +
			"until you approve. The link works on any device, so on a machine without a\n" +
			"browser (over SSH, say) use --headless and open it on your phone.\n" +
			"AI agents use the two-step form instead: --start prints the link and\n" +
			"returns, --poll checks once (exit 0 approved, 10 pending, 11 expired).",
		example: "finch login",
	},
	{
		name:    "add",
		usage:   []string{"add <name> --service <url> [--public] [--forward-all]"},
		summary: "Publish a local service at a public https URL",
		details: "<name> becomes the path of the public URL: https://<your-address>/<name>/.\n" +
			"Your account address is <slug>.finchmcp.com, a name finch assigns to your\n" +
			"account; the command prints the full URL. A name uses letters, digits and\n" +
			"'-' (for example notes or team-wiki).\n" +
			"By default finch forwards only /<name>/mcp, for an MCP server. Add\n" +
			"--forward-all to forward every path, for a web app or a REST API.\n" +
			"Running add again for a service this machine already publishes updates\n" +
			"its local URL (and --public / --forward-all) instead of adding a new one.",
		example: "finch add notes --service http://127.0.0.1:8000",
	},
	{
		name:    "run",
		usage:   []string{"run [--config finch.yml]"},
		summary: "Serve every service in finch.yml in the foreground",
		details: "'finch service install' runs this for you in the background; use run to\n" +
			"watch it in a terminal. Stop it with Ctrl-C.",
		example: "finch run",
	},
	{
		name:    "service",
		usage:   []string{"service install [--config finch.yml]", "service status", "service uninstall"},
		summary: "Keep 'finch run' running in the background (launchd / systemd --user)",
		details: "install starts the background service (and restarts it, so run it again after\n" +
			"every 'finch add'); status shows whether it runs; uninstall stops and removes it.",
		example: "finch service install",
	},
	{
		name:    "connect",
		usage:   []string{"connect <name> --client claude-code|cursor|codex|json"},
		summary: "Add a service to an MCP client, with its own finch_ key",
		details: "Creates a finch_ key for that client, scoped to this one service, and writes\n" +
			"it into the client's config without printing it. Running it again replaces\n" +
			"the entry and revokes the key it used. --client json prints an mcpServers\n" +
			"snippet instead (the only form that shows the key).",
		example: "finch connect notes --client claude-code",
	},
	{
		name:    "test",
		usage:   []string{"test <name>"},
		summary: "Check that a service answers: lists its MCP tools through finch",
		example: "finch test notes",
	},
	{
		name:    "call",
		usage:   []string{"call <name> <tool> [--args '{\"key\":\"value\"}']"},
		summary: "Call one MCP tool through finch",
		example: "finch call notes search --args '{\"query\":\"finch\"}'",
	},
	{
		name:    "status",
		usage:   []string{"status"},
		summary: "Your login, this machine's services and the background service at a glance",
		example: "finch status",
	},
	{
		name:    "fleet",
		aliases: []string{"ls"},
		usage:   []string{"fleet"},
		summary: "Every service in your account, its state and its public URL",
		example: "finch fleet",
	},
	{
		name:    "logs",
		usage:   []string{"logs <name> [--limit N]"},
		summary: "Recent calls to a service: time, path, caller, status, duration",
		details: "finch keeps the most recent calls per service (no request or response bodies).",
		example: "finch logs notes --limit 10",
	},
	{
		name:    "keys",
		usage:   []string{"keys [list]", "keys mint <label> --service <name> | --all", "keys revoke <id>"},
		summary: "List, create and revoke finch_ keys for MCP clients",
		details: "'finch connect' creates and stores keys for you; use mint for a client it\n" +
			"cannot configure. A new key is printed once.",
		example: "finch keys mint my-agent --service notes",
	},
	{
		name:    "auth",
		usage:   []string{"auth <name> public|key"},
		summary: "Open a service to anyone, or require a finch_ key again",
		example: "finch auth notes key",
	},
	{
		name:    "rm",
		usage:   []string{"rm <name> [--local-only]"},
		summary: "Remove a service from your account and from this machine",
		details: "Removes the service from your account, its entry in finch.yml and its saved\n" +
			"credential, then restarts the background service if it is running. If this\n" +
			"machine's service belongs to another account than the one you are logged in\n" +
			"to, rm changes nothing: log in to that account, or use --local-only to remove\n" +
			"it from this machine only and leave it in its account.",
		example: "finch rm notes",
	},
	{
		name:    "domain",
		usage:   []string{"domain [ls]", "domain add <hostname>", "domain rm <hostname>"},
		summary: "Serve your services on your own hostname",
		example: "finch domain add mcp.example.com",
	},
	{
		name:    "update",
		usage:   []string{"update [--force]"},
		summary: "Update finch to the latest version and restart the background service",
		example: "finch update",
	},
	{
		name:    "uninstall",
		usage:   []string{"uninstall"},
		summary: "Remove finch's background service, logins, keys and client entries from this machine",
		details: "Stops and removes the background service, revokes the finch_ keys this\n" +
			"machine created with 'finch connect' (a machine set up before finch 1.8\n" +
			"has no record of them, so it lists the likely ones for you to check),\n" +
			"removes the client entries connect added, and deletes finch's local\n" +
			"credentials and config (~/.finch). Your services stay in your account\n" +
			"(remove them first with 'finch rm <name>' if you want them gone). It never\n" +
			"deletes the finch binary; it prints how to.",
		example: "finch uninstall",
	},
	{
		name:    "version",
		usage:   []string{"version"},
		summary: "Show the version and platform",
		example: "finch version --json",
	},
	{
		name:    "guide",
		usage:   []string{"guide"},
		summary: "The step-by-step manual for AI agents (https://finchmcp.com/agents.md)",
		example: "finch guide",
	},
	{
		name:    "help",
		usage:   []string{"help [<command> | advanced]"},
		summary: "Show help for finch or one command",
		example: "finch help add",
	},

	// Advanced: kept working, left out of the everyday help.
	{
		name:     "approve",
		usage:    []string{"approve <name> [<name>...]"},
		summary:  "Approve a service whose machine is waiting for approval",
		details:  "'finch run' approves the services it serves for you when you are logged in,\nso you rarely need this.",
		example:  "finch approve notes",
		advanced: true,
	},
	{
		name:     "token",
		usage:    []string{"token [--login]"},
		summary:  "Create a login for another machine (pipe it; never put it on the command line)",
		example:  "finch token | ssh othermachine 'finch login --token -'",
		advanced: true,
	},
	{
		name:     "enroll",
		usage:    []string{"enroll <name> --ticket -"},
		summary:  "Save a machine credential from a one-time enrollment ticket",
		details:  "Enrollment tickets come from older setups; 'finch add' replaces this.",
		example:  "finch enroll notes --ticket - < ticket.txt",
		advanced: true,
	},
	{
		name:     "revoke-tokens",
		usage:    []string{"revoke-tokens"},
		summary:  "Sign out every machine: revoke all finch logins, this one included",
		example:  "finch revoke-tokens",
		advanced: true,
	},
	{
		name:     "join",
		usage:    []string{"join --upstream <url>"},
		summary:  "Serve one service from ~/.finch/agent.json (machines set up with the original one-liner)",
		example:  "finch join --upstream http://127.0.0.1:8000",
		advanced: true,
	},
}

// findDoc returns the doc for a command name or alias, or nil.
func findDoc(name string) *cmdDoc {
	for i := range commandDocs {
		d := &commandDocs[i]
		if d.name == name {
			return d
		}
		for _, a := range d.aliases {
			if a == name {
				return d
			}
		}
	}
	return nil
}

// usageText is `finch help` (and bare `finch`).
var usageText = renderUsage()

func renderUsage() string {
	var b strings.Builder
	b.WriteString(`finch publishes a local MCP server (or any local HTTP app) at a stable https
URL. This machine dials out to finch, so nothing listens and no ports open.

Get started:
  finch login                                        sign in (opens your browser)
  finch add notes --service http://127.0.0.1:8000    publish it; prints its public URL
  finch service install                              keep it running in the background
  finch test notes                                   check that it answers
  finch connect notes --client claude-code           add it to Claude Code (or cursor, codex)

AI agents: run 'finch guide' (the same manual as https://finchmcp.com/agents.md).
Every command takes --json.

Commands:
`)
	for _, d := range commandDocs {
		if d.advanced {
			continue
		}
		b.WriteString(fmt.Sprintf("  %-12s %s\n", d.name, d.summary))
	}
	b.WriteString(`
More: approve, token, enroll, revoke-tokens and join ('finch help advanced').
Run 'finch help <command>' or 'finch <command> -h' for its flags and an example.

Exit codes: 0 ok, 1 error, 2 usage, 10 waiting for approval, 11 expired,
12 not logged in. With --json, success payloads carry "schema_version":1 and
errors go to stderr as {"schema_version":1,"error":{"code","message","next"}}.
`)
	return b.String()
}

// advancedText is `finch help advanced`.
func advancedText() string {
	var b strings.Builder
	b.WriteString("Commands most people never need:\n\n")
	for _, d := range commandDocs {
		if !d.advanced {
			continue
		}
		b.WriteString(fmt.Sprintf("  %-14s %s\n", d.name, d.summary))
	}
	b.WriteString("\nRun 'finch help <command>' for its flags and an example.\n")
	return b.String()
}

// helpFlag is one flag in a command's help.
type helpFlag struct {
	Name        string `json:"name"`
	Arg         string `json:"arg,omitempty"`
	Description string `json:"description"`
}

// hiddenFlags are accepted for compatibility but left out of help.
var hiddenFlags = map[string]map[string]bool{
	"run": {"hub": true, "ticket": true, "box": true, "upstream": true, "state": true, "forward-all": true},
}

func flagsOf(cmd string, fs *flag.FlagSet) []helpFlag {
	var out []helpFlag
	if fs == nil {
		return out
	}
	fs.VisitAll(func(f *flag.Flag) {
		if hiddenFlags[cmd][f.Name] {
			return
		}
		arg, desc := flag.UnquoteUsage(f)
		if bf, ok := f.Value.(interface{ IsBoolFlag() bool }); ok && bf.IsBoolFlag() {
			arg = ""
		} else if arg == "string" || arg == "value" || arg == "int" {
			arg = "<" + map[string]string{"string": "value", "value": "value", "int": "n"}[arg] + ">"
		} else if arg != "" {
			arg = "<" + arg + ">"
		}
		out = append(out, helpFlag{Name: f.Name, Arg: arg, Description: desc})
	})
	sort.SliceStable(out, func(i, j int) bool {
		// --json last: it is on every command.
		return out[j].Name == "json" && out[i].Name != "json"
	})
	return out
}

// commandHelpText renders one command's help.
func commandHelpText(d *cmdDoc, flags []helpFlag) string {
	var b strings.Builder
	fmt.Fprintf(&b, "finch %s — %s\n\nUsage:\n", d.name, d.summary)
	for _, u := range d.usage {
		fmt.Fprintf(&b, "  finch %s\n", u)
	}
	if len(d.aliases) > 0 {
		fmt.Fprintf(&b, "  (also: finch %s)\n", strings.Join(d.aliases, ", finch "))
	}
	if d.details != "" {
		b.WriteString("\n" + d.details + "\n")
	}
	if len(flags) > 0 {
		b.WriteString("\nFlags:\n")
		width := 0
		cols := make([]string, len(flags))
		for i, f := range flags {
			cols[i] = "--" + f.Name
			if f.Arg != "" {
				cols[i] += " " + f.Arg
			}
			if len(cols[i]) > width {
				width = len(cols[i])
			}
		}
		for i, f := range flags {
			fmt.Fprintf(&b, "  %-*s  %s\n", width, cols[i], f.Description)
		}
	}
	if d.example != "" {
		fmt.Fprintf(&b, "\nExample:\n  %s\n", d.example)
	}
	return b.String()
}

// showCommandHelp prints a command's help (text, or JSON with --json) and
// returns errHelpShown so the command exits 0.
func (c *cli) showCommandHelp(name string, fs *flag.FlagSet) error {
	d := findDoc(name)
	if d == nil {
		d = &cmdDoc{name: name, usage: []string{name}}
	}
	flags := flagsOf(d.name, fs)
	text := commandHelpText(d, flags)
	if c.json {
		if flags == nil {
			flags = []helpFlag{}
		}
		payload := map[string]any{
			"command": d.name, "usage": prefixAll("finch ", d.usage), "summary": d.summary,
			"flags": flags, "example": d.example, "text": text,
		}
		if len(d.aliases) > 0 {
			payload["aliases"] = d.aliases
		}
		if err := c.emit(payload); err != nil {
			return err
		}
		return errHelpShown
	}
	if _, err := io.WriteString(c.stdout, text); err != nil {
		return err
	}
	return errHelpShown
}

func prefixAll(prefix string, in []string) []string {
	out := make([]string, len(in))
	for i, s := range in {
		out[i] = prefix + s
	}
	return out
}

// runHelp: finch help [<command> | advanced] [--json].
func runHelp(c *cli, args []string) error {
	var pos []string
	for _, a := range args {
		switch a {
		case "--json", "-json", "--json=true", "-json=true", "--json=1", "-json=1":
		case "-h", "--help", "-help":
		default:
			pos = append(pos, a)
		}
	}
	switch {
	case len(pos) == 0:
		if c.json {
			return c.emit(map[string]any{"text": usageText, "commands": helpCommands()})
		}
		_, err := io.WriteString(c.stdout, usageText)
		return err
	case len(pos) > 1:
		return usageError("usage: finch help [<command> | advanced]")
	case pos[0] == "advanced":
		if c.json {
			return c.emit(map[string]any{"text": advancedText(), "commands": helpCommandsWhere(true)})
		}
		_, err := io.WriteString(c.stdout, advancedText())
		return err
	}
	return commandHelp(c, pos[0])
}

// commandHelp prints `finch help <name>`: the command's own -h.
func commandHelp(c *cli, name string) error {
	d := findDoc(name)
	if d == nil {
		return newCLIError(codeUsage, "finch help", "unknown command %q", name)
	}
	switch d.name {
	case "run", "join":
		return c.showCommandHelp(d.name, relayFlagSet(d.name))
	case "version":
		return c.showCommandHelp("version", versionFlagSet())
	case "guide", "help":
		fs := newFlagSet(d.name)
		fs.Bool("json", false, "JSON output")
		return c.showCommandHelp(d.name, fs)
	}
	h := lookupCommand(d.name)
	if h == nil {
		return newCLIError(codeUsage, "finch help", "unknown command %q", name)
	}
	return h(c, []string{"-h"})
}

// helpCommands is the command table for `finch help --json`: every command,
// the advanced ones marked "advanced":true. As in 1.7, "usage" leaves out the
// leading "finch " (callers prefix it themselves).
func helpCommands() []map[string]any {
	rows := helpCommandsWhere(false)
	return append(rows, helpCommandsWhere(true)...)
}

func helpCommandsWhere(advanced bool) []map[string]any {
	rows := []map[string]any{}
	for _, d := range commandDocs {
		if d.advanced != advanced {
			continue
		}
		row := map[string]any{"name": d.name, "usage": d.usage[0], "summary": d.summary}
		if len(d.aliases) > 0 {
			row["aliases"] = d.aliases
		}
		if advanced {
			row["advanced"] = true
		}
		rows = append(rows, row)
	}
	return rows
}

// isHelpArg reports whether args asks for help (-h / --help / -help).
func isHelpArg(args []string) bool {
	for _, a := range args {
		if a == "--" {
			return false
		}
		if a == "-h" || a == "--help" || a == "-help" {
			return true
		}
	}
	return false
}
