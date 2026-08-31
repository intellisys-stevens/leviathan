package collector

import (
	"testing"
	"time"

	"github.com/intellisys-stevens/leviathan/internal/history"
	"github.com/intellisys-stevens/leviathan/internal/model"
)

func TestGenerationChangesAfterTopologyReplacement(t *testing.T) {
	e := &Engine{generations: make(map[string]*generationState)}
	first := model.Snapshot{GPUs: []model.GPU{{GPUInstances: []model.GPUInstance{{ComputeInstances: []model.ComputeInstance{{UUID: "MIG-a"}}}}}}}
	e.applyGenerations(&first)
	initial := first.GPUs[0].GPUInstances[0].ComputeInstances[0].Generation
	empty := model.Snapshot{}
	e.applyGenerations(&empty)
	recreated := model.Snapshot{GPUs: []model.GPU{{GPUInstances: []model.GPUInstance{{ComputeInstances: []model.ComputeInstance{{UUID: "MIG-a"}}}}}}}
	e.applyGenerations(&recreated)
	if got := recreated.GPUs[0].GPUInstances[0].ComputeInstances[0].Generation; got == initial {
		t.Fatalf("recreated MIG device retained generation %q", got)
	}
}

func TestGenerationChangesWhenTopologyIsReplacedBetweenPolls(t *testing.T) {
	e := &Engine{generations: make(map[string]*generationState)}
	first := model.Snapshot{GPUs: []model.GPU{{GPUInstances: []model.GPUInstance{{
		UUID: "GI-a", ID: 1, Profile: "1g.24gb",
		ComputeInstances: []model.ComputeInstance{{UUID: "MIG-old", ID: 0, Profile: "1c.1g.24gb"}},
	}}}}}
	e.applyGenerations(&first)
	initial := first.GPUs[0].GPUInstances[0].Generation

	replaced := first
	replaced.GPUs = append([]model.GPU(nil), first.GPUs...)
	replaced.GPUs[0].GPUInstances = append([]model.GPUInstance(nil), first.GPUs[0].GPUInstances...)
	replaced.GPUs[0].GPUInstances[0].ComputeInstances = []model.ComputeInstance{{UUID: "MIG-new", ID: 0, Profile: "1c.1g.24gb"}}
	e.applyGenerations(&replaced)
	if got := replaced.GPUs[0].GPUInstances[0].Generation; got == initial {
		t.Fatalf("replacement between polls retained generation %q", got)
	}
}

func TestHistoryUsesCurrentGeneration(t *testing.T) {
	e := &Engine{history: historyForTest(), generations: make(map[string]*generationState)}
	at := time.Now()
	snapshot := model.Snapshot{SampledAt: at, GPUs: []model.GPU{{GPUInstances: []model.GPUInstance{{ComputeInstances: []model.ComputeInstance{{UUID: "MIG-a", Metrics: model.MetricSet{"sm_activity": model.AvailableMetric(50, "percent", model.SourceSynthetic, model.ScopeGPUInstance, at)}}}}}}}}
	e.applyGenerations(&snapshot)
	e.current.Store(&snapshot)
	e.history.Add(snapshot)
	if got := e.History("MIG-a", nil, time.Minute, at).Points; len(got) != 1 {
		t.Fatalf("expected one point, got %d", len(got))
	}
}

func TestGIHistoryStartsNewSeriesAfterRecreation(t *testing.T) {
	e := &Engine{history: historyForTest(), generations: make(map[string]*generationState)}
	at := time.Now().UTC()
	first := model.Snapshot{SampledAt: at, GPUs: []model.GPU{{GPUInstances: []model.GPUInstance{{UUID: "GI-a", Metrics: model.MetricSet{"sm_activity": model.AvailableMetric(25, "percent", model.SourceSynthetic, model.ScopeGPUInstance, at)}}}}}}
	e.applyGenerations(&first)
	e.current.Store(&first)
	e.history.Add(first)
	empty := model.Snapshot{SampledAt: at.Add(time.Second)}
	e.applyGenerations(&empty)
	recreatedAt := at.Add(2 * time.Second)
	recreated := model.Snapshot{SampledAt: recreatedAt, GPUs: []model.GPU{{GPUInstances: []model.GPUInstance{{UUID: "GI-a", Metrics: model.MetricSet{"sm_activity": model.AvailableMetric(75, "percent", model.SourceSynthetic, model.ScopeGPUInstance, recreatedAt)}}}}}}
	e.applyGenerations(&recreated)
	e.current.Store(&recreated)
	e.history.Add(recreated)
	points := e.History("GI-a", []string{"sm_activity"}, time.Minute, recreatedAt).Points
	if len(points) != 1 || points[0].Values["sm_activity"] != 75 {
		t.Fatalf("recreated GI history joined an old generation: %+v", points)
	}
}

func TestAlignedHistoryResolvesAllEntitiesAgainstCurrentGeneration(t *testing.T) {
	e := &Engine{history: historyForTest(), generations: make(map[string]*generationState)}
	base := time.Date(2026, 8, 30, 12, 0, 0, 0, time.UTC)
	first := model.Snapshot{Sequence: 1, SampledAt: base, GPUs: []model.GPU{{
		UUID: "GPU-a",
		GPUInstances: []model.GPUInstance{{
			UUID: "GI-a", Metrics: model.MetricSet{"sm_activity": model.AvailableMetric(25, "percent", model.SourceSynthetic, model.ScopeGPUInstance, base)},
		}},
	}}}
	e.applyGenerations(&first)
	e.history.Add(first)

	empty := model.Snapshot{Sequence: 2, SampledAt: base.Add(time.Second)}
	e.applyGenerations(&empty)
	e.history.Add(empty)

	recreatedAt := base.Add(2 * time.Second)
	recreated := model.Snapshot{Sequence: 3, SampledAt: recreatedAt, GPUs: []model.GPU{{
		UUID: "GPU-a",
		GPUInstances: []model.GPUInstance{{
			UUID: "GI-a", Metrics: model.MetricSet{"sm_activity": model.AvailableMetric(75, "percent", model.SourceSynthetic, model.ScopeGPUInstance, recreatedAt)},
		}},
	}}}
	e.applyGenerations(&recreated)
	e.current.Store(&recreated)
	e.history.Add(recreated)

	// Simulate a poll that has written a newer topology into history but has
	// not yet atomically published it as Current. The aligned read must use one
	// current topology/sample boundary rather than mixing generations.
	futureEmpty := model.Snapshot{Sequence: 4, SampledAt: base.Add(3 * time.Second)}
	e.applyGenerations(&futureEmpty)
	e.history.Add(futureEmpty)
	futureAt := base.Add(4 * time.Second)
	future := model.Snapshot{Sequence: 5, SampledAt: futureAt, GPUs: []model.GPU{{
		UUID: "GPU-a",
		GPUInstances: []model.GPUInstance{{
			UUID: "GI-a", Metrics: model.MetricSet{"sm_activity": model.AvailableMetric(95, "percent", model.SourceSynthetic, model.ScopeGPUInstance, futureAt)},
		}},
	}}}
	e.applyGenerations(&future)
	e.history.Add(future)

	descriptors := []history.SeriesDescriptor{{Key: "gi", Entity: "GI-a", Metrics: []string{"sm_activity"}}}
	got := e.AlignedHistory(descriptors, time.Minute, 50, futureAt)
	if len(got.Series) != 1 || got.Series[0].Entity != "GI-a" {
		t.Fatalf("response leaked internal generation key: %+v", got.Series)
	}
	if len(got.Points) != 3 {
		t.Fatalf("shared topology timeline = %d rows, want 3", len(got.Points))
	}
	for index := 0; index < 2; index++ {
		if _, exists := got.Points[index].Values["gi"]; exists {
			t.Fatalf("old generation leaked into row %d: %+v", index, got.Points[index].Values)
		}
	}
	if value := got.Points[2].Values["gi"]["sm_activity"]; value != 75 {
		t.Fatalf("current generation value = %v, want 75", value)
	}
}

func TestCapabilitiesReflectLatestWorkspaceSnapshot(t *testing.T) {
	e := &Engine{}
	snapshot := model.Snapshot{Capabilities: model.Capabilities{
		Proc: model.ProviderState{Name: "/proc", Available: true, Status: model.StatusAvailable, Message: "workspace namespace connected"},
	}}
	e.current.Store(&snapshot)

	got := e.Capabilities().Proc
	if !got.Available || got.Message != "workspace namespace connected" {
		t.Fatalf("capabilities did not use latest snapshot: %+v", got)
	}
}

func TestInactiveGenerationStateExpiresWithHistoryWindow(t *testing.T) {
	base := time.Date(2026, 8, 29, 12, 0, 0, 0, time.UTC)
	e := &Engine{generations: make(map[string]*generationState), window: time.Second}
	first := model.Snapshot{SampledAt: base, GPUs: []model.GPU{{GPUInstances: []model.GPUInstance{{UUID: "GI-old"}}}}}
	e.applyGenerations(&first)
	e.applyGenerations(&model.Snapshot{SampledAt: base.Add(2 * time.Second)})
	if len(e.generations) != 0 {
		t.Fatalf("expired generation state retained: %+v", e.generations)
	}
}

func TestStaleSnapshotKeepsEmptyProcessesNonNil(t *testing.T) {
	snapshot := model.Snapshot{Processes: []model.Process{}}
	stale := staleSnapshot(snapshot, time.Now().UTC(), "sample failed")
	if stale.Processes == nil {
		t.Fatal("stale snapshot changed an empty process list to nil")
	}
}
