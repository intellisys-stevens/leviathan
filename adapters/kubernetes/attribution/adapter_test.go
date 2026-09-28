package attribution

import (
	"context"
	"encoding/json"
	"net/http"
	"sync/atomic"
	"testing"
	"time"

	"github.com/intellisys-stevens/leviathan/model"
)

func TestAdapterRunsWithoutGPUAndOutlivesInitializationContext(t *testing.T) {
	now := time.Now().UTC()
	document := validDocument(now)
	var polls atomic.Int32
	socket, closeServer := serveDocument(t, func(w http.ResponseWriter, r *http.Request) {
		polls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(document)
	})
	defer closeServer()
	options := testOptions(socket, &now)
	options.PollInterval = 5 * time.Millisecond
	client, err := NewClient(options)
	if err != nil {
		t.Fatal(err)
	}
	adapter := NewAdapter(client, "")
	ctx, cancel := context.WithCancel(context.Background())
	if err = adapter.Open(ctx); err != nil {
		t.Fatal(err)
	}
	defer adapter.Close()
	cancel()
	deadline := time.Now().Add(time.Second)
	for polls.Load() < 3 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if polls.Load() < 3 {
		t.Fatal("polling stopped with the initialization context")
	}
	original := model.Snapshot{SampledAt: now.Add(-time.Hour), Processes: []model.Process{{PID: 4, ScopeRef: document.ProcessScopes[0].ScopeRef, WorkloadRef: "original"}}}
	observed, scopes := adapter.ObserveWithScopes(original)
	if observed.Attribution == nil || observed.Attribution.Status != model.AttributionAvailable || len(scopes) != 1 {
		t.Fatalf("independent attribution = %+v, scopes=%v", observed.Attribution, scopes)
	}
	if observed.Processes[0].WorkloadRef != document.Workloads[0].Ref || original.Processes[0].WorkloadRef != "original" {
		t.Fatal("process join missing or mutated shared snapshot")
	}
	if !observed.SampledAt.Equal(original.SampledAt) || !observed.Attribution.ObservedAt.Equal(document.SourceObservedAt) {
		t.Fatal("adapter advanced source timestamps")
	}
	if !adapter.NeedsTopologyRefresh(now) || adapter.NeedsTopologyRefresh(now) {
		t.Fatal("refresh is not coalesced")
	}
}

func TestAdapterOpenBoundsInitialRequestAndCloseStopsWorker(t *testing.T) {
	now := time.Now().UTC()
	socket, closeServer := serveDocument(t, func(w http.ResponseWriter, r *http.Request) { <-r.Context().Done() })
	defer closeServer()
	options := testOptions(socket, &now)
	client, err := NewClient(options)
	if err != nil {
		t.Fatal(err)
	}
	adapter := NewAdapter(client, "")
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	start := time.Now()
	if err = adapter.Open(ctx); err != nil {
		t.Fatal(err)
	}
	if time.Since(start) > time.Second {
		t.Fatal("initial request exceeded context bound")
	}
	if err = adapter.Close(); err != nil {
		t.Fatal(err)
	}
	if observed := adapter.Observe(model.Snapshot{}); observed.Attribution.Status != model.AttributionUnavailable {
		t.Fatalf("missing inventory = %+v", observed.Attribution)
	}
}
