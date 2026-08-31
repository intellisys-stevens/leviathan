package history

import (
	"fmt"
	"reflect"
	"testing"
	"time"

	"github.com/intellisys-stevens/leviathan/internal/model"
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

func TestLimitPreservesExtremaAndStrictCap(t *testing.T) {
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	series := Series{Entity: "GPU-a", Metrics: []string{"sm", "dram"}, Window: "1m", Points: make([]Point, 100)}
	for index := range series.Points {
		series.Points[index] = Point{
			SampledAt: base.Add(time.Duration(index) * time.Second),
			Values: map[string]float64{
				"sm":   float64(index % 10),
				"dram": float64(100 - index),
			},
		}
	}
	series.Points[45].Values["sm"] = 999
	series.Points[64].Values["dram"] = -999

	limited := Limit(series, 24)
	if len(limited.Points) > 24 {
		t.Fatalf("limited points = %d, want <= 24", len(limited.Points))
	}
	if !limited.Points[0].SampledAt.Equal(series.Points[0].SampledAt) ||
		!limited.Points[len(limited.Points)-1].SampledAt.Equal(series.Points[len(series.Points)-1].SampledAt) {
		t.Fatal("limit did not preserve endpoints")
	}
	foundMaximum, foundMinimum := false, false
	for index, point := range limited.Points {
		if index > 0 && point.SampledAt.Before(limited.Points[index-1].SampledAt) {
			t.Fatal("limited points are not chronological")
		}
		foundMaximum = foundMaximum || point.Values["sm"] == 999
		foundMinimum = foundMinimum || point.Values["dram"] == -999
	}
	if !foundMaximum || !foundMinimum {
		t.Fatalf("extrema were dropped: max=%t min=%t", foundMaximum, foundMinimum)
	}
	if len(series.Points) != 100 {
		t.Fatal("Limit mutated the input series")
	}
}

func TestLimitDerivesMetricsAndHandlesTinyBudgets(t *testing.T) {
	points := make([]Point, 12)
	for index := range points {
		points[index] = Point{SampledAt: time.Unix(int64(index), 0), Values: map[string]float64{"value": float64(index)}}
	}
	series := Series{Points: points}
	if got := len(Limit(series, 5).Points); got != 5 {
		t.Fatalf("derived-metric limit = %d, want 5", got)
	}
	if got := len(Limit(series, 1).Points); got != 1 {
		t.Fatalf("tiny limit = %d, want 1", got)
	}
}

func TestQueryAlignedUsesOneStoredTimestampSetWithoutInventingValues(t *testing.T) {
	buffer := New(time.Minute, time.Second)
	base := time.Date(2026, 8, 30, 12, 0, 0, 0, time.UTC)
	buffer.Add(historySnapshot(base, 1, map[string]*float64{"GPU-a": floatPointer(10), "GPU-b": floatPointer(20)}))
	buffer.Add(historySnapshot(base.Add(time.Second), 2, map[string]*float64{"GPU-a": floatPointer(11)}))
	buffer.Add(historySnapshot(base.Add(2*time.Second), 3, map[string]*float64{"GPU-a": nil, "GPU-b": floatPointer(22)}))
	buffer.AddGap(base.Add(3 * time.Second))
	buffer.Add(historySnapshot(base.Add(4*time.Second), 5, map[string]*float64{"GPU-a": floatPointer(14), "GPU-b": floatPointer(24)}))

	got := buffer.QueryAligned([]SeriesDescriptor{
		{Key: "a", Entity: "GPU-a", Metrics: []string{"sm_activity"}},
		{Key: "b", Entity: "GPU-b", Metrics: []string{"sm_activity"}},
	}, time.Minute, 50, base.Add(4*time.Second))
	if len(got.Points) != 5 {
		t.Fatalf("aligned rows = %d, want 5: %+v", len(got.Points), got.Points)
	}
	for index, point := range got.Points {
		want := base.Add(time.Duration(index) * time.Second)
		if !point.SampledAt.Equal(want) {
			t.Fatalf("row %d timestamp = %s, want %s", index, point.SampledAt, want)
		}
	}
	if _, exists := got.Points[1].Values["b"]; exists {
		t.Fatalf("missing entity was invented at row 1: %+v", got.Points[1].Values)
	}
	if values, exists := got.Points[2].Values["a"]; !exists || len(values) != 0 {
		t.Fatalf("explicit unavailable sample = %+v, want present empty series map", got.Points[2].Values)
	}
	if len(got.Points[3].Values) != 0 {
		t.Fatalf("collector gap contains invented values: %+v", got.Points[3].Values)
	}
	if got.Points[4].Values["a"]["sm_activity"] != 14 || got.Points[4].Values["b"]["sm_activity"] != 24 {
		t.Fatalf("final stored values changed: %+v", got.Points[4].Values)
	}
}

func TestQueryAlignedLimitPreservesTransitionsGapsAndPerSeriesExtrema(t *testing.T) {
	buffer := New(5*time.Minute, time.Second)
	base := time.Date(2026, 8, 30, 12, 0, 0, 0, time.UTC)
	for index := 0; index < 200; index++ {
		at := base.Add(time.Duration(index) * time.Second)
		if index == 100 {
			buffer.AddGap(at)
			continue
		}
		a, b := float64(index%13), float64(100-index%17)
		if index == 80 {
			a = 999
		}
		if index == 130 {
			b = -999
		}
		values := map[string]*float64{"GPU-a": &a, "GPU-b": &b}
		if index == 50 {
			values["GPU-a"] = nil
		}
		buffer.Add(historySnapshot(at, uint64(index+1), values))
	}
	descriptors := []SeriesDescriptor{
		{Key: "a", Entity: "GPU-a", Metrics: []string{"sm_activity"}},
		{Key: "b", Entity: "GPU-b", Metrics: []string{"sm_activity"}},
	}
	first := buffer.QueryAligned(descriptors, 5*time.Minute, 50, base.Add(199*time.Second))
	second := buffer.QueryAligned(descriptors, 5*time.Minute, 50, base.Add(199*time.Second))
	if len(first.Points) != 50 {
		t.Fatalf("aligned cap = %d, want exactly 50", len(first.Points))
	}
	if !reflect.DeepEqual(first, second) {
		t.Fatal("aligned limiting is not deterministic")
	}
	if !first.Points[0].SampledAt.Equal(base) || !first.Points[len(first.Points)-1].SampledAt.Equal(base.Add(199*time.Second)) {
		t.Fatal("aligned limiter dropped an endpoint")
	}
	wantedTimes := map[time.Time]bool{
		base.Add(49 * time.Second):  false,
		base.Add(50 * time.Second):  false,
		base.Add(51 * time.Second):  false,
		base.Add(99 * time.Second):  false,
		base.Add(100 * time.Second): false,
		base.Add(101 * time.Second): false,
	}
	foundMaximum, foundMinimum := false, false
	for _, point := range first.Points {
		if _, wanted := wantedTimes[point.SampledAt]; wanted {
			wantedTimes[point.SampledAt] = true
		}
		foundMaximum = foundMaximum || point.Values["a"]["sm_activity"] == 999
		foundMinimum = foundMinimum || point.Values["b"]["sm_activity"] == -999
	}
	for at, found := range wantedTimes {
		if !found {
			t.Errorf("availability/gap edge at %s was dropped", at)
		}
	}
	if !foundMaximum || !foundMinimum {
		t.Fatalf("per-series extrema were dropped: max=%t min=%t", foundMaximum, foundMinimum)
	}
}

func TestAlignedGapRowsDoNotChangeLegacyHistory(t *testing.T) {
	buffer := New(time.Minute, time.Second)
	base := time.Date(2026, 8, 30, 12, 0, 0, 0, time.UTC)
	buffer.Add(historySnapshot(base, 1, map[string]*float64{"GPU-a": floatPointer(1)}))
	buffer.AddGap(base.Add(time.Second))
	buffer.Add(historySnapshot(base.Add(2*time.Second), 3, map[string]*float64{"GPU-a": floatPointer(2)}))

	legacy := buffer.Query("GPU-a", []string{"sm_activity"}, time.Minute, base.Add(2*time.Second))
	if len(legacy.Points) != 2 || legacy.Points[0].Values["sm_activity"] != 1 || legacy.Points[1].Values["sm_activity"] != 2 {
		t.Fatalf("legacy history changed after aligned gap tracking: %+v", legacy)
	}
	aligned := buffer.QueryAligned([]SeriesDescriptor{{Key: "a", Entity: "GPU-a", Metrics: []string{"sm_activity"}}}, time.Minute, 50, base.Add(2*time.Second))
	if len(aligned.Points) != 3 || len(aligned.Points[1].Values) != 0 {
		t.Fatalf("aligned gap row missing: %+v", aligned.Points)
	}
}

func historySnapshot(at time.Time, sequence uint64, values map[string]*float64) model.Snapshot {
	gpus := make([]model.GPU, 0, len(values))
	for uuid, value := range values {
		metric := model.Metric{Status: model.StatusStale}
		if value != nil {
			metric = model.AvailableMetric(*value, "percent", model.SourceSynthetic, model.ScopePhysicalGPU, at)
		}
		gpus = append(gpus, model.GPU{UUID: uuid, Metrics: model.MetricSet{"sm_activity": metric}})
	}
	return model.Snapshot{Sequence: sequence, SampledAt: at, GPUs: gpus}
}

func floatPointer(value float64) *float64 {
	return &value
}
