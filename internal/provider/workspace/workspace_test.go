package workspace

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/intellisys-stevens/leviathan/internal/model"
	workspaceprocess "github.com/intellisys-stevens/leviathan/internal/process"
)

type testProvider struct{}

func (testProvider) Name() string                     { return "test" }
func (testProvider) Open(context.Context) error       { return nil }
func (testProvider) Close() error                     { return nil }
func (testProvider) Capabilities() model.Capabilities { return model.Capabilities{} }
func (testProvider) Sample(_ context.Context, at time.Time) (model.Snapshot, error) {
	return model.Snapshot{SampledAt: at}, nil
}

type countingScanner struct {
	mu    sync.Mutex
	calls int
}

type emptyScanner struct{}

func (emptyScanner) Scan() workspaceprocess.Inventory {
	return workspaceprocess.Inventory{}
}

func (s *countingScanner) Scan() workspaceprocess.Inventory {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls++
	startedAt := time.Date(2026, 8, 30, 11, 0, s.calls, 0, time.UTC)
	return workspaceprocess.Inventory{
		Processes: []model.Process{{PID: uint32(1000 + s.calls), StartTime: &startedAt, ScopeRef: "scope_internal", Status: model.StatusAvailable}},
		Capability: model.ProviderState{
			Name: "test process inventory", Available: true, Status: model.StatusAvailable,
		},
		Diagnostics: []model.Diagnostic{{Code: "scan", Detail: "inventory"}},
	}
}

func (s *countingScanner) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.calls
}

func TestProcessInventoryUsesIndependentInterval(t *testing.T) {
	ctx := context.Background()
	at := time.Date(2026, 8, 30, 12, 0, 0, 0, time.UTC)
	scanner := &countingScanner{}
	p := New(testProvider{}, scanner, Options{InventoryInterval: 2 * time.Second})

	first, err := p.Sample(ctx, at)
	if err != nil {
		t.Fatal(err)
	}
	second, err := p.Sample(ctx, at.Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if scanner.count() != 1 || first.Processes[0].PID != second.Processes[0].PID {
		t.Fatalf("inventory was not cached: calls=%d first=%v second=%v", scanner.count(), first.Processes, second.Processes)
	}

	third, err := p.Sample(ctx, at.Add(2*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if scanner.count() != 2 || third.Processes[0].PID == first.Processes[0].PID {
		t.Fatalf("inventory was not refreshed at the boundary: calls=%d third=%v", scanner.count(), third.Processes)
	}
}

func TestProcessInventoryIntervalDefaultsToTwoSeconds(t *testing.T) {
	p := New(testProvider{}, &countingScanner{})
	if p.options.InventoryInterval != 2*time.Second {
		t.Fatalf("process inventory interval = %s", p.options.InventoryInterval)
	}
}

func TestEmptyProcessInventoryRemainsNonNilAndSerializesAsArrays(t *testing.T) {
	p := New(testProvider{}, emptyScanner{})
	snapshot, err := p.Sample(context.Background(), time.Date(2026, 8, 30, 12, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Processes == nil || snapshot.Diagnostics == nil {
		t.Fatalf("empty collections must be non-nil: processes=%#v diagnostics=%#v", snapshot.Processes, snapshot.Diagnostics)
	}

	data, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	var payload map[string]json.RawMessage
	if err := json.Unmarshal(data, &payload); err != nil {
		t.Fatal(err)
	}
	if string(payload["processes"]) != "[]" || string(payload["diagnostics"]) != "[]" {
		t.Fatalf("empty snapshot collections encoded as %s and %s", payload["processes"], payload["diagnostics"])
	}
}

func TestCachedInventoryIsCloned(t *testing.T) {
	ctx := context.Background()
	at := time.Date(2026, 8, 30, 12, 0, 0, 0, time.UTC)
	scanner := &countingScanner{}
	p := New(testProvider{}, scanner, Options{InventoryInterval: 2 * time.Second})

	first, err := p.Sample(ctx, at)
	if err != nil {
		t.Fatal(err)
	}
	first.Processes[0].PID = 9999
	first.Processes[0].ScopeRef = "mutated"
	*first.Processes[0].StartTime = time.Time{}
	first.Diagnostics[0].Detail = "mutated"

	second, err := p.Sample(ctx, at.Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if second.Processes[0].PID == 9999 || second.Processes[0].ScopeRef != "scope_internal" || second.Processes[0].StartTime.IsZero() || second.Diagnostics[0].Detail == "mutated" {
		t.Fatalf("caller mutation reached cached inventory: %+v", second)
	}
}

func TestProcessInventoryRescansWhenClockMovesBackward(t *testing.T) {
	ctx := context.Background()
	at := time.Date(2026, 8, 30, 12, 0, 0, 0, time.UTC)
	scanner := &countingScanner{}
	p := New(testProvider{}, scanner, Options{InventoryInterval: time.Minute})
	if _, err := p.Sample(ctx, at); err != nil {
		t.Fatal(err)
	}
	if _, err := p.Sample(ctx, at.Add(-time.Second)); err != nil {
		t.Fatal(err)
	}
	if scanner.count() != 2 {
		t.Fatalf("backward clock reused a future inventory: calls=%d", scanner.count())
	}
}
