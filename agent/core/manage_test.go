package core

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAddPreflightsManifestBeforeEnrollmentSideEffects(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	p := filepath.Join(t.TempDir(), "finch.yml")
	original := []byte("ingress: {not: a-sequence}\n")
	if err := os.WriteFile(p, original, 0o600); err != nil {
		t.Fatal(err)
	}
	_, _, err := Add(p, "media", "https://service.example")
	if err == nil || !strings.Contains(err.Error(), "ingress must be a sequence") {
		t.Fatalf("Add did not preflight malformed manifest: %v", err)
	}
	if got, _ := os.ReadFile(p); string(got) != string(original) {
		t.Fatalf("Add changed malformed manifest: %q", got)
	}
}
