package model

import (
	"encoding/json"
	"reflect"
	"testing"
	"time"
)

func TestNormalizeSparseSnapshotUsesUnsupportedGroupsWithoutFreshness(t *testing.T) {
	sourceAt := time.Unix(1700000000, 0).UTC()
	original := Snapshot{SampledAt: sourceAt, GPUs: []GPU{{UUID: "GPU-a", Metrics: MetricSet{"gpu_activity": {}}, GPUInstances: []GPUInstance{{UUID: "GI-a", ComputeInstances: []ComputeInstance{{UUID: "CI-a"}}}}}}}
	normalized := NormalizeSnapshot(original)
	if normalized.SchemaVersion != "v1" || normalized.Capabilities.NVML.Available || normalized.Capabilities.NVML.Status != StatusUnsupported || normalized.Capabilities.GPU != nil {
		t.Fatalf("invented provider capability: %+v", normalized.Capabilities)
	}
	if !normalized.SampledAt.Equal(sourceAt) || !normalized.System.SampledAt.IsZero() || !normalized.System.CPU.Utilization.SampledAt.IsZero() {
		t.Fatal("normalization advanced source timestamps")
	}
	for _, metric := range []Metric{normalized.System.CPU.Utilization, normalized.System.CPU.Load1, normalized.System.Storage.ReadBytesPerSecond, normalized.GPUs[0].Metrics["gpu_activity"]} {
		if metric.Value != nil || metric.Source != SourceUnknown || metric.Status != StatusUnsupported || metric.Unit == "" || metric.Scope == "" {
			t.Fatalf("incomplete unavailable metric: %+v", metric)
		}
	}
	for _, memory := range []Memory{normalized.GPUs[0].Memory, normalized.GPUs[0].GPUInstances[0].Memory, normalized.GPUs[0].GPUInstances[0].ComputeInstances[0].Memory} {
		if memory.TotalBytes != nil || memory.UsedBytes != nil || memory.Source != SourceUnknown || memory.Status != StatusUnsupported || memory.Scope == "" || !memory.SampledAt.IsZero() {
			t.Fatalf("incomplete memory group: %+v", memory)
		}
	}
	if original.GPUs[0].Metrics["gpu_activity"].Status != "" || original.GPUs[0].Memory.Source != "" || original.System.Status != "" {
		t.Fatal("normalization mutated sparse input")
	}
	data, err := json.Marshal(normalized)
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]any
	if err = json.Unmarshal(data, &document); err != nil {
		t.Fatal(err)
	}
	if document["processes"] == nil || document["diagnostics"] == nil {
		t.Fatal("missing collections are not arrays")
	}
	if !reflect.DeepEqual(NormalizeSnapshot(normalized), normalized) {
		t.Fatal("normalization is not idempotent")
	}
}

func TestNormalizePreservesCustomProvenanceAndDeepCopies(t *testing.T) {
	at := time.Unix(1700000000, 0).UTC()
	workload := WorkloadAttribution{Ref: "job", Platform: "custom_batch", Kind: "custom_job", Name: "Job"}
	original := Snapshot{SampledAt: at, GPUs: []GPU{{UUID: "GPU-a", Memory: Memory{TotalBytes: Uint64(42), Source: "custom_sensor", Scope: ScopePhysicalGPU, Status: StatusAvailable, SampledAt: at}, Metrics: MetricSet{"custom_metric": AvailableMetric(3, "cores", "custom_sensor", ScopePhysicalGPU, at)}}}, Processes: []Process{{PID: 1, StartTime: &at, WorkloadRef: "job"}, {PID: 2, WorkloadRef: "missing"}}, Capabilities: Capabilities{GPU: &ProviderState{Name: "custom_sensor", Available: true, Status: StatusAvailable}}, Attribution: &Attribution{ObservedAt: &at, Workloads: []WorkloadAttribution{workload}, Resolution: &AttributionResolution{Status: "incomplete", ReasonCodes: []string{"pending"}, Workloads: []WorkloadAssignmentResolution{{WorkloadRef: "job", ReasonCodes: []string{"pending"}}}}}, WorkloadTelemetry: &WorkloadTelemetry{ObservedAt: &at, Owners: []WorkloadOwnerTelemetry{{Ref: "owner", Platform: "custom_batch", Workspaces: []WorkloadAttribution{workload}, Metrics: MetricSet{"cpu_cores": AvailableMetric(2, "cores", "custom_cgroup", ScopeWorkloadOwner, at)}}}}}
	normalized := NormalizeSnapshot(original)
	metric := normalized.GPUs[0].Metrics["custom_metric"]
	if metric.Source != "custom_sensor" || metric.Unit != "cores" || !metric.SampledAt.Equal(at) || normalized.Attribution.Workloads[0].Platform != "custom_batch" || normalized.Attribution.Workloads[0].Kind != "custom_job" {
		t.Fatal("custom provenance changed")
	}
	if normalized.Processes[0].WorkloadRef != "job" || normalized.Processes[1].WorkloadRef != "" || original.Processes[1].WorkloadRef != "missing" {
		t.Fatal("dangling workload joins were not isolated")
	}
	*normalized.GPUs[0].Memory.TotalBytes = 99
	*metric.Value = 99
	*normalized.Processes[0].StartTime = at.Add(time.Hour)
	normalized.Capabilities.GPU.Name = "changed"
	normalized.Attribution.Workloads[0].Name = "changed"
	normalized.Attribution.Resolution.ReasonCodes[0] = "changed"
	normalized.Attribution.Resolution.Workloads[0].ReasonCodes[0] = "changed"
	normalized.WorkloadTelemetry.Owners[0].Workspaces[0].Name = "changed"
	*normalized.WorkloadTelemetry.Owners[0].Metrics["cpu_cores"].Value = 99
	if *original.GPUs[0].Memory.TotalBytes != 42 || *original.GPUs[0].Metrics["custom_metric"].Value != 3 || !original.Processes[0].StartTime.Equal(at) || original.Capabilities.GPU.Name != "custom_sensor" || original.Attribution.Workloads[0].Name != "Job" || original.Attribution.Resolution.ReasonCodes[0] != "pending" || original.Attribution.Resolution.Workloads[0].ReasonCodes[0] != "pending" || original.WorkloadTelemetry.Owners[0].Workspaces[0].Name != "Job" || *original.WorkloadTelemetry.Owners[0].Metrics["cpu_cores"].Value != 2 {
		t.Fatal("normalized projection shares mutable source storage")
	}
}
