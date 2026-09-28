package history

import (
	"sync"
	"testing"
	"time"

	"github.com/intellisys-stevens/leviathan/model"
)

func TestQueriesDoNotExposeStoredMetricMaps(t *testing.T) {
	at := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	b := New(12*time.Hour, time.Second)
	b.AddGPU(historySnapshot(at, 1, map[string]*float64{"GPU-a": model.Float(25)}))
	for _, window := range []time.Duration{time.Minute, 4 * time.Hour} {
		for _, metrics := range [][]string{nil, {"sm_activity"}} {
			query := b.Query("GPU-a", metrics, window, at)
			query.Points[0].Values["sm_activity"] = 999
			query.Points[0].Values["injected"] = 1
			again := b.Query("GPU-a", nil, window, at)
			if again.Points[0].Values["sm_activity"] != 25 || len(again.Points[0].Values) != 1 {
				t.Fatalf("caller mutated stored history: %+v", again)
			}
			aligned := b.QueryAligned([]SeriesDescriptor{{Key: "gpu", Entity: "GPU-a", Metrics: metrics}}, window, 1, at)
			aligned.Points[0].Values["gpu"]["sm_activity"] = 999
			again = b.Query("GPU-a", nil, window, at)
			if again.Points[0].Values["sm_activity"] != 25 {
				t.Fatalf("aligned result exposed stored values: %+v", again)
			}
		}
	}
}

func TestQueriesOrderDelayedSamplesAndKeepLatestDuplicate(t *testing.T) {
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	b := New(time.Minute, time.Second)
	for index, second := range []int{2, 0, 1, 1} {
		b.AddGPU(historySnapshot(base.Add(time.Duration(second)*time.Second), uint64(index+1), map[string]*float64{"GPU-a": model.Float(float64(index))}))
	}
	query := b.Query("GPU-a", nil, time.Minute, base.Add(3*time.Second))
	if len(query.Points) != 4 {
		t.Fatalf("raw samples lost: %+v", query.Points)
	}
	for index, expected := range []float64{1, 2, 3, 0} {
		if query.Points[index].Values["sm_activity"] != expected {
			t.Fatalf("sample order changed: %+v", query.Points)
		}
	}
	aligned := b.QueryAligned([]SeriesDescriptor{{Key: "gpu", Entity: "GPU-a"}}, time.Minute, 100, base.Add(3*time.Second))
	for _, point := range aligned.Points {
		if point.SampledAt.Equal(base.Add(time.Second)) && point.Values["gpu"]["sm_activity"] != 3 {
			t.Fatalf("duplicate timestamp did not keep the latest observation: %+v", point)
		}
	}
}

func TestPluginFilesystemUsesSystemTimelineWithoutNameConvention(t *testing.T) {
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	for _, status := range []model.MetricStatus{model.StatusAvailable, model.StatusPermissionDenied} {
		b := New(12*time.Hour, 30*time.Second)
		for index := range 2 {
			at := base.Add(time.Duration(index) * 30 * time.Second)
			system := availableHistorySystem(at)
			system.Storage.Filesystems = []model.Filesystem{{ID: "example/local-disk", Status: status, UsedBytes: model.Uint64(uint64(index + 10))}}
			b.AddSystem(model.Snapshot{SampledAt: at, System: system})
			b.AddGPU(model.Snapshot{SampledAt: at.Add(time.Second)})
		}
		for _, window := range []time.Duration{time.Minute, 4 * time.Hour} {
			query := b.QueryAligned([]SeriesDescriptor{{Key: "disk", Entity: "example/local-disk"}}, window, 100, base.Add(59*time.Second))
			if len(query.Points) != 2 || !query.Points[0].SampledAt.Equal(base) {
				t.Fatalf("filesystem selected GPU timestamps: %+v", query.Points)
			}
			if status == model.StatusAvailable && query.Points[1].Values["disk"]["storage_used_bytes"] != 11 {
				t.Fatalf("filesystem values lost: %+v", query.Points)
			}
			if status != model.StatusAvailable && len(query.Points[1].Values["disk"]) != 0 {
				t.Fatalf("unavailable filesystem acquired values: %+v", query.Points)
			}
		}
		b.AddGPU(model.Snapshot{SampledAt: base.Add(13 * time.Hour)})
		if _, retained := b.domains["example/local-disk"]; retained {
			t.Fatal("expired filesystem domain retained after all history expired")
		}
	}
}

func TestQueriesStayIndependentDuringWritesAndCapacityGrowth(t *testing.T) {
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	b := New(12*time.Hour, time.Second)
	b.AddGPU(historySnapshot(base, 1, map[string]*float64{"GPU-a": model.Float(25)}))
	var workers sync.WaitGroup
	workers.Add(3)
	go func() {
		defer workers.Done()
		for index := range 100 {
			at := base.Add(time.Duration(index) * time.Second)
			b.AddGPU(historySnapshot(at, uint64(index+1), map[string]*float64{"GPU-a": model.Float(25)}))
			b.EnsureCapacity(250 * time.Millisecond)
		}
	}()
	for _, window := range []time.Duration{time.Minute, 4 * time.Hour} {
		go func() {
			defer workers.Done()
			for range 100 {
				query := b.Query("GPU-a", nil, window, base.Add(100*time.Second))
				for _, point := range query.Points {
					if value, ok := point.Values["sm_activity"]; ok && value != 25 {
						t.Errorf("concurrent query changed stored measurement: %v", point)
					}
					point.Values["sm_activity"] = 999
				}
				_ = b.QueryAligned([]SeriesDescriptor{{Key: "gpu", Entity: "GPU-a"}}, window, 100, base.Add(100*time.Second))
			}
		}()
	}
	workers.Wait()
}

func TestPhysicalGPUGenerationKeepsOldMeasurementsSeparate(t *testing.T) {
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	b := New(12*time.Hour, 30*time.Second)
	for index, generation := range []string{"example/GPU-a@g1", "example/GPU-a@g2"} {
		at := base.Add(time.Duration(index) * 30 * time.Second)
		snapshot := historySnapshot(at, uint64(index+1), map[string]*float64{"example/GPU-a": model.Float(float64(index + 10))})
		snapshot.GPUs[0].Generation = generation
		b.AddGPU(snapshot)
	}
	for _, window := range []time.Duration{time.Minute, 4 * time.Hour} {
		query := b.Query("example/GPU-a@g2", nil, window, base.Add(59*time.Second))
		if len(query.Points) != 1 || query.Points[0].Values["sm_activity"] != 11 {
			t.Fatalf("physical GPU generation mixed old readings: %+v", query)
		}
	}
}
