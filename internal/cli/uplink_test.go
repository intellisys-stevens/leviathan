package cli

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/intellisys-stevens/leviathan/internal/config"
	"github.com/intellisys-stevens/leviathan/internal/model"
	"github.com/intellisys-stevens/leviathan/internal/uplink"
)

func TestConfiguredUplinkSubscribesOnceToCallerOwnedSource(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Error("uplink attempted a request without a collector snapshot")
	}))
	defer server.Close()
	tokenPath := filepath.Join(t.TempDir(), "uplink-token")
	if err := os.WriteFile(tokenPath, []byte(cliTestMachineToken()+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := config.UplinkConfig{Enabled: true, BaseURL: server.URL, TokenFile: tokenPath, Interval: time.Second}
	source := &countingSnapshotSource{events: make(chan model.Snapshot), subscribed: make(chan struct{}, 1)}
	runner, err := newConfiguredUplink(cfg, source, model.BuildInfo{Version: "test"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if runner == nil {
		t.Fatal("enabled uplink did not construct a runner")
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- runner.Run(ctx) }()
	select {
	case <-source.subscribed:
	case <-time.After(time.Second):
		t.Fatal("runner did not subscribe to the supplied source")
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Run() = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("runner did not stop with serve context")
	}
	if source.subscribeCalls.Load() != 1 || source.unsubscribeCalls.Load() != 1 {
		t.Fatalf("subscriptions = %d, unsubscriptions = %d", source.subscribeCalls.Load(), source.unsubscribeCalls.Load())
	}
}

func TestConfiguredUplinkDisabledDoesNotTouchSourceOrCredential(t *testing.T) {
	source := &countingSnapshotSource{events: make(chan model.Snapshot), subscribed: make(chan struct{}, 1)}
	runner, err := newConfiguredUplink(config.UplinkConfig{}, source, model.BuildInfo{}, nil)
	if err != nil || runner != nil || source.subscribeCalls.Load() != 0 {
		t.Fatalf("runner = %v, subscriptions = %d, err = %v", runner, source.subscribeCalls.Load(), err)
	}
}

func TestConfiguredUplinkFailsBeforeServeOnUnsafeCredential(t *testing.T) {
	tokenPath := filepath.Join(t.TempDir(), "uplink-token")
	if err := os.WriteFile(tokenPath, []byte(cliTestMachineToken()), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(tokenPath, 0o644); err != nil {
		t.Fatal(err)
	}
	cfg := config.UplinkConfig{Enabled: true, BaseURL: "https://yggdrasil.example.test", TokenFile: tokenPath, Interval: 15 * time.Second}
	_, err := newConfiguredUplink(cfg, &countingSnapshotSource{events: make(chan model.Snapshot)}, model.BuildInfo{}, nil)
	if !errors.Is(err, uplink.ErrCredentialInsecure) || strings.Contains(err.Error(), tokenPath) || strings.Contains(err.Error(), cliTestMachineToken()) {
		t.Fatalf("credential startup error = %v", err)
	}
}

func TestUplinkAttemptReporterEmitsOnlySanitizedFailures(t *testing.T) {
	var output bytes.Buffer
	reporter := uplinkAttemptReporter(&output)
	reporter(uplink.AttemptResult{Succeeded: true})
	if output.Len() != 0 {
		t.Fatalf("success was logged: %q", output.String())
	}
	reporter(uplink.AttemptResult{Err: uplink.ErrRequestFailed, NextAttemptIn: 5100 * time.Millisecond})
	if got := output.String(); !strings.Contains(got, "uplink request failed") || !strings.Contains(got, "5.1s") {
		t.Fatalf("failure log = %q", got)
	}
	uplinkAttemptReporter(nil)(uplink.AttemptResult{Err: uplink.ErrRequestFailed})
}

type countingSnapshotSource struct {
	events           chan model.Snapshot
	subscribed       chan struct{}
	subscribeCalls   atomic.Int32
	unsubscribeCalls atomic.Int32
}

func (source *countingSnapshotSource) Subscribe() (<-chan model.Snapshot, func()) {
	source.subscribeCalls.Add(1)
	if source.subscribed != nil {
		source.subscribed <- struct{}{}
	}
	return source.events, func() { source.unsubscribeCalls.Add(1) }
}

func cliTestMachineToken() string {
	lookup := base64.RawURLEncoding.EncodeToString(make([]byte, 16))
	secret := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{1}, 32))
	return "yv1_" + lookup + "_" + secret
}

var _ uplink.SnapshotSource = (*countingSnapshotSource)(nil)
var _ io.Writer = (*bytes.Buffer)(nil)
