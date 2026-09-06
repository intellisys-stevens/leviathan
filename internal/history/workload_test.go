package history

import (
	"fmt"
	"testing"
	"time"

	"github.com/intellisys-stevens/leviathan/internal/model"
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
