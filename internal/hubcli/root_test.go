package hubcli

import (
	"bytes"
	"context"
	"encoding/json"
	"testing"
)

func TestVersionDoesNotRequireOpenStackOrConfig(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if err := Execute(context.Background(), &stdout, &stderr, []string{"version", "--json"}); err != nil {
		t.Fatalf("Execute(version) error = %v", err)
	}
	var info map[string]string
	if err := json.Unmarshal(stdout.Bytes(), &info); err != nil {
		t.Fatalf("version JSON error = %v", err)
	}
	if info["version"] == "" || info["commit"] == "" || info["buildDate"] == "" {
		t.Fatalf("version info = %v", info)
	}
}

func TestInventoryRequiresConfigWithoutReadingOpenStackEnvironment(t *testing.T) {
	var stdout, stderr bytes.Buffer
	err := Execute(context.Background(), &stdout, &stderr, []string{"inventory"})
	if err == nil {
		t.Fatal("Execute(inventory) error = nil, want missing config rejection")
	}
	if stdout.Len() != 0 {
		t.Fatalf("inventory wrote unexpected output: %q", stdout.String())
	}
}
