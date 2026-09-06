package collector

import (
	"context"
	"testing"
	"time"

	"github.com/intellisys-stevens/leviathan/internal/health"
	"github.com/intellisys-stevens/leviathan/internal/history"
	"github.com/intellisys-stevens/leviathan/internal/model"
	"github.com/intellisys-stevens/leviathan/internal/provider/fake"
	systemtelemetry "github.com/intellisys-stevens/leviathan/internal/system"
)

func TestCombinedProviderRefreshesHostTelemetry(t *testing.T) {
	at := time.Date(2026, 9, 5, 12, 0, 0, 0, time.UTC)
	e := New(fake.New(), time.Second, time.Hour)
	if err := e.poll(context.Background(), at); err != nil {
		t.Fatal(err)
	}
	first, _ := e.Current()
	now := at.Add(10 * time.Second)
	if err := e.poll(context.Background(), now); err != nil {
		t.Fatal(err)
	}
	current, _ := e.Current()
	if !current.System.SampledAt.Equal(now) || !current.System.CPU.Utilization.SampledAt.Equal(now) {
		t.Fatalf("combined provider retained old host data: %+v", current.System)
	}
	if *current.System.CPU.Utilization.Value == *first.System.CPU.Utilization.Value {
		t.Fatal("fixture host utilization did not advance")
	}
	report := health.New(e, health.Options{Now: func() time.Time { return now }}).Status()
	if report.Components[0].State != health.Operational || !report.Components[0].ObservedAt.Equal(now) {
		t.Fatalf("combined provider host freshness = %+v", report.Components[0])
	}
}

func TestHealthKeepsIndependentDomainObservations(t *testing.T) {
	at := time.Date(2026, 9, 5, 12, 0, 0, 0, time.UTC)
	e := &Engine{history: history.New(time.Hour, time.Second), system: systemtelemetry.Default()}
	e.interval.Store(int64(time.Second))
	snapshot := model.Snapshot{SampledAt: at, System: model.System{SampledAt: at}, Attribution: &model.Attribution{Status: model.AttributionAvailable}, Capabilities: model.Capabilities{
		System: model.ProviderState{Available: true, Status: model.StatusAvailable},
		NVML:   model.ProviderState{Available: true, Status: model.StatusAvailable},
	}}
	e.storeSnapshot(snapshot, false, domainSystem)
	e.storeSnapshot(snapshot, false, domainGPU)
	now := at.Add(10 * time.Second)
	snapshot.SampledAt, snapshot.System.SampledAt = now, now
	e.storeSnapshot(snapshot, false, domainSystem)
	observation := e.HealthObservation()
	if !observation.System.ObservedAt.Equal(now) || !observation.GPU.ObservedAt.Equal(at) {
		t.Fatalf("independent times = %+v", observation)
	}
	report := health.New(e, health.Options{Now: func() time.Time { return now }}).Status()
	if report.Components[0].State != health.Operational || report.Components[1].State != health.Unknown {
		t.Fatalf("hung GPU hidden by host: %+v", report.Components)
	}
	e.recordPollError(now, assertionError("GPU failed"))
	report = health.New(e, health.Options{Now: func() time.Time { return now }}).Status()
	if report.Components[0].State != health.Operational || report.Components[1].State != health.Unavailable {
		t.Fatalf("GPU failure affected host: %+v", report.Components)
	}
	for index := 1; index <= 10; index++ {
		e.recordPollError(now.Add(time.Duration(index)*time.Second), assertionError("GPU failed again"))
	}
	report = health.New(e, health.Options{Attribution: true, Now: func() time.Time { return now.Add(10 * time.Second) }}).Status()
	if report.Components[2].State != health.Unknown || !report.Components[2].ObservedAt.Equal(at) {
		t.Fatalf("GPU failures refreshed old attribution: %+v", report.Components[2])
	}
}

type assertionError string

func (e assertionError) Error() string { return string(e) }

func TestStaleHostUptimeDoesNotMutatePublishedMeasurement(t *testing.T) {
	at := time.Date(2026, 9, 5, 12, 0, 0, 0, time.UTC)
	uptime := model.AvailableMetric(120, "seconds", model.SourceProcFS, model.ScopeHost, at)
	original := model.System{Uptime: &uptime}
	stale := staleSystem(original, at.Add(time.Second), "failed")
	if stale.Uptime == nil || stale.Uptime.Value != nil || stale.Uptime.Status != model.StatusStale {
		t.Fatalf("stale uptime = %+v", stale.Uptime)
	}
	if original.Uptime.Value == nil || *original.Uptime.Value != 120 {
		t.Fatal("original uptime was mutated")
	}
}
