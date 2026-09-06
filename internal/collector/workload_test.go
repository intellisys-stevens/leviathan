package collector

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/intellisys-stevens/leviathan/internal/history"
	"github.com/intellisys-stevens/leviathan/internal/model"
	"github.com/intellisys-stevens/leviathan/internal/provider"
	"github.com/intellisys-stevens/leviathan/internal/provider/fake"
)

type workloadSamplerStub struct {
	calls  atomic.Int64
	closed atomic.Bool
}

func (s *workloadSamplerStub) Sample(_ context.Context, at time.Time) (model.WorkloadTelemetry, error) {
	s.calls.Add(1)
	return model.WorkloadTelemetry{SampledAt: at, Status: model.WorkloadTelemetryAvailable, Owners: []model.WorkloadOwnerTelemetry{{Ref: "owner_one", Name: "owner", SampledAt: at, Status: model.WorkloadTelemetryAvailable, Workspaces: []model.WorkloadAttribution{}, Metrics: model.MetricSet{"cpu_cores": model.AvailableMetric(1, "cores", model.SourceCgroupFS, model.ScopeWorkloadOwner, at)}}}}, nil
}
func (s *workloadSamplerStub) Close() error { s.closed.Store(true); return nil }

type blockedGPUProvider struct{ provider.Provider }

func (p blockedGPUProvider) Open(ctx context.Context) error { <-ctx.Done(); return ctx.Err() }

func TestWorkloadWorkerContinuesWhileGPUOpenIsBlocked(t *testing.T) {
	sam := &workloadSamplerStub{}
	engine := NewWithOptions(blockedGPUProvider{fake.New()}, Options{SamplingInterval: 500 * time.Millisecond, HistoryWindow: time.Hour, WorkloadSampler: sam})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := engine.Start(ctx); err != nil {
		t.Fatal(err)
	}
	deadline := time.NewTimer(3 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for sam.calls.Load() < 2 {
		select {
		case <-deadline.C:
			t.Fatal("workload worker blocked behind GPU startup")
		case <-ticker.C:
		}
	}
	cancel()
	select {
	case <-engine.done:
	case <-time.After(time.Second):
		t.Fatal("workers did not stop")
	}
	if !sam.closed.Load() {
		t.Fatal("workload sampler was not closed")
	}
	snapshot, ok := engine.Current()
	if !ok || snapshot.WorkloadTelemetry == nil || snapshot.WorkloadTelemetry.Owners[0].Metrics["cpu_cores"].Value == nil {
		t.Fatal("owner telemetry did not publish")
	}
}

func TestGPUPublicationsPreserveIndependentOwnerSnapshot(t *testing.T) {
	at := time.Now().UTC()
	sam := &workloadSamplerStub{}
	engine := NewWithOptions(fake.New(), Options{SamplingInterval: time.Second, HistoryWindow: time.Hour, WorkloadSampler: sam})
	if err := engine.poll(context.Background(), at); err != nil {
		t.Fatal(err)
	}
	healthBefore := engine.HealthObservation()
	if err := engine.pollWorkload(context.Background(), at.Add(500*time.Millisecond)); err != nil {
		t.Fatal(err)
	}
	healthAfter := engine.HealthObservation()
	if !healthBefore.GPU.ObservedAt.Equal(*healthAfter.GPU.ObservedAt) || !healthBefore.System.ObservedAt.Equal(*healthAfter.System.ObservedAt) {
		t.Fatal("owner publication refreshed independent host/GPU health")
	}
	first, _ := engine.Current()
	if err := engine.poll(context.Background(), at.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	second, _ := engine.Current()
	if first.WorkloadTelemetry != second.WorkloadTelemetry {
		t.Fatal("GPU poll discarded independent owner data")
	}
	series := engine.AlignedHistory([]history.SeriesDescriptor{{Key: "cpu", Entity: "owner:owner_one", Metrics: []string{"cpu_cores"}}}, time.Minute, 100, at.Add(time.Second))
	if len(series.Points) != 1 || !series.Points[0].SampledAt.Equal(at.Add(500*time.Millisecond)) {
		t.Fatalf("owner history=%+v", series.Points)
	}
}

func TestGPUFailureExpiresAssignmentsWhileOwnerTelemetryRemainsFresh(t *testing.T) {
	at := time.Now().UTC()
	engine := NewWithOptions(fake.New(), Options{SamplingInterval: time.Second, HistoryWindow: time.Hour, WorkloadSampler: &workloadSamplerStub{}})
	if err := engine.poll(context.Background(), at); err != nil {
		t.Fatal(err)
	}
	snapshot, _ := engine.Current()
	original := &model.Attribution{Status: model.AttributionAvailable, ObservedAt: &at, Workloads: []model.WorkloadAttribution{{Ref: "workspace_one"}}, Assignments: []model.ResourceAssignment{{WorkloadRef: "workspace_one", EntityUUID: "GPU-one"}}}
	snapshot.Attribution = original
	engine.current.Store(&snapshot)
	engine.recordPollError(at.Add(time.Second), assertionError("GPU unavailable"))
	stale, _ := engine.Current()
	if stale.Attribution.Status != model.AttributionStale || original.Status != model.AttributionAvailable {
		t.Fatal("GPU failure did not immutably stale assignments")
	}
	if err := engine.pollWorkload(context.Background(), at.Add(61*time.Second)); err != nil {
		t.Fatal(err)
	}
	current, _ := engine.Current()
	if current.Attribution.Status != model.AttributionUnavailable || len(current.Attribution.Assignments) != 0 {
		t.Fatal("owner publication kept expired assignments")
	}
	if current.WorkloadTelemetry.Status != model.WorkloadTelemetryAvailable || current.WorkloadTelemetry.Owners[0].Metrics["cpu_cores"].Value == nil {
		t.Fatal("GPU expiry affected owner telemetry")
	}
}

func TestOtherCollectorsDoNotKeepStalledOwnerReadingsLive(t *testing.T) {
	at := time.Now().UTC()
	engine := NewWithOptions(fake.New(), Options{SamplingInterval: time.Second, HistoryWindow: time.Hour, WorkloadSampler: &workloadSamplerStub{}})
	engine.pollWorkload(context.Background(), at)
	first, _ := engine.Current()
	original := first.WorkloadTelemetry
	if err := engine.poll(context.Background(), at.Add(7*time.Second)); err != nil {
		t.Fatal(err)
	}
	current, _ := engine.Current()
	if current.WorkloadTelemetry.Status != model.WorkloadTelemetryStale || current.WorkloadTelemetry.Owners[0].Metrics["cpu_cores"].Value != nil {
		t.Fatal("GPU polling retained apparently live owner metric")
	}
	if original.Status != model.WorkloadTelemetryAvailable || original.Owners[0].Metrics["cpu_cores"].Value == nil {
		t.Fatal("published owner snapshot mutated")
	}
}
