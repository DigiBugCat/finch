package core

// The end of a service's life and of finch's on this machine:
//
//	finch rm <name>          remove a service from the account AND this machine
//	finch logs <name>        the recent calls finch recorded for a service
//	finch uninstall          remove everything finch set up on this machine
//
// `finch connect` records what it wires into clients in ~/.finch/connections.json
// (the client, the service, the key id and where the entry lives, never the
// key), so uninstall can take those entries out again and revoke their keys.

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// ---- finch rm ------------------------------------------------------------

// runRm: finch rm <name> — remove a service from the account, its finch.yml
// entry and its saved credential, then restart a running background service
// so it stops serving the removed name.
func runRm(c *cli, args []string) error {
	fs := newFlagSet("rm")
	configPath := fs.String("config", defaultManifestPath(), "the `finch.yml` to remove the service from")
	fs.Bool("json", false, "JSON output")
	pos, err := c.parseArgs(fs, args)
	if err != nil {
		return err
	}
	if len(pos) != 1 {
		return usageError("usage: finch rm <name>")
	}
	name := pos[0]
	if err := validateServiceName(name); err != nil {
		return err
	}
	cred, err := requireCred()
	if err != nil {
		return err
	}
	inAccount := true
	if _, err := cliRequest("POST", cred.Hub, "/api/cli/services/release", cred.Token, map[string]string{"id": name}); err != nil {
		var he *hubError
		if !asHubError(err, &he) || he.Status != 404 {
			return hubFailure(err, "remove "+name, "finch fleet")
		}
		inAccount = false // gone from the account already; still clean up here
	}

	host, _ := os.Hostname()
	_, credDir := addPaths(*configPath, host) // before the entry goes
	removedEntry, err := removeIngress(*configPath, name)
	if err != nil {
		return newCLIError(codeInternal, "", "removed %s from your account, but could not update %s: %v", name, *configPath, err)
	}
	credPath := filepath.Join(credDir, name+".json")
	removedCred := false
	if err := os.Remove(credPath); err == nil {
		removedCred = true
	} else if !os.IsNotExist(err) {
		return newCLIError(codeInternal, "", "removed %s, but could not delete its credential %s: %v", name, credPath, err)
	}
	if !inAccount && !removedEntry && !removedCred {
		return newCLIError(codeNotFound, "finch fleet", "no service named %q in your account or on this machine", name)
	}

	restarted, remaining, idleService := false, -1, false
	if removedEntry {
		if cfg, err := loadConfig(*configPath, host); err == nil {
			remaining = len(cfg.Ingress)
		}
		svc := currentServiceStatus()
		// With nothing left to serve, 'finch run' exits at its next start and
		// launchd / systemd would restart it over and over: say to remove it.
		idleService = remaining == 0 && (svc.Installed || svc.Running)
		if remaining > 0 && svc.Running {
			if err := restartManagedService(); err != nil {
				return newCLIError(codeInternal, "finch service install", "removed %s, but restarting the background service failed: %v", name, err)
			}
			restarted = true
		}
	}
	if c.json {
		p := map[string]any{"removed": name, "account": inAccount, "config_entry": removedEntry, "restarted": restarted}
		if removedCred {
			p["credential"] = credPath
		}
		if idleService {
			p["next"] = "finch service uninstall"
		}
		return c.emit(p)
	}
	switch {
	case inAccount:
		c.printf("finch: removed %s from your account\n", name)
	default:
		c.printf("finch: %s was not in your account any more\n", name)
	}
	if removedEntry {
		c.printf("       removed it from %s\n", *configPath)
	}
	if removedCred {
		c.printf("       deleted its credential %s\n", credPath)
	}
	if restarted {
		c.printf("       restarted the background service\n")
	}
	if idleService {
		c.printf("       no services left on this machine; run 'finch service uninstall' to stop the background service\n")
	}
	return nil
}

// ---- finch logs ----------------------------------------------------------

// callRecord is one recorded call, as `finch logs --json` prints it.
type callRecord struct {
	Time   string `json:"time"` // RFC 3339
	Route  string `json:"route"`
	Caller string `json:"caller"`
	Status int    `json:"status"`
	MS     int    `json:"ms"`
}

const maxLogsLimit = 100

// runLogs: finch logs <name> [--limit N] [--json] — the recent calls the hub
// recorded for a service.
func runLogs(c *cli, args []string) error {
	fs := newFlagSet("logs")
	limit := fs.Int("limit", 20, "show at most `n` calls, newest first")
	fs.Bool("json", false, "JSON output")
	pos, err := c.parseArgs(fs, args)
	if err != nil {
		return err
	}
	if len(pos) != 1 {
		return usageError("usage: finch logs <name> [--limit N]")
	}
	if *limit < 1 || *limit > maxLogsLimit {
		return usageError("--limit must be between 1 and %d", maxLogsLimit)
	}
	name := pos[0]
	if err := validateServiceName(name); err != nil {
		return err
	}
	cred, err := requireCred()
	if err != nil {
		return err
	}
	calls, err := fetchCalls(cred, name, *limit)
	if err != nil {
		return err
	}
	if c.json {
		return c.emit(map[string]any{"service": name, "calls": calls})
	}
	if len(calls) == 0 {
		c.printf("no calls to %s yet\n", name)
		return nil
	}
	c.printf("%-19s  %-6s  %7s  %-20s  %s\n", "TIME", "STATUS", "TOOK", "CALLER", "ROUTE")
	for _, call := range calls {
		when := call.Time
		if t, err := time.Parse(time.RFC3339, call.Time); err == nil {
			when = t.Local().Format("2006-01-02 15:04:05")
		}
		c.printf("%-19s  %-6d  %5dms  %-20s  %s\n", when, call.Status, call.MS, call.Caller, call.Route)
	}
	return nil
}

// fetchCalls reads GET /api/cli/logs, falling back to the recentCalls in
// /api/cli/state for a hub that predates the logs route.
func fetchCalls(cred *cliCred, name string, limit int) ([]callRecord, error) {
	q := url.Values{"service": {name}, "limit": {fmt.Sprint(limit)}}
	out, err := cliRequest("GET", cred.Hub, "/api/cli/logs?"+q.Encode(), cred.Token, nil)
	if err != nil {
		var he *hubError
		if !asHubError(err, &he) || he.Status != 404 {
			return nil, hubFailure(err, "logs "+name, "finch fleet")
		}
		if !strings.Contains(he.Msg, "unknown CLI route") {
			return nil, newCLIError(codeNotFound, "finch fleet", "no service named %q in your account", name)
		}
		st, serr := cliRequest("GET", cred.Hub, "/api/cli/state", cred.Token, nil)
		if serr != nil {
			return nil, hubFailure(serr, "logs "+name, "finch fleet")
		}
		out = nil
		services, _ := st["services"].([]any)
		for _, s := range services {
			if m, ok := s.(map[string]any); ok && m["id"] == name {
				out = map[string]any{"calls": m["recentCalls"]}
			}
		}
		if out == nil {
			return nil, newCLIError(codeNotFound, "finch fleet", "no service named %q in your account", name)
		}
	}
	raw, _ := out["calls"].([]any)
	calls := []callRecord{}
	for _, r := range raw {
		m, ok := r.(map[string]any)
		if !ok {
			continue
		}
		rec := callRecord{}
		if ts, ok := m["ts"].(float64); ok {
			rec.Time = time.UnixMilli(int64(ts)).UTC().Format(time.RFC3339)
		}
		rec.Route, _ = m["route"].(string)
		rec.Caller, _ = m["caller"].(string)
		if s, ok := m["status"].(float64); ok {
			rec.Status = int(s)
		}
		if ms, ok := m["ms"].(float64); ok {
			rec.MS = int(ms)
		}
		calls = append(calls, rec)
		if len(calls) == limit {
			break
		}
	}
	return calls, nil
}

// ---- the connect ledger ----------------------------------------------------

// connection is one client entry `finch connect` wrote.
type connection struct {
	Client string `json:"client"`
	Name   string `json:"name"`
	URL    string `json:"url"`
	KeyID  string `json:"key_id,omitempty"`
	// Dir is the project directory of a Claude Code (local scope) entry.
	Dir string `json:"dir,omitempty"`
	// Config is the Cursor / Codex config file the entry is in.
	Config string `json:"config,omitempty"`
}

func connectionsPath() string { return filepath.Join(finchHome(), "connections.json") }

func readConnections() []connection {
	list, _ := readLedger()
	return list
}

// readLedger reads the connect ledger. ok is false when there is none to go
// on: the file is missing (a machine that never ran finch 1.8's connect) or
// unreadable.
func readLedger() (list []connection, ok bool) {
	b, err := readCredentialFile(connectionsPath(), credentialStateLimit)
	if err != nil || b == nil {
		return nil, false
	}
	var doc struct {
		Connections []connection `json:"connections"`
	}
	if json.Unmarshal(b, &doc) != nil {
		return nil, false
	}
	return doc.Connections, true
}

// recordConnection adds (or replaces) the ledger entry for one client entry.
// Best effort: a ledger that cannot be written only means uninstall has less
// to go on.
func recordConnection(conn connection) {
	list := readConnections()
	kept := list[:0]
	for _, e := range list {
		if e.Client == conn.Client && e.Name == conn.Name && e.Dir == conn.Dir && e.Config == conn.Config {
			continue
		}
		kept = append(kept, e)
	}
	kept = append(kept, conn)
	b, err := json.MarshalIndent(map[string]any{"connections": kept}, "", "  ")
	if err != nil || len(b) > credentialStateLimit {
		return
	}
	_ = writeCredentialFile(connectionsPath(), b)
}

// connectLabel is the label `finch connect` gives the keys it creates on this
// machine: "<client> on <hostname>".
func connectLabel(client string) string {
	if hostName, _ := os.Hostname(); hostName != "" {
		return client + " on " + hostName
	}
	return client
}

// runClaudeIn runs the claude CLI in dir (a project directory). Swapped by tests.
var runClaudeIn = func(dir, bin string, args ...string) (string, error) {
	cmd := exec.Command(bin, args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	return string(out), err
}

// ---- finch uninstall -------------------------------------------------------

// runUninstall: finch uninstall [--json] — undo everything finch set up on this
// machine, and say what was done. The binary itself stays (finch cannot know
// who else relies on it); the output says how to delete it.
func runUninstall(c *cli, args []string) error {
	fs := newFlagSet("uninstall")
	fs.Bool("json", false, "JSON output")
	pos, err := c.parseArgs(fs, args)
	if err != nil {
		return err
	}
	if len(pos) != 0 {
		return usageError("usage: finch uninstall")
	}
	done := []string{}
	warnings := []string{}
	result := map[string]any{}

	// 1. The background service, first: once the credentials are gone it would
	// only crash-loop. If it cannot be stopped, stop here and change nothing.
	if serviceGOOS == "darwin" || serviceGOOS == "linux" {
		if s := currentServiceStatus(); s.Installed || s.Running {
			unit, removed, cerr := stopAndRemoveService()
			if cerr != nil {
				cerr.Message = "uninstall stopped before changing anything: " + cerr.Message
				return cerr
			}
			if removed {
				done = append(done, "stopped the background service and removed "+unit)
			}
			result["service_removed"] = removed
		}
	}

	// 2. Client entries finch connect wrote, and the keys it created here.
	host, _ := os.Hostname()
	cred, _ := readCliCred()
	var st map[string]any
	if cred != nil && cred.Token != "" {
		st, err = cliRequest("GET", cred.Hub, "/api/cli/state", cred.Token, nil)
		if err != nil {
			warnings = append(warnings, fmt.Sprintf("could not reach finch to revoke this machine's keys (%v); revoke them later with 'finch keys list' and 'finch keys revoke <id>' from another machine", err))
			st = nil
		}
	} else {
		warnings = append(warnings, "not logged in, so the finch_ keys this machine created were not revoked; revoke them from another machine with 'finch keys list' and 'finch keys revoke <id>'")
	}
	ledger, haveLedger := readLedger()
	entries, entryWarnings := removeClientEntries(ledger, st)
	warnings = append(warnings, entryWarnings...)
	done = append(done, entries...)
	result["client_entries_removed"] = nonNil(entries)

	revoked, candidates := []string{}, []string{}
	if st != nil {
		ids, maybe := keysMintedHere(st, ledger, haveLedger)
		candidates = maybe
		if len(maybe) > 0 {
			warnings = append(warnings, fmt.Sprintf("this machine has no record of the keys it created with finch connect (it was set up before finch 1.8), so none were revoked. These keys carry this machine's name and may be its own: %s. Another machine with the same name labels its keys the same way, so check them with 'finch keys list' and revoke the ones that were this machine's with 'finch keys revoke <id>' from a logged-in machine", strings.Join(maybe, ", ")))
		}
		for _, id := range ids {
			if _, err := cliRequest("POST", cred.Hub, "/api/cli/keys/revoke", cred.Token, map[string]string{"id": id}); err != nil {
				var he *hubError
				if asHubError(err, &he) && he.Status == 404 {
					continue // already revoked
				}
				warnings = append(warnings, fmt.Sprintf("could not revoke key %s (%v); revoke it with 'finch keys revoke %s'", id, err, id))
				continue
			}
			revoked = append(revoked, id)
		}
		if len(revoked) > 0 {
			done = append(done, "revoked the finch_ keys this machine created with finch connect: "+strings.Join(revoked, ", "))
		}
	}
	result["revoked_key_ids"] = revoked
	result["candidate_key_ids"] = candidates

	// 3. Local credentials and config.
	deleted, fileWarnings := deleteLocalState(host)
	warnings = append(warnings, fileWarnings...)
	for _, p := range deleted {
		done = append(done, "deleted "+p)
	}
	result["deleted"] = nonNil(deleted)

	// 4. The binary: say how, never do it.
	exe, _ := os.Executable()
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	removeBinary := "rm " + shellQuote(exe)
	result["binary"] = exe
	result["remove_binary"] = removeBinary
	result["warnings"] = warnings
	if st != nil {
		if services, _ := st["services"].([]any); len(services) > 0 {
			result["services_kept"] = len(services)
		}
	}

	if c.json {
		return c.emit(result)
	}
	if len(done) == 0 {
		c.printf("finch: nothing to remove — finch had nothing set up on this machine\n")
	}
	for _, d := range done {
		c.printf("finch: %s\n", d)
	}
	for _, w := range warnings {
		c.printf("finch: note: %s\n", w)
	}
	if n, _ := result["services_kept"].(int); n > 0 {
		c.printf("finch: your %d service(s) stay in your finch account; remove one from any logged-in machine with 'finch rm <name>'\n", n)
	}
	c.printf("finch: the finch binary is still at %s; to delete it, run:\n  %s\n", exe, removeBinary)
	return nil
}

// keysMintedHere is the keys `finch connect` created on this machine: exactly
// the key ids its ledger recorded that the account still has. A label is not
// proof ("<client> on <hostname>" repeats across machines with the same name,
// and anyone can mint a key with that label), so it never revokes anything.
// Only when there is no ledger (connects made before finch 1.8) are the keys
// with this machine's connect labels returned, as candidates for the person
// to check, each as "<id> (<label>)".
func keysMintedHere(st map[string]any, ledger []connection, haveLedger bool) (ids, candidates []string) {
	labels := map[string]bool{}
	for _, cl := range connectClients {
		labels[connectLabel(cl)] = true
	}
	inLedger := map[string]bool{}
	for _, e := range ledger {
		if e.KeyID != "" {
			inLedger[e.KeyID] = true
		}
	}
	ids, candidates = []string{}, []string{}
	keys, _ := st["keys"].([]any)
	for _, k := range keys {
		m, _ := k.(map[string]any)
		id, _ := m["id"].(string)
		label, _ := m["label"].(string)
		switch {
		case id == "":
		case inLedger[id]:
			ids = append(ids, id)
		case !haveLedger && labels[label]:
			candidates = append(candidates, id+" ("+label+")")
		}
	}
	sort.Strings(ids)
	sort.Strings(candidates)
	return ids, candidates
}

// removeClientEntries takes out the client entries finch connect wrote. It
// returns what it removed and what it could not.
func removeClientEntries(ledger []connection, st map[string]any) (removed, warnings []string) {
	// Cursor: the ledger's entries, plus any mcpServers entry that carries a
	// finch_ key or points at this account's services.
	cursorNames := map[string]string{} // name -> recorded url ("" = match by content)
	for _, e := range ledger {
		if e.Client == "cursor" {
			cursorNames[e.Name] = e.URL
		}
	}
	serviceHost := ""
	if st != nil {
		if b, err := url.Parse(fmt.Sprint(st["serviceBase"])); err == nil {
			serviceHost = b.Host
		}
	}
	cursorFile := filepath.Join(cursorConfigDir(), "mcp.json")
	if b, err := os.ReadFile(cursorFile); err == nil {
		doc := map[string]any{}
		if json.Unmarshal(b, &doc) == nil {
			servers, _ := doc["mcpServers"].(map[string]any)
			var gone []string
			for name, v := range servers {
				entry, _ := v.(map[string]any)
				u, _ := entry["url"].(string)
				ours := false
				if want, ok := cursorNames[name]; ok && (want == "" || want == u) {
					ours = true
				}
				// Connected before the ledger existed: connect's own shape, a
				// /<name>/mcp URL on this account's address.
				if pu, err := url.Parse(u); err == nil && serviceHost != "" && pu.Host == serviceHost && pu.Path == "/"+name+"/mcp" {
					ours = true
				}
				if ours {
					delete(servers, name)
					gone = append(gone, name)
				}
			}
			if len(gone) > 0 {
				sort.Strings(gone)
				out, _ := json.MarshalIndent(doc, "", "  ")
				if err := atomicWriteFile(cursorFile, append(out, '\n'), 0o600); err != nil {
					warnings = append(warnings, fmt.Sprintf("could not update %s (%v); remove %s from it by hand", cursorFile, err, strings.Join(gone, ", ")))
				} else {
					removed = append(removed, fmt.Sprintf("removed %s from Cursor (%s)", strings.Join(gone, ", "), cursorFile))
				}
			}
		}
	}

	// Codex: every block finch connect marked as its own.
	codexFile := filepath.Join(codexConfigDir(), "config.toml")
	if b, err := os.ReadFile(codexFile); err == nil {
		text := string(b)
		var gone []string
		for _, line := range strings.Split(text, "\n") {
			const prefix = "# Managed by 'finch connect "
			if rest, ok := strings.CutPrefix(strings.TrimSpace(line), prefix); ok {
				if name, _, ok := strings.Cut(rest, " --client codex'."); ok && validateServiceID(name) == nil {
					gone = append(gone, name)
				}
			}
		}
		if len(gone) > 0 {
			for _, name := range gone {
				text = removeCodexServer(text, name)
			}
			if err := atomicWriteFile(codexFile, []byte(text), 0o600); err != nil {
				warnings = append(warnings, fmt.Sprintf("could not update %s (%v); remove [mcp_servers.%s] from it by hand", codexFile, err, strings.Join(gone, "], [mcp_servers.")))
			} else {
				removed = append(removed, fmt.Sprintf("removed %s from Codex (%s)", strings.Join(gone, ", "), codexFile))
			}
		}
	}

	// Claude Code: local-scope entries live per project. The ledger names the
	// project directories; the current directory is checked too, for entries
	// connected before the ledger existed.
	claudeBin, lookErr := exec.LookPath("claude")
	type target struct{ dir, name string }
	var targets []target
	seen := map[target]bool{}
	add := func(dir, name string) {
		t := target{dir, name}
		if !seen[t] {
			seen[t] = true
			targets = append(targets, t)
		}
	}
	for _, e := range ledger {
		if e.Client == "claude-code" && e.Dir != "" {
			add(e.Dir, e.Name)
		}
	}
	helpers, _ := filepath.Glob(filepath.Join(finchHome(), "connect", "*.claude-code.json"))
	cwd, _ := os.Getwd()
	for _, h := range helpers {
		add(cwd, strings.TrimSuffix(filepath.Base(h), ".claude-code.json"))
	}
	for _, t := range targets {
		if lookErr != nil {
			warnings = append(warnings, fmt.Sprintf("the 'claude' CLI is not on PATH, so the Claude Code entry %s in %s was left; remove it there with 'claude mcp remove %s'", t.name, t.dir, t.name))
			continue
		}
		out, err := runClaudeIn(t.dir, claudeBin, "mcp", "get", t.name)
		if err != nil || !claudeLocalScope.MatchString(out) || !strings.Contains(out, filepath.Join(finchHome(), "connect")) && !bearerFinchKey.MatchString(out) {
			continue // no finch entry for it in that project
		}
		if out, err := runClaudeIn(t.dir, claudeBin, "mcp", "remove", t.name, "-s", "local"); err != nil {
			warnings = append(warnings, fmt.Sprintf("could not remove the Claude Code entry %s in %s (%v: %s); remove it there with 'claude mcp remove %s'", t.name, t.dir, err, strings.TrimSpace(out), t.name))
			continue
		}
		removed = append(removed, fmt.Sprintf("removed %s from Claude Code (project %s)", t.name, t.dir))
	}
	return removed, warnings
}

// removeCodexServer drops [mcp_servers.<name>] (and its sub-tables) and
// finch's marker comment for it from Codex's config.toml.
func removeCodexServer(text, name string) string {
	header := codexServerHeader(name)
	marker := "# Managed by 'finch connect " + name + " --client codex'."
	var kept []string
	skipping := false
	for _, line := range strings.Split(text, "\n") {
		if tomlHeaderLine.MatchString(line) {
			skipping = header.MatchString(line)
		}
		if skipping || strings.TrimSpace(line) == marker {
			continue
		}
		kept = append(kept, line)
	}
	out := strings.TrimRight(strings.Join(kept, "\n"), "\n")
	if out != "" {
		out += "\n"
	}
	return out
}

// deleteLocalState removes finch's credentials and config: ~/.finch (logins,
// service credentials, the log, connect's key files), a finch.yml finch keeps
// in ~/.config/finch, and credentials a finch.yml keeps outside ~/.finch. A
// finch.yml in the current directory belongs to that project, so it stays.
func deleteLocalState(host string) (deleted, warnings []string) {
	home := finchHome()
	// Credentials a manifest keeps outside ~/.finch go first, while the
	// manifest can still be read.
	manifests := []string{filepath.Join(home, "finch.yml")}
	if h, err := os.UserHomeDir(); err == nil && h != "" {
		manifests = append(manifests, filepath.Join(h, ".config", "finch", "finch.yml"))
	}
	if p := findManifest(); p != "" {
		manifests = append(manifests, p)
	}
	for _, m := range manifests {
		cfg, err := loadConfig(m, host)
		if err != nil || isWithin(cfg.CredentialsDir, home) {
			continue
		}
		for _, ing := range cfg.Ingress {
			p := cfg.statePathFor(ing.AppPath)
			if !fileExists(p) {
				continue
			}
			// The manifest may be any project's finch.yml (the current
			// directory's is read too), so a file it names is deleted only if
			// it really is a finch credential.
			if !isFinchCredential(p) {
				warnings = append(warnings, fmt.Sprintf("%s names %s as the credential for %s, but it does not look like one (a private file with a hub and a refresh token), so it was left in place", m, p, ing.AppPath))
				continue
			}
			if err := os.Remove(p); err == nil {
				deleted = append(deleted, p)
			}
		}
	}
	if h, err := os.UserHomeDir(); err == nil && h != "" {
		p := filepath.Join(h, ".config", "finch", "finch.yml")
		if err := os.Remove(p); err == nil {
			deleted = append(deleted, p)
			_ = os.Remove(filepath.Dir(p)) // only if now empty
		}
	}
	if st, err := os.Lstat(home); err == nil {
		var rerr error
		if st.IsDir() {
			rerr = os.RemoveAll(home)
		} else {
			rerr = os.Remove(home) // a symlink or stray file: never follow it
		}
		if rerr != nil {
			warnings = append(warnings, fmt.Sprintf("could not delete %s (%v)", home, rerr))
		} else {
			deleted = append(deleted, home)
		}
	}
	if fileExists("finch.yml") {
		if abs, err := filepath.Abs("finch.yml"); err == nil {
			warnings = append(warnings, abs+" belongs to this project and was left in place; delete it if you no longer need it")
		}
	}
	return deleted, warnings
}

// isFinchCredential reports whether path is a regular file holding a saved
// finch machine credential (a hub and a refresh token), as `finch add` and
// `finch enroll` write it.
func isFinchCredential(path string) bool {
	b, err := readCredentialFile(path, credentialStateLimit)
	if err != nil || b == nil {
		return false
	}
	var st agentState
	return json.Unmarshal(b, &st) == nil && st.Hub != "" && st.RefreshToken != ""
}

// nonNil turns a nil list into an empty one, so a JSON list field is always
// an array, never null.
func nonNil(list []string) []string {
	if list == nil {
		return []string{}
	}
	return list
}

// isWithin reports whether path is dir or inside it.
func isWithin(path, dir string) bool {
	rel, err := filepath.Rel(dir, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}
