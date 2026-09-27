package core

// finch.yml mutation for `finch add`: comment-preserving yaml.Node edits and an
// atomic 0600 write, plus the credential-dir/box defaults add and enroll share.

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"gopkg.in/yaml.v3"
)

// defaultCredentialsDir mirrors loadConfig's default: ~/.finch (cwd-relative
// .finch if there's no home dir), so `finch add`/`finch enroll` write the
// credential where `finch run` will look for it.
func defaultCredentialsDir() string {
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		return filepath.Join(home, ".finch")
	}
	return ".finch"
}

// addPaths resolves the box name + credentials dir `finch add` should use,
// honoring an existing finch.yml at configPath (best-effort): the credential must
// land in the manifest's credentials-dir so `finch run` finds it, and the box
// should register under the manifest's box name. Falls back to the hostname +
// the default ~/.finch when the manifest is absent. loadConfig already expands ~
// and applies the credentials-dir default, so its values are used as-is.
func addPaths(configPath, host string) (box, credDir string) {
	box, credDir = host, defaultCredentialsDir()
	if c, err := loadConfig(configPath, host); err == nil {
		if c.Box != "" {
			box = c.Box
		}
		if c.CredentialsDir != "" {
			credDir = c.CredentialsDir
		}
	}
	return box, credDir
}

var manifestMutationMu sync.Mutex

func validateManifestMutationTarget(configPath string) error {
	b, err := os.ReadFile(configPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	var doc yaml.Node
	if err := yaml.Unmarshal(b, &doc); err != nil {
		return fmt.Errorf("parsing %s: %w", configPath, err)
	}
	if doc.Kind == 0 || (doc.Kind == yaml.DocumentNode && len(doc.Content) == 0) {
		return nil
	}
	if doc.Kind != yaml.DocumentNode || len(doc.Content) == 0 || doc.Content[0].Kind != yaml.MappingNode {
		return fmt.Errorf("%s: top-level YAML is not a mapping", configPath)
	}
	if seq := yamlMapValue(doc.Content[0], "ingress"); seq != nil && seq.Kind != yaml.SequenceNode {
		return fmt.Errorf("%s: ingress must be a sequence", configPath)
	}
	return nil
}

// appendIngress adds (or updates) one ingress rule in finch.yml WITHOUT clobbering
// user comments or keys finch doesn't model: it edits an existing file through a
// yaml.Node (yaml.v3 preserves comments + unknown content across a Node round-trip)
// rather than unmarshaling into the fixed `config` struct and re-marshaling. An
// existing rule with the same app_path is updated in place; hub/box are filled
// only when absent. A missing file is created from the managed header + a minimal
// struct marshal. No ticket is written — the credential is saved separately by enrollToState.
func appendIngress(configPath, hub, appPath, service, box string) error {
	manifestMutationMu.Lock()
	defer manifestMutationMu.Unlock()
	return appendIngressLocked(configPath, hub, appPath, service, box)
}

func appendIngressLocked(configPath, hub, appPath, service, box string) error {
	if err := validateManifestMutationTarget(configPath); err != nil {
		return err
	}
	b, err := os.ReadFile(configPath)
	if err != nil {
		if !os.IsNotExist(err) {
			return err
		}
		// New file: a minimal struct marshal under the managed header is fine.
		if box == "" {
			box, _ = os.Hostname()
		}
		c := config{Hub: hub, Box: box, Ingress: []ingress{{AppPath: appPath, Service: service}}}
		out, merr := yaml.Marshal(&c)
		if merr != nil {
			return merr
		}
		return atomicManifestWrite(configPath, append([]byte("# finch.yml — managed by `finch add`\n"), out...))
	}

	// Existing file: edit through a yaml.Node so comments + unmodeled keys survive.
	var doc yaml.Node
	if uerr := yaml.Unmarshal(b, &doc); uerr != nil {
		return fmt.Errorf("parsing %s: %w", configPath, uerr)
	}
	var root *yaml.Node
	if doc.Kind == yaml.DocumentNode && len(doc.Content) > 0 {
		root = doc.Content[0]
	} else { // empty/whitespace file — start a fresh mapping document
		root = &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
		doc = yaml.Node{Kind: yaml.DocumentNode, Content: []*yaml.Node{root}}
	}
	if root.Kind != yaml.MappingNode {
		return fmt.Errorf("%s: top-level YAML is not a mapping", configPath)
	}

	// Fill hub/box only when absent (don't overwrite a user's values).
	if yamlMapValue(root, "hub") == nil && hub != "" {
		yamlMapSet(root, "hub", yamlScalar(hub))
	}
	if yamlMapValue(root, "box") == nil {
		if box == "" {
			box, _ = os.Hostname()
		}
		if box != "" {
			yamlMapSet(root, "box", yamlScalar(box))
		}
	}

	// Locate (or create) the ingress sequence.
	seq := yamlMapValue(root, "ingress")
	if seq == nil {
		seq = &yaml.Node{Kind: yaml.SequenceNode, Tag: "!!seq"}
		yamlMapSet(root, "ingress", seq)
	}
	// Update an existing rule with the same app_path in place; else append one.
	for _, item := range seq.Content {
		if item.Kind != yaml.MappingNode {
			continue
		}
		if ap := yamlMapValue(item, "app_path"); ap != nil && ap.Value == appPath {
			yamlMapSet(item, "service", yamlScalar(service))
			return yamlWriteFile(configPath, &doc)
		}
	}
	seq.Content = append(seq.Content, &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map", Content: []*yaml.Node{
		yamlScalar("app_path"), yamlScalar(appPath),
		yamlScalar("service"), yamlScalar(service),
	}})
	return yamlWriteFile(configPath, &doc)
}

// --- minimal yaml.Node helpers (comment-preserving finch.yml edits) ---

// yamlScalar builds a plain string scalar node.
func yamlScalar(v string) *yaml.Node {
	return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: v}
}

// yamlMapValue returns the value node for key in a mapping node, or nil.
func yamlMapValue(m *yaml.Node, key string) *yaml.Node {
	if m == nil || m.Kind != yaml.MappingNode {
		return nil
	}
	for i := 0; i+1 < len(m.Content); i += 2 {
		if m.Content[i].Value == key {
			return m.Content[i+1]
		}
	}
	return nil
}

// yamlMapSet sets key to val in a mapping node, replacing the value if the key
// already exists (preserving the key node + its comments) or appending otherwise.
func yamlMapSet(m *yaml.Node, key string, val *yaml.Node) {
	for i := 0; i+1 < len(m.Content); i += 2 {
		if m.Content[i].Value == key {
			m.Content[i+1] = val
			return
		}
	}
	m.Content = append(m.Content, yamlScalar(key), val)
}

// yamlWriteFile marshals a yaml document node (0600). yaml.v3 preserves comments
// and unmodeled keys through the Node, so a hand-edited finch.yml survives edits.
func yamlWriteFile(configPath string, doc *yaml.Node) error {
	out, err := yaml.Marshal(doc)
	if err != nil {
		return err
	}
	return atomicManifestWrite(configPath, out)
}

func atomicManifestWrite(configPath string, out []byte) error {
	if dir := filepath.Dir(configPath); dir != "." {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return err
		}
	}
	dir := filepath.Dir(configPath)
	tmp, err := os.CreateTemp(dir, ".finch-yaml-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	cleanup := func() {
		_ = tmp.Close()
		_ = os.Remove(tmpPath)
	}
	if err := tmp.Chmod(0o600); err != nil {
		cleanup()
		return err
	}
	if _, err := tmp.Write(out); err != nil {
		cleanup()
		return err
	}
	if err := tmp.Sync(); err != nil {
		cleanup()
		return err
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpPath)
		return err
	}
	if err := os.Rename(tmpPath, configPath); err != nil {
		_ = os.Remove(tmpPath)
		return err
	}
	return nil
}
