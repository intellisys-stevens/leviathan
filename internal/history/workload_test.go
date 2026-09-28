package history

import (
	"fmt"
	"testing"
	"time"

	"github.com/intellisys-stevens/leviathan/model"
)

func ownerSnapshot(at time.Time, ref string, value *float64) model.Snapshot {
	metric := model.Metric{Value: value, Unit: "cores", Source: model.SourceCgroupFS, Scope: model.ScopeWorkloadOwner, SampledAt: at, Status: model.StatusAvailable}
	if value == nil {
		metric.Status = model.StatusError
	}
	return model.Snapshot{SampledAt: at, WorkloadTelemetry: &model.WorkloadTelemetry{SampledAt: at, Owners: []model.WorkloadOwnerTelemetry{{Ref: ref, SampledAt: at, Metrics: model.MetricSet{"cpu_cores": metric}}}}}
}
func TestWorkloadHistoryIndependentTimestampsGapsAndNoCarriedSamples(t *testing.T) {
	b := New(time.Hour, time.Second)
	at := time.Now().UTC()
	b.AddWorkload(ownerSnapshot(at, "one", model.Float(2)))
	b.AddGPU(model.Snapshot{SampledAt: at.Add(time.Second)})
	b.AddSystem(model.Snapshot{SampledAt: at.Add(1500 * time.Millisecond)})
	b.AddWorkload(ownerSnapshot(at.Add(2*time.Second), "one", nil))
	b.AddWorkload(ownerSnapshot(at.Add(4*time.Second), "one", model.Float(0)))
	// Repeated GPU publications carrying the retained owner pointer do not
	// create a second owner observation or a false gap at the GPU timestamp.
	retained := ownerSnapshot(at.Add(4*time.Second), "one", model.Float(0))
	retained.SampledAt = at.Add(5 * time.Second)
	b.AddWorkload(retained)
	got := b.QueryAligned([]SeriesDescriptor{{Key: "cpu", Entity: "owner:one", Metrics: []string{"cpu_cores"}}}, time.Minute, 100, at.Add(5*time.Second))
	if len(got.Points) != 3 {
		t.Fatalf("points=%+v", got.Points)
	}
	if got.Points[0].Values["cpu"]["cpu_cores"] != 2 || len(got.Points[1].Values["cpu"]) != 0 {
		t.Fatalf("gap=%+v", got.Points)
	}
	if value, ok := got.Points[2].Values["cpu"]["cpu_cores"]; !ok || value != 0 {
		t.Fatalf("zero=%+v", got.Points[2])
	}
}
func TestOwnerHistoryChurnAndCadenceAreBounded(t *testing.T) {
	b := New(time.Hour, 500*time.Millisecond)
	at := time.Now().UTC()
	for i := range 300 {
		b.AddWorkload(ownerSnapshot(at.Add(time.Duration(i)*2*time.Second), fmt.Sprint(i), model.Float(1)))
	}
	if len(b.series) != 256 {
		t.Fatalf("unbounded owners=%d", len(b.series))
	}
	for i := range 2000 {
		b.AddWorkload(ownerSnapshot(at.Add(time.Duration(300+i)*2*time.Second), "active", model.Float(1)))
	}
	if count := len(b.series["owner:active"].points); count != 1802 {
		t.Fatalf("owner cadence capacity=%d", count)
	}
}

func TestIndependentOwnersAcceptEqualAndDelayedTimestampsOnce(t *testing.T) {
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	b := New(12*time.Hour, time.Second)
	// A later source arrives first. Its owner's genuine earlier sample remains
	// valid even though the envelope timestamp differs.
	later := ownerSnapshot(base.Add(2*time.Second), "first", model.Float(3))
	later.WorkloadTelemetry.SampledAt = base.Add(3 * time.Second)
	b.AddWorkload(later)
	b.AddWorkload(ownerSnapshot(base, "second", model.Float(4)))
	b.AddWorkload(ownerSnapshot(base, "first", model.Float(1)))
	b.AddWorkload(ownerSnapshot(base, "first", model.Float(99)))
	first := b.Query("owner:first", nil, time.Minute, base.Add(4*time.Second))
	second := b.Query("owner:second", nil, time.Minute, base.Add(4*time.Second))
	if len(first.Points) != 2 || first.Points[0].Values["cpu_cores"] != 1 || first.Points[1].Values["cpu_cores"] != 3 || len(second.Points) != 1 || second.Points[0].Values["cpu_cores"] != 4 {
		t.Fatalf("independent source samples dropped, duplicated, or retimed: first=%+v second=%+v", first.Points, second.Points)
	}
	long := b.Query("owner:first", nil, 4*time.Hour, base.Add(4*time.Second))
	if len(long.Points) != 1 || long.Points[0].Values["cpu_cores"] != 2 {
		t.Fatalf("duplicate owner sample skewed aggregate mean: %+v", long.Points)
	}
	aligned := b.QueryAligned([]SeriesDescriptor{{Key: "first", Entity: "owner:first"}, {Key: "second", Entity: "owner:second"}}, time.Minute, 100, base.Add(4*time.Second))
	if len(aligned.Points) != 3 || len(aligned.Points[0].Values) != 2 || len(aligned.Points[2].Values) != 0 {
		t.Fatalf("workload timeline is not the timestamp union: %+v", aligned.Points)
	}
}

func TestLateOwnerSamplesUpdateExistingAggregateBuckets(t *testing.T) {
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	b := New(12*time.Hour, time.Second)
	// Fill a continuous timeline first; late sources should merge into its
	// existing buckets rather than create duplicate timestamp buckets.
	for index := range 31 {
		at := base.Add(time.Duration(index) * 2 * time.Second)
		b.AddWorkload(ownerSnapshot(at, "clock", model.Float(1)))
	}
	for _, second := range []int{32, 0, 2, 30} {
		b.AddWorkload(ownerSnapshot(base.Add(time.Duration(second)*time.Second), "late", model.Float(float64(second+1))))
	}
	long := b.Query("owner:late", nil, 4*time.Hour, base.Add(60*time.Second))
	if len(long.Points) != 2 || long.Points[0].Values["cpu_cores"] != 2 || long.Points[1].Values["cpu_cores"] != 32 {
		t.Fatalf("delayed samples lost or split existing buckets: %+v", long.Points)
	}
}
