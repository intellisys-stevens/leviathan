package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPluginConfigCheckIsOfflineAndNonmutating(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "plugins.toml")
	if err := os.WriteFile(path, []byte("[[plugins]]\nid='example'\nsocket='/does/not/exist.sock'\ncapabilities=['gpu']\ninterval='1s'\n"), 0600); err != nil {
		t.Fatal(err)
	}
	var stdout, stderr bytes.Buffer
	if err := Execute(context.Background(), &stdout, &stderr, []string{"--config", path, "config-check"}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(stdout.String(), `"valid":true`) || stderr.Len() != 0 {
		t.Fatalf("stdout=%s stderr=%s", &stdout, &stderr)
	}
	entries, err := os.ReadDir(directory)
	if err != nil || len(entries) != 1 {
		t.Fatalf("config check wrote state: %v %v", entries, err)
	}
	stdout.Reset()
	if err := Execute(context.Background(), &stdout, &stderr, []string{"--config", path, "plugins", "list", "-f", "json"}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(stdout.String(), `"id":"example"`) {
		t.Fatalf("list=%s", &stdout)
	}
	stdout.Reset()
	err = Execute(context.Background(), &stdout, &stderr, []string{"--config", path, "--error-format=json", "plugins", "check", "-f", "json"})
	if err == nil {
		t.Fatal("endpoint check accepted missing socket")
	}
	WriteError(&stderr, err)
	var payload struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal(stderr.Bytes(), &payload) != nil || payload.Error.Code != "plugin_check_failed" || payload.Error.Message == "" {
		t.Fatalf("stderr=%s", &stderr)
	}
	if !json.Valid(stdout.Bytes()) {
		t.Fatalf("error damaged stdout payload: %s", &stdout)
	}
}

func TestStructuredConfigErrorPreservesEmptyStdout(t *testing.T) {
	var stdout, stderr bytes.Buffer
	err := Execute(context.Background(), &stdout, &stderr, []string{"--error-format=json", "--interval=1ms", "config-check"})
	if err == nil {
		t.Fatal("invalid interval accepted")
	}
	WriteError(&stderr, err)
	if stdout.Len() != 0 || !strings.Contains(stderr.String(), `"code":"invalid_config"`) {
		t.Fatalf("stdout=%s stderr=%s", &stdout, &stderr)
	}
}
