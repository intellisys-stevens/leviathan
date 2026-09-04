package collector

import (
	"context"
	"errors"
	"fmt"
	"sync/atomic"
	"testing"
	"time"

	"github.com/intellisys-stevens/leviathan/internal/model"
	providerpkg "github.com/intellisys-stevens/leviathan/internal/provider"
	"github.com/intellisys-stevens/leviathan/internal/provider/fake"
)

type systemSamplerFunc func(context.Context, time.Time) (model.System, []model.Diagnostic, error)

func (function systemSamplerFunc) Sample(ctx context.Context, at time.Time) (model.System, []model.Diagnostic, error) {
	return function(ctx, at)
}

type unavailableGPUProvider struct{ openCalls atomic.Int32 }

func (provider *unavailableGPUProvider) Name() string { return "unavailable-gpu" }
func (provider *unavailableGPUProvider) Open(context.Context) error {
	provider.openCalls.Add(1)
	return fmt.Errorf("%w: NVML library not found", providerpkg.ErrUnavailable)
}
func (*unavailableGPUProvider) Close() error { return nil }
func (*unavailableGPUProvider) Sample(context.Context, time.Time) (model.Snapshot, error) {
	return model.Snapshot{}, errors.New("not open")
}
func (*unavailableGPUProvider) Capabilities() model.Capabilities {
	return model.Capabilities{NVML: model.ProviderState{Name: "NVML", Status: model.StatusUnsupported, Message: "library not found"}}
}

type blockingGPUProvider struct{ calls atomic.Int32 }

func (*blockingGPUProvider) Name() string                     { return "blocking-gpu" }
func (*blockingGPUProvider) Open(context.Context) error       { return nil }
func (*blockingGPUProvider) Close() error                     { return nil }
func (*blockingGPUProvider) Capabilities() model.Capabilities { return availableGPUCapabilities() }
func (provider *blockingGPUProvider) Sample(ctx context.Context, at time.Time) (model.Snapshot, error) {
	if provider.calls.Add(1) == 1 {
		return availableGPUSnapshot(at), nil
	}
	<-ctx.Done()
	return model.Snapshot{}, ctx.Err()
}

type initiallyBlockingGPUProvider struct{ calls atomic.Int32 }

func (*initiallyBlockingGPUProvider) Name() string               { return "initially-blocking-gpu" }
func (*initiallyBlockingGPUProvider) Open(context.Context) error { return nil }
func (*initiallyBlockingGPUProvider) Close() error               { return nil }
func (*initiallyBlockingGPUProvider) Capabilities() model.Capabilities {
	return availableGPUCapabilities()
}
func (provider *initiallyBlockingGPUProvider) Sample(ctx context.Context, _ time.Time) (model.Snapshot, error) {
	provider.calls.Add(1)
	<-ctx.Done()
	return model.Snapshot{}, ctx.Err()
}

func TestCPUOnlyStartupSurvivesMissingGPUProvider(t *testing.T) {
	provider := &unavailableGPUProvider{}
	engine := NewWithOptions(provider, Options{
		SamplingInterval: 20 * time.Millisecond, HistoryWindow: time.Minute,
		SystemSampler: systemSamplerFunc(func(_ context.Context, at time.Time) (model.System, []model.Diagnostic, error) {
			return availableSystem(at, 31), nil, nil
		}),
	})
	if err := engine.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer engine.Stop()
	deadline := time.Now().Add(time.Second)
	for (provider.openCalls.Load() < 2 || engine.LastError() == nil) && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	snapshot, ok := engine.Current()
	if !ok || snapshot.System.Status != model.StatusAvailable || len(snapshot.GPUs) != 0 {
		t.Fatalf("CPU-only snapshot = %+v", snapshot)
	}
	if snapshot.Capabilities.NVML.Available || snapshot.Capabilities.NVML.Status != model.StatusUnsupported {
		t.Fatalf("GPU capability = %+v", snapshot.Capabilities.NVML)
	}
	var unavailableDiagnostic bool
	for _, diagnostic := range snapshot.Diagnostics {
		if diagnostic.Code == "collector_sample" {
			t.Fatalf("CPU-only startup was reported as a sampling failure: %+v", snapshot.Diagnostics)
		}
		if diagnostic.Code == "gpu_provider_unavailable" && diagnostic.Severity == "warning" && diagnostic.Status == model.StatusUnsupported {
			unavailableDiagnostic = true
		}
	}
	if !unavailableDiagnostic {
		t.Fatalf("CPU-only diagnostic missing: %+v", snapshot.Diagnostics)
	}
	if provider.openCalls.Load() < 2 {
		t.Fatal("GPU provider was not retried")
	}
	if !errors.Is(engine.LastError(), providerpkg.ErrUnavailable) {
		t.Fatal("missing GPU provider was not retained as degraded health")
	}
}

func TestCombinedFixtureObservationRetainsSystemHistory(t *testing.T) {
	engine := New(fake.New(), 20*time.Millisecond, time.Minute)
	if err := engine.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer engine.Stop()
	snapshot, ok := engine.Current()
	if !ok {
		t.Fatal("fixture did not publish a snapshot")
	}
	points := engine.History("@host", []string{"memory_utilization"}, time.Minute, snapshot.SampledAt).Points
	if len(points) != 1 || points[0].Values["memory_utilization"] == 0 {
		t.Fatalf("fixture system history = %+v", points)
	}
}

func TestInitiallyHungGPUDoesNotDelayStartupOrSystemPublication(t *testing.T) {
	provider := &initiallyBlockingGPUProvider{}
	var systemCalls atomic.Int32
	engine := NewWithOptions(provider, Options{
		SamplingInterval: 20 * time.Millisecond, HistoryWindow: time.Minute,
		SystemSampler: systemSamplerFunc(func(_ context.Context, at time.Time) (model.System, []model.Diagnostic, error) {
			call := systemCalls.Add(1)
			return availableSystem(at, float64(call)), nil, nil
		}),
	})
	ctx, cancel := context.WithCancel(context.Background())
	startResult := make(chan error, 1)
	go func() { startResult <- engine.Start(ctx) }()
	select {
	case err := <-startResult:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(500 * time.Millisecond):
		cancel()
		t.Fatal("startup waited for the first GPU sample")
	}
	deadline := time.Now().Add(time.Second)
	for systemCalls.Load() < 3 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if systemCalls.Load() < 3 || provider.calls.Load() != 1 {
		cancel()
		_ = engine.Stop()
		t.Fatalf("system did not advance independently: system=%d gpu=%d", systemCalls.Load(), provider.calls.Load())
	}
	cancel()
	if err := engine.Stop(); err != nil {
		t.Fatal(err)
	}
}

func TestHungGPUDoesNotDelaySystemPublication(t *testing.T) {
	provider := &blockingGPUProvider{}
	var systemCalls atomic.Int32
	engine := NewWithOptions(provider, Options{
		SamplingInterval: 20 * time.Millisecond, HistoryWindow: time.Minute,
		SystemSampler: systemSamplerFunc(func(_ context.Context, at time.Time) (model.System, []model.Diagnostic, error) {
			call := systemCalls.Add(1)
			return availableSystem(at, float64(call)), nil, nil
		}),
	})
	ctx, cancel := context.WithCancel(context.Background())
	if err := engine.Start(ctx); err != nil {
		t.Fatal(err)
	}
	events, unsubscribe := engine.Subscribe()
	defer unsubscribe()
	initial := <-events
	initialSequence := initial.Sequence
	deadline := time.After(time.Second)
	for {
		select {
		case snapshot := <-events:
			if snapshot.Sequence > initialSequence && systemCalls.Load() >= 3 && snapshot.System.CPU.Utilization.Value != nil {
				cancel()
				if err := engine.Stop(); err != nil {
					t.Fatal(err)
				}
				return
			}
		case <-deadline:
			cancel()
			_ = engine.Stop()
			t.Fatalf("system stopped publishing while GPU was blocked; calls=%d", systemCalls.Load())
		}
	}
}

func TestSystemFailureLeavesGPUCurrent(t *testing.T) {
	var calls atomic.Int32
	engine := NewWithOptions(&scriptedProvider{failOn: map[int32]bool{}}, Options{
		SamplingInterval: 20 * time.Millisecond, HistoryWindow: time.Minute,
		SystemSampler: systemSamplerFunc(func(_ context.Context, at time.Time) (model.System, []model.Diagnostic, error) {
			if calls.Add(1) == 1 {
				return availableSystem(at, 44), nil, nil
			}
			return model.System{}, nil, errors.New("procfs disappeared")
		}),
	})
	if err := engine.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer engine.Stop()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		snapshot, _ := engine.Current()
		if snapshot.System.Status == model.StatusStale {
			metric := snapshot.GPUs[0].GPUInstances[0].Metrics["sm_activity"]
			if metric.Status != model.StatusAvailable || metric.Value == nil {
				t.Fatalf("GPU was staled by system failure: %+v", metric)
			}
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("system failure was not published")
}

func availableSystem(at time.Time, utilization float64) model.System {
	total, used, available := uint64(1024), uint64(512), uint64(512)
	status := model.StatusAvailable
	return model.System{
		CPU: model.CPU{
			Model: "fixture", LogicalProcessors: 2,
			Utilization: model.AvailableMetric(utilization, "percent", model.SourceSynthetic, model.ScopeHost, at),
			Load1:       model.AvailableMetric(1, "load", model.SourceSynthetic, model.ScopeHost, at), Load5: model.AvailableMetric(1, "load", model.SourceSynthetic, model.ScopeHost, at), Load15: model.AvailableMetric(1, "load", model.SourceSynthetic, model.ScopeHost, at),
			Source: model.SourceSynthetic, SampledAt: at, Status: status,
		},
		Memory: model.SystemMemory{
			TotalBytes: &total, UsedBytes: &used, AvailableBytes: &available,
			Utilization: model.AvailableMetric(50, "percent", model.SourceSynthetic, model.ScopeHost, at),
			Source:      model.SourceSynthetic, Scope: model.ScopeHost, SampledAt: at, Status: status,
		},
		Storage:   model.Storage{TotalBytes: &total, UsedBytes: &used, AvailableBytes: &available, Filesystems: []model.Filesystem{}, Source: model.SourceSynthetic, Scope: model.ScopeHost, SampledAt: at, Status: status},
		SampledAt: at, Status: status,
	}
}

func availableGPUCapabilities() model.Capabilities {
	return model.Capabilities{NVML: model.ProviderState{Name: "fixture", Available: true, Status: model.StatusAvailable}}
}

func availableGPUSnapshot(at time.Time) model.Snapshot {
	return model.Snapshot{SampledAt: at, Capabilities: availableGPUCapabilities(), GPUs: []model.GPU{}, Processes: []model.Process{}, Diagnostics: []model.Diagnostic{}}
}
