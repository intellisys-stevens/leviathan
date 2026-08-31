package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/intellisys-stevens/miglens/internal/model"
)

func TestConfigPrecedenceAndRedactedJSON(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "config.toml")
	if err := os.WriteFile(configPath, []byte("interval = \"300ms\"\nprovider = \"nvml\"\nshow_command_line = true\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("MIGLENS_PROVIDER", "invalid")
	t.Setenv("MIGLENS_INTERVAL", "400ms")
	t.Setenv("MIGLENS_SHOW_COMMAND_LINE", "true")
	var stdout, stderr bytes.Buffer
	err := Execute(context.Background(), &stdout, &stderr, []string{
		"--config", configPath, "--provider", "fake", "--fixture", "multi-ci", "--interval", "250ms", "--show-command-line=false", "--no-profile", "snapshot", "--format", "json",
	})
	if err != nil {
		t.Fatal(err)
	}
	var snapshot model.Snapshot
	if err := json.Unmarshal(stdout.Bytes(), &snapshot); err != nil {
		t.Fatal(err)
	}
	if len(snapshot.GPUs) != 1 || len(snapshot.GPUs[0].GPUInstances[0].ComputeInstances) != 2 {
		t.Fatalf("CLI flags did not override config/env: %+v", snapshot.GPUs)
	}
	// The fixture contains no command arguments; empty fields must stay absent on the wire.
	if strings.Contains(stdout.String(), "commandLine") || strings.Contains(stdout.String(), "SECRET=") {
		t.Fatalf("redacted output leaked fields: %s", stdout.String())
	}
}

func TestWatchJSONL(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 620*time.Millisecond)
	defer cancel()
	var stdout, stderr bytes.Buffer
	if err := Execute(ctx, &stdout, &stderr, []string{"--provider", "fake", "--interval", "250ms", "--no-profile", "watch", "--format", "jsonl"}); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(stdout.String()), "\n")
	if len(lines) < 2 {
		t.Fatalf("JSONL snapshots = %d, output %q", len(lines), stdout.String())
	}
	for _, line := range lines {
		var snapshot model.Snapshot
		if err := json.Unmarshal([]byte(line), &snapshot); err != nil || snapshot.SchemaVersion != "v1" {
			t.Fatalf("invalid JSONL line: %v %q", err, line)
		}
	}
}

func TestServeRejectsNonLoopbackBeforeBinding(t *testing.T) {
	err := Execute(context.Background(), &bytes.Buffer{}, &bytes.Buffer{}, []string{"--provider", "fake", "--listen", "0.0.0.0:1397", "serve"})
	if err == nil || !strings.Contains(err.Error(), "only listens on loopback") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestUplinkRejectsUnsafeInputsBeforeStartingCollector(t *testing.T) {
	t.Setenv("MIGLENS_TEST_UPLINK_TOKEN", strings.Repeat("t", 48))
	tests := []struct {
		name string
		args []string
		want string
	}{
		{name: "interval", args: []string{"uplink", "--hub-url", "https://hub.example.test", "--uplink-interval", "1s"}, want: "between 5s and 5m"},
		{name: "token environment", args: []string{"uplink", "--hub-url", "https://hub.example.test", "--token-env", "bad-name"}, want: "environment variable name"},
		{name: "instance UUID", args: []string{"uplink", "--hub-url", "https://hub.example.test", "--instance-uuid", "not-a-uuid", "--token-env", "MIGLENS_TEST_UPLINK_TOKEN"}, want: "canonical lowercase UUID"},
		{name: "HTTP Hub", args: []string{"uplink", "--hub-url", "http://hub.example.test", "--instance-uuid", "11111111-1111-4111-8111-111111111111", "--token-env", "MIGLENS_TEST_UPLINK_TOKEN"}, want: "base URL is invalid"},
		{name: "missing token", args: []string{"uplink", "--hub-url", "https://hub.example.test", "--instance-uuid", "11111111-1111-4111-8111-111111111111", "--token-env", "MIGLENS_MISSING_UPLINK_TOKEN"}, want: "MIGLENS_MISSING_UPLINK_TOKEN is not set"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := Execute(context.Background(), &bytes.Buffer{}, &bytes.Buffer{}, test.args)
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("Execute() error = %v, want %q", err, test.want)
			}
			if strings.Contains(err.Error(), strings.Repeat("t", 16)) {
				t.Fatal("uplink error leaked bearer token")
			}
		})
	}
}

func TestTunnelHintUsesBoundPort(t *testing.T) {
	hint := tunnelHint(&net.TCPAddr{IP: net.ParseIP("127.0.0.1"), Port: 41397})
	if hint != "Remote access: ssh -L 41397:127.0.0.1:41397 <host>" {
		t.Fatalf("unexpected tunnel hint: %q", hint)
	}
}

func TestServeShutsDownWithActiveSSEClient(t *testing.T) {
	probe, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := probe.Addr().String()
	if err := probe.Close(); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- Execute(ctx, io.Discard, io.Discard, []string{"--provider", "fake", "--listen", address, "serve"})
	}()

	client := &http.Client{Timeout: time.Second}
	var response *http.Response
	for deadline := time.Now().Add(time.Second); time.Now().Before(deadline); {
		response, err = client.Get("http://" + address + "/api/v1/events")
		if err == nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err != nil {
		cancel()
		t.Fatalf("connect to SSE endpoint: %v", err)
	}
	defer response.Body.Close()

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("serve returned after cancellation: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("serve did not shut down while an SSE client was connected")
	}
}

func TestVersionDoesNotRequireRuntimeConfiguration(t *testing.T) {
	t.Setenv("MIGLENS_INTERVAL", "not-a-duration")
	var stdout bytes.Buffer
	if err := Execute(context.Background(), &stdout, &bytes.Buffer{}, []string{"version", "--format", "json"}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(stdout.String(), `"version":"dev"`) {
		t.Fatalf("unexpected version output: %s", stdout.String())
	}
}

func TestBuildInfoUsesLinkerMetadata(t *testing.T) {
	previousVersion, previousCommit, previousBuildDate := Version, Commit, BuildDate
	t.Cleanup(func() {
		Version, Commit, BuildDate = previousVersion, previousCommit, previousBuildDate
	})
	Version, Commit, BuildDate = "0.2.0", "abc1234", "2026-08-30T12:00:00Z"

	got := buildInfo()
	if got.Version != Version || got.Commit != Commit || got.BuildDate != BuildDate {
		t.Fatalf("build info = %+v", got)
	}
}

func TestResolveVersion(t *testing.T) {
	tests := []struct {
		name          string
		linkerVersion string
		moduleVersion string
		want          string
	}{
		{name: "linker metadata wins", linkerVersion: "0.2.0", moduleVersion: "v9.9.9", want: "0.2.0"},
		{name: "tagged module", linkerVersion: "dev", moduleVersion: "v0.2.0", want: "0.2.0"},
		{name: "development build", linkerVersion: "dev", moduleVersion: "(devel)", want: "dev"},
		{name: "missing build info", linkerVersion: "dev", want: "dev"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := resolveVersion(test.linkerVersion, test.moduleVersion); got != test.want {
				t.Fatalf("resolveVersion(%q, %q) = %q, want %q", test.linkerVersion, test.moduleVersion, got, test.want)
			}
		})
	}
}
