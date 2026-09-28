package collector

import (
	"errors"
	"testing"
	"time"

	"github.com/intellisys-stevens/leviathan/internal/health"
	"github.com/intellisys-stevens/leviathan/internal/history"
	"github.com/intellisys-stevens/leviathan/internal/plugins"
	"github.com/intellisys-stevens/leviathan/model"
	v1 "github.com/intellisys-stevens/leviathan/plugin/v1"
)

func TestWorkloadReferencesResolveLocalSlashesAndExplicitProducers(t *testing.T) {
	at := time.Now().UTC()
	for _, test := range []struct {
		name, local, external, ref, want string
	}{
		{"local slash", "ns/pod", "", "ns/pod", "example/ns/pod"},
		{"explicit producer", "", "job", "jobs/job", "jobs/job"},
		{"ambiguous", "jobs/job", "job", "jobs/job", ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			e := pluginTestEngine(t)
			e.AcceptObservation(gpuPluginEvent("sensor", "GPU-one", at))
			definition := model.WorkloadAttribution{Ref: test.local, Name: "Job", Platform: "batch", Kind: "job"}
			inventory := pluginEvent("example", v1.WorkloadInventory, at, at)
			inventory.Observation.WorkloadInventory = &v1.InventoryData{Scopes: []v1.ScopeAssignment{{ScopeRef: "scope", WorkloadRef: test.ref}}}
			if test.local != "" {
				inventory.Observation.WorkloadInventory.Workloads = []model.WorkloadAttribution{definition}
			}
			e.AcceptObservation(inventory)
			if test.external != "" {
				external := pluginEvent("jobs", v1.WorkloadInventory, at, at)
				definition.Ref = test.external
				external.Observation.WorkloadInventory = &v1.InventoryData{Workloads: []model.WorkloadAttribution{definition}}
				e.AcceptObservation(external)
			}
			allocation := pluginEvent("example", v1.Allocations, at, at)
			allocation.Observation.Allocations = &v1.AllocationData{
				Assignments: []v1.Assignment{{WorkloadRef: test.ref, Resource: v1.ResourceRef{InstanceID: "sensor", ID: "GPU-one"}, EntityType: model.AllocationEntityPhysicalGPU, State: model.AllocationStateAllocated}},
				Resolution:  &model.AttributionResolution{Status: "incomplete", Workloads: []model.WorkloadAssignmentResolution{{WorkloadRef: test.ref}}},
			}
			e.AcceptObservation(allocation)
			process := pluginEvent("example", v1.Processes, at, at)
			process.Observation.Processes = &v1.ProcessData{Processes: []v1.ProcessRecord{{Process: model.Process{PID: 1, WorkloadRef: test.ref}}, {Process: model.Process{PID: 2}, ScopeRef: "scope"}}}
			e.AcceptObservation(process)
			owner := ownerPluginEvent("example", "owner", at)
			definition.Ref = test.ref
			owner.Observation.WorkloadMeasurements.Owners[0].Workspaces = []model.WorkloadAttribution{definition}
			e.AcceptObservation(owner)
			snapshot, _ := e.Current()
			for _, process := range snapshot.Processes {
				if process.WorkloadRef != test.want {
					t.Fatalf("process reference=%q want=%q", process.WorkloadRef, test.want)
				}
			}
			assignments := snapshot.Attribution.Assignments
			resolutions := snapshot.Attribution.Resolution.Workloads
			workspaces := snapshot.WorkloadTelemetry.Owners[0].Workspaces
			if test.want == "" {
				if len(assignments) != 0 || len(resolutions) != 0 || len(workspaces) != 0 || !hasPluginDiagnostic(snapshot, "plugin_ambiguous_reference") {
					t.Fatalf("ambiguous references survived: %+v", snapshot)
				}
			} else if len(assignments) != 1 || assignments[0].WorkloadRef != test.want || len(resolutions) != 1 || resolutions[0].WorkloadRef != test.want || len(workspaces) != 1 || workspaces[0].Ref != test.want {
				t.Fatalf("references did not share resolution: allocations=%+v resolution=%+v owners=%+v", assignments, resolutions, workspaces)
			}
		})
	}
}

func TestPluginGenerationIncludesResourceIdentityAndHistoryRoundTrips(t *testing.T) {
	at := time.Now().UTC()
	e := pluginTestEngine(t)
	event := gpuPluginEvent("example", "GPU-a", at)
	event.Observation.GPU.GPUs = append(event.Observation.GPU.GPUs, model.GPU{UUID: "GPU-b"})
	for index := range event.Observation.GPU.GPUs {
		gpu := &event.Observation.GPU.GPUs[index]
		gpu.Generation = "1"
		gpu.Metrics = model.MetricSet{"gpu_activity": model.AvailableMetric(float64(index+1), "percent", "fixture", model.ScopePhysicalGPU, at)}
		gpu.GPUInstances = []model.GPUInstance{{UUID: gpu.UUID + "/gi", Generation: "1", Metrics: gpu.Metrics, ComputeInstances: []model.ComputeInstance{{UUID: gpu.UUID + "/ci", Generation: "1", Metrics: gpu.Metrics}}}}
	}
	e.AcceptObservation(event)
	snapshot, _ := e.Current()
	seen := map[string]bool{}
	for index, gpu := range snapshot.GPUs {
		for _, entity := range []struct{ uuid, generation string }{{gpu.UUID, gpu.Generation}, {gpu.GPUInstances[0].UUID, gpu.GPUInstances[0].Generation}, {gpu.GPUInstances[0].ComputeInstances[0].UUID, gpu.GPUInstances[0].ComputeInstances[0].Generation}} {
			if seen[entity.generation] || entity.generation != entity.uuid+"@plugin:1" {
				t.Fatalf("generation identity collided: %+v", entity)
			}
			seen[entity.generation] = true
			for _, id := range []string{entity.uuid, entity.generation} {
				series := e.History(id, nil, time.Minute, at)
				if series.Entity != id || len(series.Points) != 1 || series.Points[0].Values["gpu_activity"] != float64(index+1) {
					t.Fatalf("history did not round-trip %q: %+v", id, series)
				}
				aligned := e.AlignedHistory([]history.SeriesDescriptor{{Key: "resource", Entity: id}}, time.Minute, 100, at)
				if aligned.Series[0].Entity != id || len(aligned.Points) != 1 || aligned.Points[0].Values["resource"]["gpu_activity"] != float64(index+1) {
					t.Fatalf("aligned history mixed resources: %+v", aligned)
				}
			}
		}
	}
	// Explicit references still compare the source generation, not its public
	// history identity; both physical GPUs and compute instances can be targets.
	allocation := pluginEvent("jobs", v1.Allocations, at, at)
	allocation.Observation.Allocations = &v1.AllocationData{Workloads: []model.WorkloadAttribution{{Ref: "job", Name: "Job", Platform: "batch", Kind: "job"}}, Assignments: []v1.Assignment{
		{WorkloadRef: "job", Resource: v1.ResourceRef{InstanceID: "example", ID: "GPU-a", Generation: "1"}, EntityType: model.AllocationEntityPhysicalGPU, State: model.AllocationStateAllocated},
		{WorkloadRef: "job", Resource: v1.ResourceRef{InstanceID: "example", ID: "GPU-b/ci", Generation: "1"}, EntityType: model.AllocationEntityComputeInstance, State: model.AllocationStateAllocated},
	}}
	e.AcceptObservation(allocation)
	snapshot, _ = e.Current()
	if len(snapshot.Attribution.Assignments) != 2 {
		t.Fatalf("raw generation references stopped matching: %+v", snapshot.Attribution)
	}
	if pluginGeneration("example/a", false, "1@plugin:/ +") != "example/a@plugin:1%40plugin%3A%2F+%2B" {
		t.Fatal("generation suffix is ambiguous")
	}
	replacement := gpuPluginEvent("example", "GPU-a", at.Add(time.Second))
	replacement.Observation.Revision = 2
	replacement.Observation.GPU.GPUs[0].Generation = "2"
	e.AcceptObservation(replacement)
	current := e.History("example/GPU-a", nil, time.Minute, replacement.At)
	previous := e.History("example/GPU-a@plugin:1", nil, time.Minute, replacement.At)
	if len(current.Points) != 1 || current.Points[0].Values["gpu_activity"] != 25 || len(previous.Points) != 1 || previous.Points[0].Values["gpu_activity"] != 1 {
		t.Fatalf("replacement mixed resource generations: current=%+v previous=%+v", current.Points, previous.Points)
	}
}

func TestIndependentCapabilityMetadataUsesNewestSameOwnerIdentity(t *testing.T) {
	at := time.Now().UTC()
	for _, inventoryDelay := range []time.Duration{0, time.Second, -time.Second} {
		e := pluginTestEngine(t)
		allocation := pluginEvent("jobs", v1.Allocations, at, at)
		allocation.Observation.Allocations = &v1.AllocationData{Workloads: []model.WorkloadAttribution{{Ref: "job", Name: "Allocation label", Platform: "batch", Kind: "job"}}}
		inventory := pluginEvent("jobs", v1.WorkloadInventory, at.Add(inventoryDelay), at)
		inventory.Observation.WorkloadInventory = &v1.InventoryData{Workloads: []model.WorkloadAttribution{{Ref: "job", Name: "Inventory label", Platform: "batch", Kind: "job"}}}
		e.AcceptObservation(inventory)
		e.AcceptObservation(allocation)
		snapshot, _ := e.Current()
		want := "Inventory label"
		if inventoryDelay < 0 {
			want = "Allocation label"
		}
		if len(snapshot.Attribution.Workloads) != 1 || snapshot.Attribution.Workloads[0].Name != want || hasPluginDiagnostic(snapshot, "plugin_identity_conflict") {
			t.Fatalf("same-owner metadata discarded: %+v", snapshot.Attribution)
		}
	}
	e := pluginTestEngine(t)
	for _, id := range []string{"first", "second"} {
		inventory := pluginEvent(id, v1.WorkloadInventory, at, at)
		inventory.Native = true
		inventory.Observation.WorkloadInventory = &v1.InventoryData{Workloads: []model.WorkloadAttribution{{Ref: "job", Name: "Job", Platform: "batch", Kind: "job"}}}
		e.AcceptObservation(inventory)
	}
	snapshot, _ := e.Current()
	if len(snapshot.Attribution.Workloads) != 0 || !hasPluginDiagnostic(snapshot, "plugin_identity_conflict") {
		t.Fatal("cross-owner identity conflict was accepted")
	}
}

func TestCachedRecoveryDoesNotDuplicateHistoryAndRecoversHealth(t *testing.T) {
	at := time.Now().UTC()
	e := pluginTestEngine(t)
	event := gpuPluginEvent("sensor", "GPU-a", at)
	e.AcceptObservation(event)
	e.AcceptObservation(plugins.Event{InstanceID: "sensor", Capability: v1.GPU, At: at.Add(time.Second), Interval: time.Second, Err: errors.New("temporary read failure")})
	failed, _ := e.Current()
	if failed.Capabilities.GPU.Available {
		t.Fatal("failed read did not mark GPU unavailable")
	}
	event.At = at.Add(2 * time.Second)
	e.AcceptObservation(event)
	series := e.History("sensor/GPU-a", nil, time.Minute, event.At)
	if len(series.Points) != 2 || series.Points[0].Values["gpu_activity"] != 25 || len(series.Points[1].Values) != 0 {
		t.Fatalf("recovery duplicated a source measurement or erased the outage: %+v", series.Points)
	}
	if e.HealthObservation().GPU.State != health.Operational {
		t.Fatalf("cached recovery left failed health: %+v", e.HealthObservation().GPU)
	}
	next := gpuPluginEvent("sensor", "GPU-a", at.Add(3*time.Second))
	next.Observation.Revision = 2
	e.AcceptObservation(next)
	series = e.History("sensor/GPU-a", nil, time.Minute, next.At)
	if len(series.Points) != 3 || series.Points[2].Values["gpu_activity"] != 25 {
		t.Fatalf("fresh recovery sample missing: %+v", series.Points)
	}
}

func TestPluginProvidersKeepHealthyStatesAndExcludeConflictedGPUs(t *testing.T) {
	at := time.Now().UTC()
	e := pluginTestEngine(t)
	first := gpuPluginEvent("a", "shared", at)
	first.Observation.GPU.Capabilities.NVML = model.ProviderState{Name: "NVML", Available: true, Status: model.StatusAvailable}
	e.AcceptObservation(first)
	empty := gpuPluginEvent("b", "other", at)
	empty.Native = true
	e.AcceptObservation(empty)
	current, _ := e.Current()
	if !current.Capabilities.NVML.Available {
		t.Fatal("empty provider group erased healthy provider")
	}
	// The only accepted GPU becomes stale; the fresh GPU is conflicted and
	// must not make the aggregate GPU capability available.
	e.AcceptObservation(gpuPluginEvent("c", "shared", at.Add(4*time.Second)))
	current, _ = e.Current()
	if len(current.GPUs) != 1 || current.Capabilities.GPU.Available || current.Capabilities.GPU.Status != model.StatusStale {
		t.Fatalf("conflicted hardware counted as healthy: %+v", current.Capabilities.GPU)
	}
	unavailable := model.ProviderState{Name: "DCGM", Status: model.StatusUnsupported}
	available := model.ProviderState{Name: "DCGM", Status: model.StatusAvailable, Available: true}
	if mergePluginProvider(unavailable, available) != available || mergePluginProvider(available, unavailable) != available {
		t.Fatal("provider availability depends on source order")
	}
}
