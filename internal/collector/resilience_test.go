package collector

import (
	"context"
	"errors"
	"os"
	"runtime"
	"sync/atomic"
	"testing"
	"time"

	"github.com/miglens/miglens/internal/model"
	"github.com/miglens/miglens/internal/provider/fake"
)

type scriptedProvider struct {
	calls  atomic.Int32
	failOn map[int32]bool
}

type overlapProvider struct {
	active    atomic.Int32
	maxActive atomic.Int32
	calls     atomic.Int32
	delay     time.Duration
}

func (p *overlapProvider) Name() string                     { return "overlap" }
func (p *overlapProvider) Open(context.Context) error       { return nil }
func (p *overlapProvider) Close() error                     { return nil }
func (p *overlapProvider) Capabilities() model.Capabilities { return model.Capabilities{} }
func (p *overlapProvider) Sample(ctx context.Context, at time.Time) (model.Snapshot, error) {
	active := p.active.Add(1)
	defer p.active.Add(-1)
	for {
		maximum := p.maxActive.Load()
		if active <= maximum || p.maxActive.CompareAndSwap(maximum, active) {
			break
		}
	}
	p.calls.Add(1)
	if p.delay > 0 {
		timer := time.NewTimer(p.delay)
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return model.Snapshot{}, ctx.Err()
		case <-timer.C:
		}
	}
	return model.Snapshot{SampledAt: at, GPUs: []model.GPU{}, Processes: []model.Process{}, Diagnostics: []model.Diagnostic{}}, nil
}

func (p *scriptedProvider) Name() string               { return "scripted" }
func (p *scriptedProvider) Open(context.Context) error { return nil }
func (p *scriptedProvider) Close() error               { return nil }
func (p *scriptedProvider) Capabilities() model.Capabilities {
	return model.Capabilities{NVML: model.ProviderState{Name: "fixture", Available: true, Status: model.StatusAvailable}}
}
func (p *scriptedProvider) Sample(_ context.Context, at time.Time) (model.Snapshot, error) {
	call := p.calls.Add(1)
	if p.failOn[call] {
		return model.Snapshot{}, errors.New("fixture device disappeared")
	}
	metric := model.AvailableMetric(42, "percent", model.SourceSynthetic, model.ScopeGPUInstance, at)
	return model.Snapshot{SampledAt: at, Capabilities: p.Capabilities(), Diagnostics: []model.Diagnostic{}, Processes: []model.Process{{PID: 42, Status: model.StatusAvailable}}, GPUs: []model.GPU{{
		UUID: "GPU-a", Metrics: model.MetricSet{}, GPUInstances: []model.GPUInstance{{
			UUID: "GPU-a/gi/1", Metrics: model.MetricSet{"sm_activity": metric},
			ComputeInstances: []model.ComputeInstance{{UUID: "MIG-a", Metrics: model.MetricSet{}}},
		}},
	}}}, nil
}

func TestTransientErrorTriggersImmediateRetry(t *testing.T) {
	provider := &scriptedProvider{failOn: map[int32]bool{2: true}}
	engine := New(provider, 20*time.Millisecond, time.Minute)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := engine.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer engine.Stop()
	updates, unsubscribe := engine.Subscribe()
	defer unsubscribe()
	<-updates
	select {
	case snapshot := <-updates:
		if provider.calls.Load() < 3 || snapshot.Diagnostics == nil {
			t.Fatalf("retry calls=%d snapshot=%+v", provider.calls.Load(), snapshot)
		}
		if snapshot.GPUs[0].GPUInstances[0].Metrics["sm_activity"].Status != model.StatusAvailable {
			t.Fatal("successful immediate retry was published as stale")
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for retried sample")
	}
}

func TestPersistentErrorPublishesExplicitStaleSnapshot(t *testing.T) {
	provider := &scriptedProvider{failOn: map[int32]bool{2: true, 3: true, 4: true, 5: true}}
	engine := New(provider, 20*time.Millisecond, time.Minute)
	if err := engine.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer engine.Stop()
	updates, unsubscribe := engine.Subscribe()
	defer unsubscribe()
	<-updates
	select {
	case snapshot := <-updates:
		metric := snapshot.GPUs[0].GPUInstances[0].Metrics["sm_activity"]
		if metric.Status != model.StatusStale || metric.Value != nil {
			t.Fatalf("metric = %+v", metric)
		}
		if snapshot.Processes[0].Status != model.StatusStale {
			t.Fatal("retained process inventory was not labelled stale")
		}
		if snapshot.Diagnostics[len(snapshot.Diagnostics)-1].Code != "collector_sample" {
			t.Fatalf("diagnostics = %+v", snapshot.Diagnostics)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for stale snapshot")
	}
}

func TestSamplingIntervalReschedulesAndNeverOverlaps(t *testing.T) {
	provider := &overlapProvider{delay: 300 * time.Millisecond}
	engine := New(provider, 2*time.Second, time.Hour)
	if err := engine.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := engine.SetSamplingInterval(500 * time.Millisecond); err != nil {
		t.Fatal(err)
	}
	if err := engine.SetSamplingInterval(time.Second); err != nil {
		t.Fatal(err)
	}
	if err := engine.SetSamplingInterval(500 * time.Millisecond); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for provider.calls.Load() < 2 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if err := engine.Stop(); err != nil {
		t.Fatal(err)
	}
	if provider.calls.Load() < 2 {
		t.Fatalf("updated cadence did not trigger another poll: %d calls", provider.calls.Load())
	}
	if provider.maxActive.Load() != 1 {
		t.Fatalf("provider polls overlapped: max active = %d", provider.maxActive.Load())
	}
	if got := engine.RuntimeSettings(); got.SamplingIntervalMs != 500 || got.HistoryWindowMs != time.Hour.Milliseconds() {
		t.Fatalf("runtime settings = %+v", got)
	}
	if engine.history.Capacity() != int(time.Hour/(500*time.Millisecond))+2 {
		t.Fatalf("history capacity = %d", engine.history.Capacity())
	}
}

func TestShutdownDuringIntervalUpdate(t *testing.T) {
	provider := &overlapProvider{}
	engine := New(provider, time.Second, time.Minute)
	if err := engine.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		for index := 0; index < 100; index++ {
			_ = engine.SetSamplingInterval([]time.Duration{500 * time.Millisecond, time.Second, 2 * time.Second}[index%3])
		}
	}()
	if err := engine.Stop(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("interval update did not finish during shutdown")
	}
}

func TestAcceleratedSoakKeepsHistoryBoundedAndShutsDown(t *testing.T) {
	provider := fake.New()
	engine := New(provider, time.Millisecond, 32*time.Millisecond)
	if err := provider.Open(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer provider.Close()
	start := time.Date(2026, 8, 29, 12, 0, 0, 0, time.UTC)
	for index := 0; index < 10_000; index++ {
		if err := engine.poll(context.Background(), start.Add(time.Duration(index)*time.Millisecond)); err != nil {
			t.Fatal(err)
		}
	}
	series := engine.History("MIG-fixture-0-0", nil, time.Hour, start.Add(10_000*time.Millisecond))
	if len(series.Points) > engine.history.Capacity() {
		t.Fatalf("history points=%d capacity=%d", len(series.Points), engine.history.Capacity())
	}

	baseline := runtime.NumGoroutine()
	for iteration := 0; iteration < 12; iteration++ {
		run := New(fake.New(), 2*time.Millisecond, 20*time.Millisecond)
		if err := run.Start(context.Background()); err != nil {
			t.Fatal(err)
		}
		time.Sleep(5 * time.Millisecond)
		if err := run.Stop(); err != nil {
			t.Fatal(err)
		}
	}
	runtime.GC()
	time.Sleep(20 * time.Millisecond)
	if growth := runtime.NumGoroutine() - baseline; growth > 4 {
		t.Fatalf("goroutine growth = %d", growth)
	}
}

func TestOneHourSoak(t *testing.T) {
	if os.Getenv("MIGLENS_SOAK") != "1" {
		t.Skip("set MIGLENS_SOAK=1 to run the one-hour wall-clock soak")
	}
	engine := New(fake.New(), 250*time.Millisecond, 30*time.Minute)
	if err := engine.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	baseline := runtime.NumGoroutine()
	timer := time.NewTimer(time.Hour)
	defer timer.Stop()
	<-timer.C
	if err := engine.Stop(); err != nil {
		t.Fatal(err)
	}
	if growth := runtime.NumGoroutine() - baseline; growth > 2 {
		t.Fatalf("goroutine growth after one hour = %d", growth)
	}
	if engine.history.Capacity() != int((30*time.Minute)/(250*time.Millisecond))+2 {
		t.Fatalf("history capacity changed: %d", engine.history.Capacity())
	}
}
