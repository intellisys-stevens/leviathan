package uplink

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/intellisys-stevens/leviathan/internal/model"
)

func TestConfiguredRunnerSubscribesOnceToCallerOwnedSource(t *testing.T) {
	tokenPath := writeTestToken(t, 0o600)
	source := &countingSource{events: make(chan model.Snapshot), subscribed: make(chan struct{}, 1)}
	runner, err := NewConfiguredRunner(Configuration{
		Enabled: true, BaseURL: "https://yggdrasil.example.test", TokenFile: tokenPath, Interval: time.Second,
	}, source, model.BuildInfo{Version: "test"}, nil)
	if err != nil {
		t.Fatal(err)
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

func TestConfiguredRunnerDisabledDoesNotTouchSourceOrCredential(t *testing.T) {
	source := &countingSource{events: make(chan model.Snapshot)}
	runner, err := NewConfiguredRunner(Configuration{TokenFile: "/missing/credential"}, source, model.BuildInfo{}, nil)
	if err != nil || runner != nil || source.subscribeCalls.Load() != 0 {
		t.Fatalf("runner = %v, subscriptions = %d, err = %v", runner, source.subscribeCalls.Load(), err)
	}
}

func TestConfiguredRunnerFailsFastWithoutDisclosingCredentialPath(t *testing.T) {
	tokenPath := writeTestToken(t, 0o644)
	_, err := NewConfiguredRunner(Configuration{
		Enabled: true, BaseURL: "https://yggdrasil.example.test", TokenFile: tokenPath, Interval: DefaultInterval,
	}, &countingSource{events: make(chan model.Snapshot)}, model.BuildInfo{}, nil)
	if !errors.Is(err, ErrCredentialInsecure) || strings.Contains(err.Error(), tokenPath) || strings.Contains(err.Error(), testMachineToken()) {
		t.Fatalf("credential startup error = %v", err)
	}
}

func writeTestToken(t *testing.T, mode os.FileMode) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "uplink-token")
	if err := os.WriteFile(path, append([]byte(testMachineToken()), '\n'), mode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, mode); err != nil {
		t.Fatal(err)
	}
	return path
}

type countingSource struct {
	events           chan model.Snapshot
	subscribed       chan struct{}
	subscribeCalls   atomic.Int32
	unsubscribeCalls atomic.Int32
}

func (source *countingSource) Subscribe() (<-chan model.Snapshot, func()) {
	source.subscribeCalls.Add(1)
	if source.subscribed != nil {
		source.subscribed <- struct{}{}
	}
	return source.events, func() { source.unsubscribeCalls.Add(1) }
}

var _ SnapshotSource = (*countingSource)(nil)
