package history

import (
	"fmt"
	"testing"
	"time"

	"github.com/intellisys-stevens/miglens/internal/model"
)

func TestBufferIsBoundedAndPreservesChronology(t *testing.T) {
	b := New(3*time.Second, time.Second)
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	for i := 0; i < 12; i++ {
		at := base.Add(time.Duration(i) * time.Second)
		b.Add(model.Snapshot{SampledAt: at, GPUs: []model.GPU{{UUID: "GPU-a", Metrics: model.MetricSet{"sm_activity": model.AvailableMetric(float64(i), "percent", model.SourceNVMLGPM, model.ScopePhysicalGPU, at)}}}})
	}
	got := b.Query("GPU-a", []string{"sm_activity"}, 30*time.Second, base.Add(12*time.Second))
	if len(got.Points) > b.Capacity() {
		t.Fatalf("history grew beyond capacity: %d > %d", len(got.Points), b.Capacity())
	}
	for i := 1; i < len(got.Points); i++ {
		if got.Points[i].SampledAt.Before(got.Points[i-1].SampledAt) {
			t.Fatal("points are out of order")
		}
	}
}

func TestPartiallyFilledRingReturnsItsPoints(t *testing.T) {
	b := New(time.Minute, time.Second)
	at := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	b.Add(model.Snapshot{SampledAt: at, GPUs: []model.GPU{{UUID: "GPU-a", Metrics: model.MetricSet{}}}})

	got := b.Query("GPU-a", nil, time.Minute, at)
	if len(got.Points) != 1 || !got.Points[0].SampledAt.Equal(at) {
		t.Fatalf("partially filled ring returned %+v", got.Points)
	}
}

func TestTopologyChurnDoesNotPreallocateFullRingPerEntity(t *testing.T) {
	b := New(30*time.Minute, 250*time.Millisecond)
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	for index := 0; index < 1_000; index++ {
		at := base.Add(time.Duration(index) * time.Millisecond)
		b.Add(model.Snapshot{SampledAt: at, GPUs: []model.GPU{{UUID: fmt.Sprintf("GPU-%d", index), Metrics: model.MetricSet{}}}})
	}
	totalCapacity := 0
	for _, series := range b.series {
		totalCapacity += cap(series.points)
	}
	if totalCapacity > 2_000 {
		t.Fatalf("topology churn preallocated %d point slots for sparse series", totalCapacity)
	}
	// Once the retention window passes, inactive UUID series are removed.
	b.Add(model.Snapshot{SampledAt: base.Add(31 * time.Minute), GPUs: []model.GPU{{UUID: "GPU-current", Metrics: model.MetricSet{}}}})
	if len(b.series) != 1 {
		t.Fatalf("inactive series retained: %d", len(b.series))
	}
}

func TestEnsureCapacityGrowsWithoutLosingChronology(t *testing.T) {
	b := New(4*time.Second, time.Second)
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	for index := 0; index < 8; index++ {
		at := base.Add(time.Duration(index) * time.Second)
		b.Add(model.Snapshot{SampledAt: at, GPUs: []model.GPU{{UUID: "GPU-a", Metrics: model.MetricSet{"sm_activity": model.AvailableMetric(float64(index), "percent", model.SourceSynthetic, model.ScopePhysicalGPU, at)}}}})
	}
	before := b.Query("GPU-a", nil, time.Minute, base.Add(8*time.Second)).Points
	oldCapacity := b.Capacity()
	b.EnsureCapacity(500 * time.Millisecond)
	if b.Capacity() <= oldCapacity {
		t.Fatalf("capacity did not grow: %d -> %d", oldCapacity, b.Capacity())
	}
	after := b.Query("GPU-a", nil, time.Minute, base.Add(8*time.Second)).Points
	if len(after) != len(before) {
		t.Fatalf("points changed while growing: %d -> %d", len(before), len(after))
	}
	for index := range after {
		if !after[index].SampledAt.Equal(before[index].SampledAt) {
			t.Fatalf("chronology changed at %d: %s != %s", index, after[index].SampledAt, before[index].SampledAt)
		}
	}
	b.EnsureCapacity(2 * time.Second)
	if b.Capacity() <= oldCapacity {
		t.Fatalf("capacity shrank after slower cadence: %d", b.Capacity())
	}
}
