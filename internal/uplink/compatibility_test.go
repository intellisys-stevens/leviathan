package uplink

import (
	"errors"
	"github.com/intellisys-stevens/leviathan/model"
	"reflect"
	"strings"
	"testing"
)

func TestCustomSourcesRemainLocalWithoutRelabeling(t *testing.T) {
	snapshot := projectionSnapshot()
	metric := snapshot.GPUs[0].Metrics["sm_activity"]
	metric.Source = "example_fixture"
	snapshot.GPUs[0].Metrics["sm_activity"] = metric
	snapshot.System.Storage.Filesystems[0].Source = "example_fs"
	envelope, err := Project(snapshot, model.BuildInfo{}, testStreamID, 1)
	if err != nil {
		t.Fatal(err)
	}
	if _, exists := envelope.GPUs[0].Metrics["sm_activity"]; exists {
		t.Fatal("custom metric source crossed locked uplink")
	}
	if len(envelope.System.Storage.Filesystems) != 0 {
		t.Fatal("custom filesystem was disguised as statfs")
	}
	if got := CompatibilityDiagnostics(snapshot); len(got) != 1 || got[0].Code != "uplink_omitted_observations" {
		t.Fatalf("diagnostics = %+v", got)
	}
	if snapshot.GPUs[0].Metrics["sm_activity"].Source != "example_fixture" {
		t.Fatal("projection mutated local source")
	}
	snapshot.System.CPU.Source = "example_fixture"
	if _, err = Project(snapshot, model.BuildInfo{}, testStreamID, 2); !errors.Is(err, ErrUnsupportedObservation) {
		t.Fatalf("required custom source: %v", err)
	}
}

func TestSupportedFilesystemProvenanceIsPreserved(t *testing.T) {
	snapshot := projectionSnapshot()
	snapshot.System.Storage.Filesystems[0].Source = model.SourceSynthetic
	snapshot.System.Storage.Source = model.SourceSynthetic
	envelope, err := Project(snapshot, model.BuildInfo{}, testStreamID, 1)
	if err != nil {
		t.Fatal(err)
	}
	if envelope.System.Storage.Filesystems[0].Source != "synthetic" || envelope.System.Storage.Source != "synthetic" {
		t.Fatal("filesystem provenance changed")
	}
}

func TestUnknownMetricNamesAreOmittedAndReported(t *testing.T) {
	snapshot := projectionSnapshot()
	delete(snapshot.GPUs[0].Metrics, "secret_metric_canary")
	if got := CompatibilityDiagnostics(snapshot); len(got) != 0 {
		t.Fatalf("builtin fixture unexpected diagnostic: %+v", got)
	}
	snapshot.GPUs[0].Metrics["plugin_private_metric"] = snapshot.GPUs[0].Metrics["sm_activity"]
	envelope, err := Project(snapshot, model.BuildInfo{}, testStreamID, 1)
	if err != nil {
		t.Fatal(err)
	}
	if _, exists := envelope.GPUs[0].Metrics["plugin_private_metric"]; exists {
		t.Fatal("unknown name crossed locked contract")
	}
	diagnostics := CompatibilityDiagnostics(snapshot)
	if len(diagnostics) != 1 || diagnostics[0].Code != "uplink_omitted_observations" {
		t.Fatalf("missing omission diagnostic: %+v", diagnostics)
	}
	if strings.Contains(diagnostics[0].Summary, "plugin_private_metric") {
		t.Fatal("diagnostic disclosed metric identity")
	}
}

func TestGPUProjectionPreservesDeclaredScopeAcrossHierarchy(t *testing.T) {
	snapshot := projectionSnapshot()
	gi := &snapshot.GPUs[0].GPUInstances[0]
	gi.Memory.Scope = model.ScopePhysicalGPU
	metric := gi.Metrics["sm_activity"]
	metric.Scope = model.ScopePhysicalGPU
	gi.Metrics["sm_activity"] = metric
	ci := &gi.ComputeInstances[0]
	ci.Memory.Scope = model.ScopeGPUInstance
	metric = ci.Metrics["sm_activity"]
	metric.Scope = model.ScopeGPUInstance
	ci.Metrics["sm_activity"] = metric
	envelope, err := Project(snapshot, model.BuildInfo{}, testStreamID, 1)
	if err != nil {
		t.Fatal(err)
	}
	projectedGI := envelope.GPUs[0].GPUInstances[0]
	projectedCI := projectedGI.ComputeInstances[0]
	if projectedGI.Memory.Scope != "physical_gpu" || projectedGI.Metrics["sm_activity"].Scope != "physical_gpu" || projectedCI.Memory.Scope != "gpu_instance" || projectedCI.Metrics["sm_activity"].Scope != "gpu_instance" {
		t.Fatal("projection narrowed the original measurement scope")
	}
}

func TestUnsupportedScopesOmitOptionalDataAndSkipRequiredHost(t *testing.T) {
	for _, test := range []struct {
		name     string
		change   func(*model.Snapshot)
		kept     func(Envelope) bool
		required bool
	}{
		{"metric", func(s *model.Snapshot) {
			m := s.GPUs[0].Metrics["sm_activity"]
			m.Scope = model.ScopeWorkloadOwner
			s.GPUs[0].Metrics["sm_activity"] = m
		}, func(e Envelope) bool { _, ok := e.GPUs[0].Metrics["sm_activity"]; return ok }, false},
		{"GPU memory", func(s *model.Snapshot) { s.GPUs[0].Memory.Scope = model.ScopeWorkloadOwner }, func(e Envelope) bool { return len(e.GPUs) > 0 }, false},
		{"filesystem", func(s *model.Snapshot) { s.System.Storage.Filesystems[0].Scope = model.ScopeWorkloadOwner }, func(e Envelope) bool { return len(e.System.Storage.Filesystems) > 0 }, false},
		{"host memory", func(s *model.Snapshot) { s.System.Memory.Scope = model.ScopeWorkloadOwner }, nil, true},
		{"host storage", func(s *model.Snapshot) { s.System.Storage.Scope = model.ScopeWorkloadOwner }, nil, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			snapshot := projectionSnapshot()
			delete(snapshot.GPUs[0].Metrics, "secret_metric_canary")
			test.change(&snapshot)
			envelope, err := Project(snapshot, model.BuildInfo{}, testStreamID, 1)
			if test.required {
				if !errors.Is(err, ErrUnsupportedObservation) {
					t.Fatalf("required unsupported scope: %v", err)
				}
			} else if err != nil || test.kept(envelope) {
				t.Fatalf("unsupported optional scope was projected: %v", err)
			}
			if len(CompatibilityDiagnostics(snapshot)) != 1 {
				t.Fatal("missing scope omission diagnostic")
			}
		})
	}
}

func TestUplinkHealthUsesGenericGPUCapability(t *testing.T) {
	snapshot := projectionSnapshot()
	snapshot.Capabilities.GPU = &model.ProviderState{Name: "custom GPU sensor", Status: model.StatusStale}
	envelope, err := Project(snapshot, model.BuildInfo{}, testStreamID, 1)
	if err != nil {
		t.Fatal(err)
	}
	if envelope.Health.GPU.Status != HealthDegraded {
		t.Fatalf("generic GPU status ignored: %+v", envelope.Health.GPU)
	}
	snapshot.Capabilities.GPU.Status = model.StatusAvailable
	snapshot.Capabilities.GPU.Available = true
	snapshot.Capabilities.NVML.Status = model.StatusStale
	envelope, err = Project(snapshot, model.BuildInfo{}, testStreamID, 1)
	if err != nil {
		t.Fatal(err)
	}
	if envelope.Health.GPU.Status != HealthOK {
		t.Fatal("unrelated NVML status overrode generic GPU availability")
	}
}

func TestOmittedGPUDevicesCannotReportHealthyUplinkGPU(t *testing.T) {
	for _, change := range []struct {
		name  string
		apply func(*model.Memory)
	}{
		{"custom source", func(memory *model.Memory) { memory.Source = "custom_gpu_sensor" }},
		{"unsupported scope", func(memory *model.Memory) { memory.Scope = model.ScopeWorkloadOwner }},
	} {
		t.Run(change.name, func(t *testing.T) {
			snapshot := projectionSnapshot()
			delete(snapshot.GPUs[0].Metrics, "secret_metric_canary")
			snapshot.Capabilities.GPU = &model.ProviderState{Name: "generic GPU", Available: true, Status: model.StatusAvailable}
			original, err := Project(snapshot, model.BuildInfo{}, testStreamID, 1)
			if err != nil {
				t.Fatal(err)
			}
			change.apply(&snapshot.GPUs[0].Memory)
			projected, err := Project(snapshot, model.BuildInfo{}, testStreamID, 2)
			if err != nil {
				t.Fatal(err)
			}
			if len(projected.GPUs) != 0 || projected.Health.GPU.Status != HealthUnavailable {
				t.Fatalf("omitted GPU remained healthy: devices=%d health=%+v", len(projected.GPUs), projected.Health.GPU)
			}
			if !reflect.DeepEqual(projected.Health.System, original.Health.System) || !reflect.DeepEqual(projected.Health.Diagnostics, original.Health.Diagnostics) {
				t.Fatal("GPU omission changed unrelated host health or safe diagnostics")
			}
			diagnostics := CompatibilityDiagnostics(snapshot)
			if len(diagnostics) != 1 || diagnostics[0].Code != "uplink_omitted_observations" {
				t.Fatalf("missing local omission diagnostic: %+v", diagnostics)
			}
		})
	}
}
