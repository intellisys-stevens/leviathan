package collector

import (
	"testing"
	"time"

	"github.com/intellisys-stevens/leviathan/internal/plugins"
	"github.com/intellisys-stevens/leviathan/model"
	v1 "github.com/intellisys-stevens/leviathan/plugin/v1"
)

func pluginTestEngine(t *testing.T) *Engine {
	t.Helper()
	r, err := plugins.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	return NewPluginEngine(r, Options{SamplingInterval: time.Second, HistoryWindow: time.Minute})
}
func pluginEvent(id string, cap v1.Capability, sourceAt, eventAt time.Time) plugins.Event {
	o := &v1.Observation{InstanceID: id, SessionID: "first", Capability: cap, Revision: 1, ObservedAt: sourceAt, Status: "available"}
	return plugins.Event{InstanceID: id, Capability: cap, Observation: o, At: eventAt, Interval: time.Second}
}
func gpuPluginEvent(id, uuid string, at time.Time) plugins.Event {
	e := pluginEvent(id, v1.GPU, at, at)
	e.Observation.GPU = &v1.GPUData{GPUs: []model.GPU{{UUID: uuid, Metrics: model.MetricSet{"gpu_activity": model.AvailableMetric(25, "percent", "custom_gpu", model.ScopePhysicalGPU, at)}}}}
	return e
}
func ownerPluginEvent(id, ref string, at time.Time) plugins.Event {
	e := pluginEvent(id, v1.WorkloadMeasurements, at, at)
	e.Observation.WorkloadMeasurements = &model.WorkloadTelemetry{SampledAt: at, ObservedAt: &at, Status: model.WorkloadTelemetryAvailable, Owners: []model.WorkloadOwnerTelemetry{{Ref: ref, Name: "Owner", Platform: "batch", SampledAt: at, Status: model.WorkloadTelemetryAvailable, Metrics: model.MetricSet{"cpu_cores": model.AvailableMetric(2, "cores", "batch_sensor", model.ScopeWorkloadOwner, at)}}}}
	return e
}
func hasPluginDiagnostic(snapshot model.Snapshot, code string) bool {
	for _, d := range snapshot.Diagnostics {
		if d.Code == code {
			return true
		}
	}
	return false
}

func TestConflictingOwnersAndResourcesAreAllWithheld(t *testing.T) {
	at := time.Now().UTC()
	t.Run("GPU owners", func(t *testing.T) {
		e := pluginTestEngine(t)
		e.AcceptObservation(gpuPluginEvent("one", "GPU-shared", at))
		e.AcceptObservation(gpuPluginEvent("two", "GPU-shared", at))
		s, _ := e.Current()
		if len(s.GPUs) != 0 || !hasPluginDiagnostic(s, "plugin_ownership_conflict") {
			t.Fatalf("conflicting GPU survived: %+v", s.GPUs)
		}
	})
	t.Run("telemetry owners", func(t *testing.T) {
		e := pluginTestEngine(t)
		one, two := ownerPluginEvent("one", "alice", at), ownerPluginEvent("two", "alice", at)
		one.Native, two.Native = true, true
		e.AcceptObservation(one)
		e.AcceptObservation(two)
		s, _ := e.Current()
		if s.WorkloadTelemetry == nil || len(s.WorkloadTelemetry.Owners) != 0 || !hasPluginDiagnostic(s, "plugin_owner_conflict") {
			t.Fatalf("conflicting owner survived: %+v", s.WorkloadTelemetry)
		}
	})
	t.Run("host owners", func(t *testing.T) {
		e := pluginTestEngine(t)
		for _, id := range []string{"one", "two"} {
			event := pluginEvent(id, v1.Host, at, at)
			event.Observation.Host = &v1.HostData{System: model.System{SampledAt: at, Status: model.StatusAvailable, CPU: model.CPU{Model: id}}}
			e.AcceptObservation(event)
		}
		s, _ := e.Current()
		if s.System.CPU.Model != "" || !hasPluginDiagnostic(s, "plugin_ownership_conflict") {
			t.Fatalf("conflicting host survived: %+v", s.System)
		}
	})
}

func TestAllocationResourceGenerationAndMetadataExpiry(t *testing.T) {
	at := time.Now().UTC()
	e := pluginTestEngine(t)
	gpu := gpuPluginEvent("sensor", "GPU-one", at)
	gpu.Observation.GPU.GPUs[0].Generation = "incarnation-2"
	e.AcceptObservation(gpu)
	workload := model.WorkloadAttribution{Ref: "job", Name: "Job", Platform: "batch", Kind: "job"}
	inventory := pluginEvent("jobs", v1.WorkloadInventory, at, at)
	inventory.Observation.WorkloadInventory = &v1.InventoryData{Workloads: []model.WorkloadAttribution{workload}}
	e.AcceptObservation(inventory)
	allocation := pluginEvent("allocator", v1.Allocations, at, at)
	allocation.Observation.Allocations = &v1.AllocationData{Assignments: []v1.Assignment{{WorkloadRef: "jobs/" + workload.Ref, Resource: v1.ResourceRef{InstanceID: "sensor", ID: "GPU-one", Generation: "incarnation-1"}, EntityType: model.AllocationEntityPhysicalGPU, State: model.AllocationStateAllocated}}}
	e.AcceptObservation(allocation)
	s, _ := e.Current()
	if len(s.Attribution.Assignments) != 0 || !hasPluginDiagnostic(s, "plugin_unresolved_reference") {
		t.Fatal("accepted replaced GPU generation")
	}
	allocation.Observation = &v1.Observation{InstanceID: "allocator", SessionID: "first", Capability: v1.Allocations, Revision: 2, ObservedAt: at.Add(time.Second), Status: "available", Allocations: &v1.AllocationData{Assignments: []v1.Assignment{{WorkloadRef: "jobs/" + workload.Ref, Resource: v1.ResourceRef{InstanceID: "sensor", ID: "GPU-one", Generation: "incarnation-2"}, EntityType: model.AllocationEntityPhysicalGPU, State: model.AllocationStateAllocated}}}}
	allocation.At = at.Add(time.Second)
	e.AcceptObservation(allocation)
	s, _ = e.Current()
	if len(s.Attribution.Assignments) != 1 || s.Attribution.Assignments[0].EntityUUID != "sensor/GPU-one" {
		t.Fatalf("explicit target did not join: %+v", s.Attribution)
	}
	future := at.Add(65 * time.Second)
	gpu = gpuPluginEvent("sensor", "GPU-one", future)
	gpu.Observation.GPU.GPUs[0].Generation = "incarnation-2"
	e.AcceptObservation(gpu)
	inventory.Observation = &v1.Observation{InstanceID: "jobs", SessionID: "first", Capability: v1.WorkloadInventory, Revision: 2, ObservedAt: future, Status: "available", WorkloadInventory: &v1.InventoryData{Workloads: []model.WorkloadAttribution{workload}}}
	inventory.At = future
	e.AcceptObservation(inventory)
	s, _ = e.Current()
	if len(s.Attribution.Assignments) != 0 {
		t.Fatal("expired allocation survived through fresh inventory")
	}
}

func TestUnknownResolutionIsPreservedWithoutWorkloadRows(t *testing.T) {
	at := time.Now().UTC()
	e := pluginTestEngine(t)
	event := pluginEvent("environment", v1.Allocations, at, at)
	event.Observation.Allocations = &v1.AllocationData{Resolution: &model.AttributionResolution{Status: "unknown", ReasonCodes: []string{"checkpoint_unavailable"}, Workloads: []model.WorkloadAssignmentResolution{}}}
	e.AcceptObservation(event)
	snapshot, _ := e.Current()
	if snapshot.Attribution == nil || snapshot.Attribution.Resolution == nil || snapshot.Attribution.Resolution.Status != "unknown" {
		t.Fatalf("lost unresolved coverage: %+v", snapshot.Attribution)
	}
}

func TestPluginHistoryUsesSourceTimesAndIndependentCapabilities(t *testing.T) {
	at := time.Now().UTC().Add(-10 * time.Second)
	e := pluginTestEngine(t)
	host := pluginEvent("host", v1.Host, at, at.Add(100*time.Millisecond))
	host.Observation.Host = &v1.HostData{System: model.System{SampledAt: at, Status: model.StatusAvailable, CPU: model.CPU{SampledAt: at, Utilization: model.AvailableMetric(10, "percent", "custom_host", model.ScopeHost, at)}}}
	e.AcceptObservation(host)
	gpu := gpuPluginEvent("sensor", "GPU-one", at.Add(time.Second))
	gpu.At = gpu.At.Add(100 * time.Millisecond)
	e.AcceptObservation(gpu)
	workload := ownerPluginEvent("batch", "alice", at.Add(2*time.Second))
	workload.At = workload.At.Add(100 * time.Millisecond)
	e.AcceptObservation(workload)
	inventory := pluginEvent("batch", v1.WorkloadInventory, at.Add(3*time.Second), at.Add(3*time.Second))
	inventory.Observation.WorkloadInventory = &v1.InventoryData{}
	e.AcceptObservation(inventory)
	cached := gpu
	cached.At = at.Add(3500 * time.Millisecond)
	e.AcceptObservation(cached)
	now := at.Add(4 * time.Second)
	for _, test := range []struct {
		entity, metric string
		at             time.Time
	}{{"@host", "cpu_utilization", at}, {"sensor/GPU-one", "gpu_activity", at.Add(time.Second)}, {"owner:batch/alice", "cpu_cores", at.Add(2 * time.Second)}} {
		t.Run(test.entity, func(t *testing.T) {
			series := e.History(test.entity, []string{test.metric}, time.Minute, now)
			if len(series.Points) != 1 || !series.Points[0].SampledAt.Equal(test.at) {
				t.Fatalf("history manufactured or lost samples: %+v, expected one at %v", series.Points, test.at)
			}
		})
	}
	snapshot, _ := e.Current()
	if !snapshot.System.SampledAt.Equal(at) || !snapshot.GPUs[0].Metrics["gpu_activity"].SampledAt.Equal(gpu.Observation.ObservedAt) || !snapshot.WorkloadTelemetry.Owners[0].SampledAt.Equal(workload.Observation.ObservedAt) {
		t.Fatal("assembly refreshed source measurement timestamps")
	}
}

func TestOneGPUPluginCannotAdvanceAnotherPluginsHistory(t *testing.T) {
	at := time.Now().UTC().Add(-5 * time.Second)
	e := pluginTestEngine(t)
	e.AcceptObservation(gpuPluginEvent("one", "GPU-one", at))
	e.AcceptObservation(gpuPluginEvent("two", "GPU-two", at.Add(time.Second)))
	next := gpuPluginEvent("one", "GPU-one", at.Add(2*time.Second))
	next.Observation.Revision = 2
	e.AcceptObservation(next)
	first := e.History("one/GPU-one", []string{"gpu_activity"}, time.Minute, at.Add(3*time.Second))
	second := e.History("two/GPU-two", []string{"gpu_activity"}, time.Minute, at.Add(3*time.Second))
	if len(first.Points) != 2 || len(second.Points) != 1 {
		t.Fatalf("unrelated plugin advanced cached history: first=%+v second=%+v", first.Points, second.Points)
	}
}

func TestAssemblyDoesNotMutatePublishedSourceSlices(t *testing.T) {
	at := time.Now().UTC()
	e := pluginTestEngine(t)
	event := gpuPluginEvent("sensor", "GPU-one", at)
	event.Observation.GPU.GPUs[0].GPUInstances = []model.GPUInstance{{UUID: "GI-one", ComputeInstances: []model.ComputeInstance{{UUID: "CI-one"}}}}
	e.AcceptObservation(event)
	first, _ := e.Current()
	firstGeneration := first.GPUs[0].GPUInstances[0].ComputeInstances[0].Generation
	metadata := pluginEvent("metadata", v1.WorkloadInventory, at.Add(time.Second), at.Add(time.Second))
	metadata.Observation.WorkloadInventory = &v1.InventoryData{}
	e.AcceptObservation(metadata)
	second, _ := e.Current()
	if event.Observation.GPU.GPUs[0].GPUInstances[0].UUID != "GI-one" || event.Observation.GPU.GPUs[0].GPUInstances[0].ComputeInstances[0].Generation != "" {
		t.Fatal("assembly mutated plugin-owned hierarchy")
	}
	if first.GPUs[0].GPUInstances[0].ComputeInstances[0].Generation != firstGeneration || second.GPUs[0].GPUInstances[0].ComputeInstances[0].Generation != firstGeneration {
		t.Fatal("metadata changed a resource generation")
	}
}
