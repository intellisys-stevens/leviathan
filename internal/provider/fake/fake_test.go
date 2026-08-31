package fake

import (
	"context"
	"testing"
	"time"

	"github.com/intellisys-stevens/leviathan/internal/model"
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

func TestFixtureIncludesPowerLimitAndPCIeThroughput(t *testing.T) {
	at := time.Date(2026, 8, 30, 12, 0, 0, 0, time.UTC)
	provider, _ := NewFixture("blackwell")
	snapshot, err := provider.Sample(context.Background(), at)
	if err != nil {
		t.Fatal(err)
	}
	gpu := snapshot.GPUs[0]
	for _, name := range []string{"power_limit", "pcie_tx_bytes_per_second", "pcie_rx_bytes_per_second"} {
		metric, ok := gpu.Metrics[name]
		if !ok || metric.Value == nil || metric.Status != model.StatusAvailable {
			t.Fatalf("physical metric %q = %+v", name, metric)
		}
	}
	if metric := gpu.Metrics["power_limit"]; metric.Unit != "watts" || metric.Source != model.SourceNVML {
		t.Fatalf("power limit metric = %+v", metric)
	}
	for _, name := range []string{"pcie_tx_bytes_per_second", "pcie_rx_bytes_per_second"} {
		physical := gpu.Metrics[name]
		instance := gpu.GPUInstances[0].Metrics[name]
		if physical.Unit != "bytes_per_second" || physical.Scope != model.ScopePhysicalGPU || physical.Source != model.SourceNVMLGPM {
			t.Fatalf("physical PCIe metric %q = %+v", name, physical)
		}
		if instance.Unit != "bytes_per_second" || instance.Scope != model.ScopeGPUInstance || instance.Source != model.SourceNVMLGPM {
			t.Fatalf("GI PCIe metric %q = %+v", name, instance)
		}
	}
}

func TestNonMIGFixtureUsesLegacyPhysicalPCIeSource(t *testing.T) {
	provider, _ := NewFixture("non-mig")
	snapshot, err := provider.Sample(context.Background(), time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"pcie_tx_bytes_per_second", "pcie_rx_bytes_per_second"} {
		metric := snapshot.GPUs[0].Metrics[name]
		if metric.Value == nil || metric.Source != model.SourceNVML || metric.Scope != model.ScopePhysicalGPU || metric.Unit != "bytes_per_second" {
			t.Fatalf("non-MIG PCIe metric %q = %+v", name, metric)
		}
	}
}
