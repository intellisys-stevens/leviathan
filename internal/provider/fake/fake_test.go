package fake

import (
	"context"
	"testing"
	"time"

	"github.com/miglens/miglens/internal/model"
)

func TestAllSanitizedFixturesSample(t *testing.T) {
	for _, name := range Fixtures() {
		t.Run(name, func(t *testing.T) {
			provider, err := NewFixture(name)
			if err != nil {
				t.Fatal(err)
			}
			snapshot, err := provider.Sample(context.Background(), time.Date(2026, 8, 29, 12, 0, 0, 0, time.UTC))
			if err != nil {
				t.Fatal(err)
			}
			if snapshot.GPUs == nil || snapshot.Processes == nil || snapshot.Diagnostics == nil {
				t.Fatal("canonical arrays must encode as [] rather than null")
			}
		})
	}
}

func TestMultiCIKeepsGIMetricsAtGIScope(t *testing.T) {
	provider, _ := NewFixture("multi-ci")
	snapshot, err := provider.Sample(context.Background(), time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	gi := snapshot.GPUs[0].GPUInstances[0]
	if len(gi.ComputeInstances) != 2 {
		t.Fatalf("compute instances = %d, want 2", len(gi.ComputeInstances))
	}
	if gi.Metrics["sm_activity"].Scope != model.ScopeGPUInstance {
		t.Fatalf("activity scope = %q", gi.Metrics["sm_activity"].Scope)
	}
	if gi.Metrics["gpu_activity"].Source != model.SourceNVMLGPM {
		t.Fatalf("GPU activity source = %q", gi.Metrics["gpu_activity"].Source)
	}
	for _, ci := range gi.ComputeInstances {
		if len(ci.Metrics) != 0 {
			t.Fatalf("GI-scoped metrics were copied onto CI %d", ci.ID)
		}
		if ci.Memory.Status != model.StatusUnsupported || ci.Memory.UsedBytes != nil {
			t.Fatalf("GI memory was copied onto CI %d: %+v", ci.ID, ci.Memory)
		}
	}
}

func TestStaleFixtureValuesAreNilNotZero(t *testing.T) {
	provider, _ := NewFixture("stale")
	snapshot, err := provider.Sample(context.Background(), time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	for _, gpu := range snapshot.GPUs {
		for _, gi := range gpu.GPUInstances {
			for metricName, metric := range gi.Metrics {
				if metric.Value != nil {
					t.Errorf("%s %s has value %v", gi.UUID, metricName, *metric.Value)
				}
			}
		}
	}
}

func TestUnknownFixtureListsChoices(t *testing.T) {
	if _, err := NewFixture("mystery"); err == nil {
		t.Fatal("unknown fixture accepted")
	}
}

func TestFixtureProcessesAreTopLevelAndCommandLineIsOptIn(t *testing.T) {
	provider, _ := NewFixture("blackwell", Options{ShowCommandLine: true})
	snapshot, err := provider.Sample(context.Background(), time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Processes) != 1 || snapshot.Processes[0].CommandLine == "" {
		t.Fatalf("GPU fixture processes = %+v", snapshot.Processes)
	}
	redacted, _ := NewFixture("blackwell")
	redactedSnapshot, _ := redacted.Sample(context.Background(), time.Now().UTC())
	for _, process := range redactedSnapshot.Processes {
		if process.CommandLine != "" {
			t.Fatalf("fixture leaked command arguments: %+v", process)
		}
	}
}
