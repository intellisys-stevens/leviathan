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

func TestTieredHistoryCapacityIsBoundedIndependentlyOfCadence(t *testing.T) {
	buffer := New(12*time.Hour, time.Second)
	if got, want := buffer.Capacity(), int(time.Hour/time.Second)+2; got != want {
		t.Fatalf("raw capacity = %d, want %d", got, want)
	}
	if got, want := buffer.AggregateCapacity(), int(12*time.Hour/(30*time.Second))+2; got != want {
		t.Fatalf("aggregate capacity = %d, want %d", got, want)
	}
	aggregateCapacity := buffer.AggregateCapacity()
	buffer.EnsureCapacity(500 * time.Millisecond)
	if got, want := buffer.Capacity(), int(time.Hour/(500*time.Millisecond))+2; got != want {
		t.Fatalf("faster raw capacity = %d, want %d", got, want)
	}
	if got := buffer.AggregateCapacity(); got != aggregateCapacity {
		t.Fatalf("aggregate capacity changed with cadence: %d -> %d", aggregateCapacity, got)
	}
}

func TestFourHourHistoryUsesEpochAlignedThirtySecondMeans(t *testing.T) {
	buffer := New(12*time.Hour, 10*time.Second)
	base := time.Date(2026, 8, 30, 12, 0, 0, 0, time.UTC)
	values := []float64{10, 20, 30, 40, 50, 60}
	for index, value := range values {
		buffer.Add(historySnapshot(base.Add(time.Duration(index)*10*time.Second), uint64(index+1), map[string]*float64{"GPU-a": floatPointer(value)}))
	}

	series := buffer.Query("GPU-a", []string{"sm_activity"}, 4*time.Hour, base.Add(59*time.Second))
	if len(series.Points) != 2 {
		t.Fatalf("four-hour aggregate rows = %d, want 2: %+v", len(series.Points), series.Points)
	}
	if !series.Points[0].SampledAt.Equal(base) || !series.Points[1].SampledAt.Equal(base.Add(30*time.Second)) {
		t.Fatalf("aggregate buckets are not epoch aligned: %+v", series.Points)
	}
	if got := series.Points[0].Values["sm_activity"]; got != 20 {
		t.Fatalf("first aggregate mean = %v, want 20", got)
	}
	if got := series.Points[1].Values["sm_activity"]; got != 50 {
		t.Fatalf("second aggregate mean = %v, want 50", got)
	}
}

func TestTwelveHourHistoryUsesWeightedTwoMinuteRollups(t *testing.T) {
	buffer := New(12*time.Hour, 10*time.Second)
	base := time.Date(2026, 8, 30, 12, 0, 0, 0, time.UTC)
	for index := 1; index <= 11; index++ {
		value := float64(index * 10)
		buffer.Add(historySnapshot(base.Add(time.Duration(index)*10*time.Second), uint64(index), map[string]*float64{"GPU-a": floatPointer(value)}))
	}

	series := buffer.Query("GPU-a", []string{"sm_activity"}, 12*time.Hour, base.Add(119*time.Second))
	if len(series.Points) != 1 {
		t.Fatalf("twelve-hour aggregate rows = %d, want 1: %+v", len(series.Points), series.Points)
	}
	if !series.Points[0].SampledAt.Equal(base) {
		t.Fatalf("rollup start = %s, want %s", series.Points[0].SampledAt, base)
	}
	if got, want := series.Points[0].Values["sm_activity"], 60.0; got != want {
		t.Fatalf("weighted rollup mean = %v, want %v", got, want)
	}
}

func TestLongHistoryPreservesMissingMetricsAndExplicitGaps(t *testing.T) {
	buffer := New(12*time.Hour, 10*time.Second)
	base := time.Date(2026, 8, 30, 12, 0, 0, 0, time.UTC)
	buffer.Add(historySnapshot(base, 1, map[string]*float64{"GPU-a": floatPointer(10)}))
	buffer.Add(historySnapshot(base.Add(10*time.Second), 2, map[string]*float64{"GPU-a": nil}))
	buffer.AddGap(base.Add(30 * time.Second))
	buffer.Add(historySnapshot(base.Add(40*time.Second), 4, map[string]*float64{"GPU-a": floatPointer(40)}))
	buffer.Add(historySnapshot(base.Add(50*time.Second), 5, map[string]*float64{"GPU-a": floatPointer(40)}))
	buffer.Add(historySnapshot(base.Add(60*time.Second), 6, map[string]*float64{"GPU-a": floatPointer(40)}))

	series := buffer.Query("GPU-a", []string{"sm_activity"}, 4*time.Hour, base.Add(89*time.Second))
	if len(series.Points) != 3 {
		t.Fatalf("aggregate rows = %d, want 3: %+v", len(series.Points), series.Points)
	}
	if len(series.Points[0].Values) != 0 {
		t.Fatalf("partially unavailable metric was averaged: %+v", series.Points[0])
	}
	if len(series.Points[1].Values) != 0 {
		t.Fatalf("explicit gap was bridged: %+v", series.Points[1])
	}
	if got := series.Points[2].Values["sm_activity"]; got != 40 {
		t.Fatalf("post-gap value = %v, want 40", got)
	}
}

func TestLongHistoryKeepsTopologyGenerationsSeparated(t *testing.T) {
	buffer := New(12*time.Hour, 30*time.Second)
	base := time.Date(2026, 8, 30, 12, 0, 0, 0, time.UTC)
	addGI := func(at time.Time, sequence uint64, generation string, value float64) {
		buffer.Add(model.Snapshot{
			SampledAt: at,
			Sequence:  sequence,
			GPUs: []model.GPU{{
				UUID: "GPU-a",
				GPUInstances: []model.GPUInstance{{
					UUID:       "GI-a",
					Generation: generation,
					Metrics: model.MetricSet{
						"sm_activity": model.AvailableMetric(value, "percent", model.SourceSynthetic, model.ScopeGPUInstance, at),
					},
				}},
			}},
		})
	}
	addGI(base, 1, "GI-a@g1", 10)
	addGI(base.Add(30*time.Second), 2, "GI-a@g1", 20)
	addGI(base.Add(60*time.Second), 3, "GI-a@g2", 90)

	got := buffer.QueryAligned([]SeriesDescriptor{{
		Key: "current", Entity: "GI-a@g2", Metrics: []string{"sm_activity"},
	}}, 4*time.Hour, 480, base.Add(89*time.Second))
	if len(got.Points) != 3 {
		t.Fatalf("aligned generation rows = %d, want 3: %+v", len(got.Points), got.Points)
	}
	for index := 0; index < 2; index++ {
		if _, exists := got.Points[index].Values["current"]; exists {
			t.Fatalf("old generation leaked into row %d: %+v", index, got.Points[index])
		}
	}
	if value := got.Points[2].Values["current"]["sm_activity"]; value != 90 {
		t.Fatalf("current generation value = %v, want 90", value)
	}
}

func TestClosedAggregateBucketsRemainImmutable(t *testing.T) {
	buffer := New(12*time.Hour, 20*time.Second)
	base := time.Date(2026, 8, 30, 12, 0, 0, 0, time.UTC)
	buffer.Add(historySnapshot(base, 1, map[string]*float64{"GPU-a": floatPointer(10)}))
	buffer.Add(historySnapshot(base.Add(20*time.Second), 2, map[string]*float64{"GPU-a": floatPointer(30)}))
	buffer.Add(historySnapshot(base.Add(35*time.Second), 3, map[string]*float64{"GPU-a": floatPointer(40)}))
	before := buffer.Query("GPU-a", []string{"sm_activity"}, 4*time.Hour, base.Add(40*time.Second))
	buffer.Add(historySnapshot(base.Add(55*time.Second), 4, map[string]*float64{"GPU-a": floatPointer(80)}))
	after := buffer.Query("GPU-a", []string{"sm_activity"}, 4*time.Hour, base.Add(55*time.Second))
	if len(before.Points) < 1 || len(after.Points) < 1 || !reflect.DeepEqual(before.Points[0], after.Points[0]) {
		t.Fatalf("closed bucket changed: before=%+v after=%+v", before.Points, after.Points)
	}
	if got := after.Points[1].Values["sm_activity"]; got != 60 {
		t.Fatalf("partial bucket mean = %v, want 60", got)
	}
}

func TestLongAlignedHistoryStaysWithinPresetPointBudgets(t *testing.T) {
	buffer := New(12*time.Hour, 30*time.Second)
	base := time.Date(2026, 8, 30, 0, 0, 0, 0, time.UTC)
	for index := 0; index < int(12*time.Hour/(30*time.Second)); index++ {
		at := base.Add(time.Duration(index) * 30 * time.Second)
		buffer.Add(historySnapshot(at, uint64(index+1), map[string]*float64{"GPU-a": floatPointer(float64(index))}))
	}
	descriptors := []SeriesDescriptor{{Key: "gpu", Entity: "GPU-a", Metrics: []string{"sm_activity"}}}
	fourHours := buffer.QueryAligned(descriptors, 4*time.Hour, 720, base.Add(12*time.Hour-time.Second))
	if len(fourHours.Points) > 480 {
		t.Fatalf("4h returned %d points, want <= 480", len(fourHours.Points))
	}
	twelveHours := buffer.QueryAligned(descriptors, 12*time.Hour, 720, base.Add(12*time.Hour-time.Second))
	if len(twelveHours.Points) > 360 {
		t.Fatalf("12h returned %d points, want <= 360", len(twelveHours.Points))
	}
}

func TestSystemAndFilesystemHistoryAreFirstClassEntities(t *testing.T) {
	buffer := New(time.Hour, time.Second)
	at := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	total, used, available := uint64(1000), uint64(400), uint64(600)
	estimated := model.StatusEstimated
	buffer.AddSystem(model.Snapshot{
		Sequence: 1, SampledAt: at,
		System: model.System{
			CPU: model.CPU{
				Utilization: model.AvailableMetric(37, "percent", model.SourceProcFS, model.ScopeHost, at),
				Load1:       model.AvailableMetric(1.5, "load", model.SourceProcFS, model.ScopeHost, at),
			},
			Memory: model.SystemMemory{
				TotalBytes: &total, UsedBytes: &used, AvailableBytes: &available,
				Utilization: model.Metric{Value: model.Float(40), Status: estimated}, Status: estimated,
			},
			Storage: model.Storage{
				TotalBytes: &total, UsedBytes: &used, AvailableBytes: &available, Status: model.StatusAvailable,
				ReadBytesPerSecond: model.AvailableMetric(512, "bytes_per_second", model.SourceProcFS, model.ScopeHost, at),
				Filesystems:        []model.Filesystem{{ID: "fs_opaque", TotalBytes: &total, UsedBytes: &used, AvailableBytes: &available, Status: model.StatusAvailable}},
			},
		},
	})
	host := buffer.Query("@host", nil, time.Minute, at)
	if len(host.Points) != 1 || host.Points[0].Values["cpu_utilization"] != 37 || host.Points[0].Values["memory_used_bytes"] != 400 || host.Points[0].Values["memory_utilization"] != 40 || host.Points[0].Values["disk_read_bytes_per_second"] != 512 {
		t.Fatalf("host history = %+v", host)
	}
	filesystem := buffer.Query("fs_opaque", nil, time.Minute, at)
	if len(filesystem.Points) != 1 || filesystem.Points[0].Values["storage_used_bytes"] != 400 {
		t.Fatalf("filesystem history = %+v", filesystem)
	}
	aligned := buffer.QueryAligned([]SeriesDescriptor{
		{Key: "host", Entity: "@host", Metrics: []string{"cpu_utilization"}},
		{Key: "filesystem", Entity: "fs_opaque", Metrics: []string{"storage_used_bytes"}},
	}, time.Minute, 50, at)
	if len(aligned.Points) != 1 || aligned.Points[0].Values["host"]["cpu_utilization"] != 37 || aligned.Points[0].Values["filesystem"]["storage_used_bytes"] != 400 {
		t.Fatalf("aligned system history = %+v", aligned)
	}
}

func TestIndependentDomainPublicationDoesNotCarryOldValuesForward(t *testing.T) {
	buffer := New(time.Minute, time.Second)
	base := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	system := availableHistorySystem(base)
	gpuMetric := model.AvailableMetric(42, "percent", model.SourceNVML, model.ScopePhysicalGPU, base)
	buffer.AddGPU(model.Snapshot{
		Sequence: 1, SampledAt: base, System: system,
		GPUs: []model.GPU{{UUID: "GPU-a", Metrics: model.MetricSet{"gpu_activity": gpuMetric}}},
	})

	systemAt := base.Add(time.Second)
	system = availableHistorySystem(systemAt)
	buffer.AddSystem(model.Snapshot{
		Sequence: 2, SampledAt: systemAt, System: system,
		GPUs: []model.GPU{{UUID: "GPU-a", Metrics: model.MetricSet{"gpu_activity": gpuMetric}}},
	})
	if points := buffer.Query("GPU-a", nil, time.Minute, systemAt).Points; len(points) != 1 {
		t.Fatalf("system-only publication carried GPU values forward: %+v", points)
	}

	gpuAt := systemAt.Add(time.Second)
	gpuMetric = model.AvailableMetric(55, "percent", model.SourceNVML, model.ScopePhysicalGPU, gpuAt)
	buffer.AddGPU(model.Snapshot{
		Sequence: 3, SampledAt: gpuAt, System: system,
		GPUs: []model.GPU{{UUID: "GPU-a", Metrics: model.MetricSet{"gpu_activity": gpuMetric}}},
	})
	if points := buffer.Query("@host", nil, time.Minute, gpuAt).Points; len(points) != 1 {
		t.Fatalf("GPU-only publication carried host values forward: %+v", points)
	}
}

func TestIndependentDomainTimelinesPreserveRawAndLongRangeHistory(t *testing.T) {
	buffer := New(12*time.Hour, 10*time.Second)
	base := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	for index := 0; index < 6; index++ {
		systemAt := base.Add(time.Duration(index) * 10 * time.Second)
		system := availableHistorySystem(systemAt)
		system.CPU.Utilization = model.AvailableMetric(float64((index+1)*10), "percent", model.SourceProcFS, model.ScopeHost, systemAt)
		buffer.AddSystem(model.Snapshot{Sequence: uint64(index*2 + 1), SampledAt: systemAt, System: system})

		gpuAt := systemAt.Add(time.Second)
		value := float64(100 + index*10)
		buffer.AddGPU(historySnapshot(gpuAt, uint64(index*2+2), map[string]*float64{"GPU-a": &value}))
	}
	now := base.Add(59 * time.Second)
	host := buffer.Query("@host", []string{"cpu_utilization"}, 4*time.Hour, now)
	gpu := buffer.Query("GPU-a", []string{"sm_activity"}, 4*time.Hour, now)
	if len(host.Points) != 2 || host.Points[0].Values["cpu_utilization"] != 20 || host.Points[1].Values["cpu_utilization"] != 50 {
		t.Fatalf("long-range host history = %+v", host)
	}
	if len(gpu.Points) != 2 || gpu.Points[0].Values["sm_activity"] != 110 || gpu.Points[1].Values["sm_activity"] != 140 {
		t.Fatalf("long-range GPU history contains false cross-domain gaps: %+v", gpu)
	}

	raw := buffer.QueryAligned([]SeriesDescriptor{
		{Key: "host", Entity: "@host", Metrics: []string{"cpu_utilization"}},
		{Key: "gpu", Entity: "GPU-a", Metrics: []string{"sm_activity"}},
	}, 30*time.Minute, 50, now)
	if len(raw.Points) != 12 || len(raw.Points[0].Values["host"]) != 1 || len(raw.Points[0].Values["gpu"]) != 0 || len(raw.Points[1].Values["gpu"]) != 1 || len(raw.Points[1].Values["host"]) != 0 {
		t.Fatalf("mixed raw domain alignment carried values or dropped timestamps: %+v", raw.Points)
	}
	long := buffer.QueryAligned([]SeriesDescriptor{
		{Key: "host", Entity: "@host", Metrics: []string{"cpu_utilization"}},
		{Key: "gpu", Entity: "GPU-a", Metrics: []string{"sm_activity"}},
	}, 4*time.Hour, 50, now)
	if len(long.Points) != 2 || long.Points[0].Values["host"]["cpu_utilization"] != 20 || long.Points[0].Values["gpu"]["sm_activity"] != 110 {
		t.Fatalf("mixed long-range alignment = %+v", long.Points)
	}

	cpuOnly := New(12*time.Hour, 10*time.Second)
	for index := 0; index < 6; index++ {
		at := base.Add(time.Duration(index) * 10 * time.Second)
		cpuOnly.AddSystem(model.Snapshot{Sequence: uint64(index + 1), SampledAt: at, System: availableHistorySystem(at)})
	}
	if points := cpuOnly.Query("@host", []string{"cpu_utilization"}, 4*time.Hour, now).Points; len(points) != 2 {
		t.Fatalf("CPU-only long-range history needs no GPU timeline: %+v", points)
	}
}

func availableHistorySystem(at time.Time) model.System {
	total, used, available := uint64(100), uint64(40), uint64(60)
	return model.System{
		CPU: model.CPU{Utilization: model.AvailableMetric(40, "percent", model.SourceProcFS, model.ScopeHost, at)},
		Memory: model.SystemMemory{
			TotalBytes: &total, UsedBytes: &used, AvailableBytes: &available,
			Utilization: model.AvailableMetric(40, "percent", model.SourceProcFS, model.ScopeHost, at), Status: model.StatusAvailable,
		},
		Storage:   model.Storage{TotalBytes: &total, UsedBytes: &used, AvailableBytes: &available, Status: model.StatusAvailable},
		SampledAt: at, Status: model.StatusAvailable,
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
