package kubernetesbridge

import (
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/intellisys-stevens/leviathan/adapters/kubernetes/attribution"
	"github.com/intellisys-stevens/leviathan/model"
	plugin "github.com/intellisys-stevens/leviathan/plugin/v1"
)

func TestPluginBridgePreservesStaticAssignmentsAndMarksDynamicIncomplete(t *testing.T) {
	now := time.Now().UTC()
	state := NewState("test", "node", now)
	workload := model.WorkloadAttribution{Ref: "workspace_00000000000000000000000000000001", Platform: "coder", Kind: "workspace", Name: "Workspace", OwnerName: "Owner"}
	assignment := model.ResourceAssignment{WorkloadRef: workload.Ref, EntityType: model.AllocationEntityPhysicalGPU, EntityUUID: "GPU-1", State: model.AllocationStateAllocated}
	state.UpdateInventories([]model.WorkloadAttribution{workload}, []model.ResourceAssignment{assignment}, nil, BuildStats{}, InventoryV2{Workloads: []model.WorkloadAttribution{workload}, Assignments: []model.ResourceAssignment{assignment}, Bindings: []attribution.DynamicBinding{{WorkloadRef: workload.Ref, ParentGPUUUID: "GPU-1", Profile: "1g.10gb"}}, Resolution: attribution.CompleteResolution()}, now)
	server := NewServer(state).WithPluginIdentity("bridge-a", "gpu-host")
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, httptest.NewRequest("GET", plugin.ObservationPath+string(plugin.Allocations), nil))
	if response.Code != 200 {
		t.Fatalf("status %d: %s", response.Code, response.Body.String())
	}
	var observed plugin.Observation
	if err := json.Unmarshal(response.Body.Bytes(), &observed); err != nil {
		t.Fatal(err)
	}
	if err := observed.ValidateAt(now); err != nil {
		t.Fatal(err)
	}
	if observed.InstanceID != "bridge-a" || observed.Allocations.Assignments[0].Resource.InstanceID != "gpu-host" || !observed.ObservedAt.Equal(now) {
		t.Fatalf("identity/freshness = %+v", observed)
	}
	if observed.Allocations.Resolution.Status == "complete" || observed.Allocations.Resolution.UnresolvedAssignments != 1 {
		t.Fatalf("dynamic binding falsely complete: %+v", observed.Allocations.Resolution)
	}
}

func TestPluginBridgeCapacityDoesNotRenewCachedFreshness(t *testing.T) {
	now := time.Now().UTC()
	old := now.Add(-20 * time.Second)
	memory, count := int64(1024), int64(1)
	capacity := NewCapacityState()
	capacity.document = model.GPUCapacityDocument{Status: "available", ObservedAt: &old, Rows: []model.GPUCapacityRow{{ID: "capacity_00000000000000000000000000000001", Mode: "native", Model: "Synthetic", MemoryBytes: &memory, Available: &count, Status: "available"}}}
	server := NewServer(NewState("test", "node", now)).WithGPUCapacity(capacity)
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, httptest.NewRequest("GET", plugin.ObservationPath+string(plugin.GPUCapacity), nil))
	if response.Code != 200 {
		t.Fatalf("status %d: %s", response.Code, response.Body.String())
	}
	var observed plugin.Observation
	if err := json.Unmarshal(response.Body.Bytes(), &observed); err != nil {
		t.Fatal(err)
	}
	if observed.Status != "stale" || observed.GPUCapacity.Rows[0].Available != nil || !observed.ObservedAt.Equal(old) {
		t.Fatalf("stale capacity = %+v", observed)
	}
}
