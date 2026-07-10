package core

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func testCLIVersionInfo() cliVersionInfo {
	return cliVersionInfo{
		SchemaVersion: 1,
		Product:       "finch",
		Version:       "9.8.7-test",
		OS:            "testos",
		Arch:          "testarch",
	}
}

func TestWriteCLIVersion_JSONContract(t *testing.T) {
	var out bytes.Buffer
	if err := writeCLIVersion(&out, []string{"--json"}, testCLIVersionInfo()); err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(out.String()) != `{"schema_version":1,"product":"finch","version":"9.8.7-test","os":"testos","arch":"testarch"}` {
		t.Fatalf("unexpected JSON: %s", out.String())
	}
	var decoded map[string]any
	if err := json.Unmarshal(out.Bytes(), &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["schema_version"] != float64(cliVersionSchema) || decoded["product"] != "finch" {
		t.Fatalf("unstable identity fields: %#v", decoded)
	}
}

func TestWriteCLIVersion_PlainOutput(t *testing.T) {
	var out bytes.Buffer
	if err := writeCLIVersion(&out, nil, testCLIVersionInfo()); err != nil {
		t.Fatal(err)
	}
	if got, want := out.String(), "finch 9.8.7-test (testos/testarch)\n"; got != want {
		t.Fatalf("plain output=%q, want %q", got, want)
	}
}

func TestWriteCLIVersion_RejectsUnknownInput(t *testing.T) {
	for _, args := range [][]string{{"--unknown"}, {"extra"}} {
		if err := writeCLIVersion(&bytes.Buffer{}, args, testCLIVersionInfo()); err == nil {
			t.Fatalf("invalid args %#v were accepted", args)
		}
	}
}

func TestCurrentCLIVersionInfoUsesStampedVersion(t *testing.T) {
	info := currentCLIVersionInfo()
	if info.SchemaVersion != cliVersionSchema || info.Product != "finch" || info.Version != agentVersion || info.OS == "" || info.Arch == "" {
		t.Fatalf("current version info=%+v", info)
	}
}
