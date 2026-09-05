package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestConfigCheckStrictWithoutOpeningProviderOrListener(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.toml")
	// Explicit nvml selection would fail starting a collector on CPU-only CI.
	if err := os.WriteFile(path, []byte("provider = \"nvml\"\nlisten = \"127.0.0.1:1397\"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	var out, stderr bytes.Buffer
	if err := Execute(context.Background(), &out, &stderr, []string{"--config", path, "config-check"}); err != nil {
		t.Fatal(err)
	}
	var value map[string]any
	if json.Unmarshal(out.Bytes(), &value) != nil || value["valid"] != true || value["stateProfile"] != "leviathan-state-v1" {
		t.Fatal("invalid preflight response", out.String())
	}
	if err := os.WriteFile(path, []byte("not_a_configuration_key = true\n"), 0600); err != nil {
		t.Fatal(err)
	}
	out.Reset()
	if Execute(context.Background(), &out, &stderr, []string{"--config", path, "config-check"}) == nil {
		t.Fatal("unknown configuration accepted")
	}
	if out.Len() != 0 {
		t.Fatal("invalid configuration returned success")
	}
}
