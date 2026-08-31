package kubernetesbridge

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/intellisys-stevens/leviathan/internal/attribution"
	"github.com/intellisys-stevens/leviathan/internal/model"
	resourcev1 "k8s.io/api/resource/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func TestBuildInventoryJoinsExactNodeLocalDRAIdentity(t *testing.T) {
	node := "synthetic-node"
	slices := []*resourcev1.ResourceSlice{
		resourceSlice(node, "gpu.nvidia.com", "pool-a", 1, 1,
			device("shared-name", "MIG-synthetic-a", "mig"),
			device("whole", "GPU-synthetic-a", "gpu")),
		resourceSlice(node, "gpu.nvidia.com", "pool-b", 1, 1,
			device("shared-name", "MIG-synthetic-b", "mig")),
		resourceSlice("other-node", "gpu.nvidia.com", "pool-c", 1, 1,
			device("remote", "MIG-synthetic-remote", "mig")),
		resourceSlice(node, "other.example", "pool-d", 1, 1,
			device("foreign", "MIG-synthetic-foreign", "mig")),
	}
	claim := resourceClaim("workspace-upstream-identifier", "synthetic-workspace", "synthetic-owner", true,
		allocation("gpu.nvidia.com", "pool-a", "shared-name"),
		allocation("gpu.nvidia.com", "pool-a", "whole"),
		allocation("gpu.nvidia.com", "pool-b", "shared-name"),
		allocation("gpu.nvidia.com", "pool-c", "remote"))
	workloads, assignments, processScopes, stats := BuildInventory([]*resourcev1.ResourceClaim{claim}, slices, node, "gpu.nvidia.com")
	if len(workloads) != 1 || len(assignments) != 3 || stats.UnresolvedDevices != 1 {
		t.Fatalf("inventory workloads=%+v assignments=%+v stats=%+v", workloads, assignments, stats)
	}
	if workloads[0].Ref == "workspace-upstream-identifier" || !strings.HasPrefix(workloads[0].Ref, "workspace_") || workloads[0].Kind != model.WorkloadKindWorkspace {
		t.Fatalf("workspace reference was not hashed: %+v", workloads[0])
	}
	types := map[string]model.AllocationEntityType{}
	for _, assigned := range assignments {
		types[assigned.EntityUUID] = assigned.EntityType
		if assigned.State != model.AllocationStateAllocated {
			t.Fatalf("consumed claim state = %q", assigned.State)
		}
	}
	if types["MIG-synthetic-a"] != model.AllocationEntityComputeInstance || types["MIG-synthetic-b"] != model.AllocationEntityComputeInstance || types["GPU-synthetic-a"] != model.AllocationEntityPhysicalGPU {
		t.Fatalf("resolved entity types = %+v", types)
	}
	if len(processScopes) != 1 || processScopes[0].WorkloadRef != workloads[0].Ref {
		t.Fatalf("process scopes = %+v", processScopes)
	}
	payload, err := json.Marshal(struct {
		Workloads   []model.WorkloadAttribution
		Assignments []model.ResourceAssignment
	}{workloads, assignments})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(payload), "workspace-upstream-identifier") {
		t.Fatal("upstream workspace ID leaked into bridge inventory")
	}
}

func TestBuildInventoryMarksAllocationWithoutConsumerReserved(t *testing.T) {
	node := "synthetic-node"
	slices := []*resourcev1.ResourceSlice{
		resourceSlice(node, "gpu.nvidia.com", "pool", 1, 1,
			device("device", "MIG-synthetic-reserved", "mig")),
	}
	claim := resourceClaim("workspace", "workspace", "owner", false,
		allocation("gpu.nvidia.com", "pool", "device"))
	_, assignments, _, _ := BuildInventory([]*resourcev1.ResourceClaim{claim}, slices, node, "gpu.nvidia.com")
	if len(assignments) != 1 || assignments[0].State != model.AllocationStateReserved {
		t.Fatalf("unconsumed allocation = %+v, want reserved", assignments)
	}
}

func TestBuildInventoryPrefersAllocatedDuplicateInEitherOrder(t *testing.T) {
	node := "synthetic-node"
	slices := []*resourcev1.ResourceSlice{
		resourceSlice(node, "gpu.nvidia.com", "pool", 1, 1, device("device", "MIG-synthetic-duplicate", "mig")),
	}
	for _, allocatedFirst := range []bool{true, false} {
		name := "allocated-last"
		if allocatedFirst {
			name = "allocated-first"
		}
		t.Run(name, func(t *testing.T) {
			reserved := resourceClaim("workspace", "workspace", "owner", false, allocation("gpu.nvidia.com", "pool", "device"))
			allocated := resourceClaim("workspace", "workspace", "owner", true, allocation("gpu.nvidia.com", "pool", "device"))
			if allocatedFirst {
				allocated.Name, reserved.Name = "a-allocated", "z-reserved"
			} else {
				reserved.Name, allocated.Name = "a-reserved", "z-allocated"
			}
			_, assignments, _, _ := BuildInventory([]*resourcev1.ResourceClaim{reserved, allocated}, slices, node, "gpu.nvidia.com")
			if len(assignments) != 1 || assignments[0].State != model.AllocationStateAllocated {
				t.Fatalf("deduplicated assignments = %+v", assignments)
			}
		})
	}
}

func TestBuildInventoryRejectsIncompletePoolAndInvalidIdentity(t *testing.T) {
	node := "synthetic-node"
	slices := []*resourcev1.ResourceSlice{
		resourceSlice(node, "gpu.nvidia.com", "incomplete", 4, 2,
			device("one", "MIG-synthetic-one", "mig")),
	}
	valid := resourceClaim("workspace-one", "workspace", "owner", false,
		allocation("gpu.nvidia.com", "incomplete", "one"))
	invalid := resourceClaim("workspace-two", "bad\nname", "owner", false,
		allocation("gpu.nvidia.com", "incomplete", "one"))
	workloads, assignments, _, stats := BuildInventory([]*resourcev1.ResourceClaim{valid, invalid}, slices, node, "gpu.nvidia.com")
	if len(workloads) != 0 || len(assignments) != 0 || stats.IncompletePools != 1 || stats.InvalidClaims != 1 {
		t.Fatalf("incomplete inventory workloads=%+v assignments=%+v stats=%+v", workloads, assignments, stats)
	}
}

func TestBuildInventoryPrefersLatestCompletePoolGeneration(t *testing.T) {
	node := "synthetic-node"
	slices := []*resourcev1.ResourceSlice{
		resourceSlice(node, "gpu.nvidia.com", "pool", 1, 1, device("device", "MIG-synthetic-old", "mig")),
		resourceSlice(node, "gpu.nvidia.com", "pool", 2, 2, device("device", "MIG-synthetic-incomplete", "mig")),
	}
	claim := resourceClaim("workspace", "workspace", "owner", false, allocation("gpu.nvidia.com", "pool", "device"))
	_, assignments, _, _ := BuildInventory([]*resourcev1.ResourceClaim{claim}, slices, node, "gpu.nvidia.com")
	if len(assignments) != 1 || assignments[0].EntityUUID != "MIG-synthetic-old" {
		t.Fatalf("assignment from latest complete generation = %+v", assignments)
	}
}

func TestBuildInventoryOmitsPendingAndAmbiguousAssignments(t *testing.T) {
	node := "synthetic-node"
	first := resourceSlice(node, "gpu.nvidia.com", "pool", 1, 2, device("duplicate", "MIG-synthetic-one", "mig"))
	second := resourceSlice(node, "gpu.nvidia.com", "pool", 1, 2, device("duplicate", "MIG-synthetic-two", "mig"))
	second.Name = "synthetic-slice-two"
	claim := resourceClaim("workspace", "workspace", "owner", false, allocation("gpu.nvidia.com", "pool", "duplicate"))
	pending := resourceClaim("pending", "pending", "owner", false)
	pending.Status.Allocation = nil

	workloads, assignments, _, stats := BuildInventory([]*resourcev1.ResourceClaim{claim, pending}, []*resourcev1.ResourceSlice{first, second}, node, "gpu.nvidia.com")
	if len(workloads) != 0 || len(assignments) != 0 || stats.PendingClaims != 1 || stats.UnresolvedDevices != 1 {
		t.Fatalf("ambiguous inventory workloads=%+v assignments=%+v stats=%+v", workloads, assignments, stats)
	}
}

func TestBuildInventoryBuildsOpaqueProcessScopesWithoutRawPodIdentity(t *testing.T) {
	node := "synthetic-node"
	slices := []*resourcev1.ResourceSlice{
		resourceSlice(node, "gpu.nvidia.com", "pool", 1, 1, device("device", "MIG-synthetic-process", "mig")),
	}
	claim := resourceClaim("workspace", "workspace", "owner", true, allocation("gpu.nvidia.com", "pool", "device"))
	const podUID = "12345678-1234-4000-8000-123456789abc"
	claim.Status.ReservedFor[0].UID = podUID
	workloads, _, processScopes, stats := BuildInventory([]*resourcev1.ResourceClaim{claim}, slices, node, "gpu.nvidia.com")
	wantScopeRef, _ := attribution.ScopeRefForPodUID(podUID)
	if len(workloads) != 1 || len(processScopes) != 1 || processScopes[0].ScopeRef != wantScopeRef || processScopes[0].WorkloadRef != workloads[0].Ref || stats.ProcessScopes != 1 {
		t.Fatalf("process attribution workloads=%+v scopes=%+v stats=%+v", workloads, processScopes, stats)
	}
	payload, err := json.Marshal(processScopes)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(payload), podUID) || strings.Contains(string(payload), claim.Status.ReservedFor[0].Name) {
		t.Fatalf("raw Kubernetes identity leaked into process scopes: %s", payload)
	}
}

func TestBuildInventoryDeduplicatesAndOmitsAmbiguousProcessScopes(t *testing.T) {
	node := "synthetic-node"
	slices := []*resourcev1.ResourceSlice{
		resourceSlice(node, "gpu.nvidia.com", "pool", 1, 1, device("device", "MIG-synthetic-process", "mig")),
	}
	first := resourceClaim("workspace-one", "one", "owner-one", true, allocation("gpu.nvidia.com", "pool", "device"))
	duplicate := resourceClaim("workspace-one", "one", "owner-one", true, allocation("gpu.nvidia.com", "pool", "device"))
	_, _, processScopes, stats := BuildInventory([]*resourcev1.ResourceClaim{first, duplicate}, slices, node, "gpu.nvidia.com")
	if len(processScopes) != 1 || stats.AmbiguousProcessScopes != 0 {
		t.Fatalf("deduplicated process scopes=%+v stats=%+v", processScopes, stats)
	}

	conflict := resourceClaim("workspace-two", "two", "owner-two", true, allocation("gpu.nvidia.com", "pool", "device"))
	_, _, processScopes, stats = BuildInventory([]*resourcev1.ResourceClaim{first, conflict}, slices, node, "gpu.nvidia.com")
	if len(processScopes) != 0 || stats.AmbiguousProcessScopes != 1 {
		t.Fatalf("ambiguous process scopes=%+v stats=%+v", processScopes, stats)
	}
}

func TestBuildInventoryIgnoresInvalidAndNonPodConsumers(t *testing.T) {
	node := "synthetic-node"
	slices := []*resourcev1.ResourceSlice{
		resourceSlice(node, "gpu.nvidia.com", "pool", 1, 1, device("device", "MIG-synthetic-process", "mig")),
	}
	claim := resourceClaim("workspace", "workspace", "owner", true, allocation("gpu.nvidia.com", "pool", "device"))
	claim.Status.ReservedFor = append(claim.Status.ReservedFor,
		resourcev1.ResourceClaimConsumerReference{APIGroup: "apps", Resource: "pods", Name: "not-core", UID: "12345678-1234-4000-8000-123456789abc"},
		resourcev1.ResourceClaimConsumerReference{Resource: "pods", Name: "invalid", UID: "raw-upstream-uid"},
	)
	_, _, processScopes, stats := BuildInventory([]*resourcev1.ResourceClaim{claim}, slices, node, "gpu.nvidia.com")
	if len(processScopes) != 1 || stats.InvalidConsumers != 2 {
		t.Fatalf("filtered process scopes=%+v stats=%+v", processScopes, stats)
	}
}

func resourceSlice(node, driver, pool string, generation, count int64, devices ...resourcev1.Device) *resourcev1.ResourceSlice {
	return &resourcev1.ResourceSlice{
		ObjectMeta: metav1.ObjectMeta{Name: "synthetic-" + HashRef("", node+driver+pool+string(rune(generation)))},
		Spec: resourcev1.ResourceSliceSpec{
			Driver: driver, Pool: resourcev1.ResourcePool{Name: pool, Generation: generation, ResourceSliceCount: count},
			NodeName: &node, Devices: devices,
		},
	}
}

func device(name, uuid, kind string) resourcev1.Device {
	return resourcev1.Device{
		Name: name,
		Attributes: map[resourcev1.QualifiedName]resourcev1.DeviceAttribute{
			"uuid": {StringValue: &uuid}, "type": {StringValue: &kind},
		},
	}
}

func allocation(driver, pool, name string) resourcev1.DeviceRequestAllocationResult {
	return resourcev1.DeviceRequestAllocationResult{Request: "synthetic", Driver: driver, Pool: pool, Device: name}
}

func resourceClaim(workspaceID, workspaceName, username string, reserved bool, allocations ...resourcev1.DeviceRequestAllocationResult) *resourcev1.ResourceClaim {
	claim := &resourcev1.ResourceClaim{
		ObjectMeta: metav1.ObjectMeta{
			Name: "synthetic-claim-" + HashRef("", workspaceID), Namespace: "synthetic-workspaces",
			Labels: map[string]string{
				LabelCoderResource: "true", LabelCoderWorkspaceID: workspaceID,
				LabelCoderWorkspaceName: workspaceName, LabelCoderUsername: username,
			},
		},
		Status: resourcev1.ResourceClaimStatus{Allocation: &resourcev1.AllocationResult{Devices: resourcev1.DeviceAllocationResult{Results: allocations}}},
	}
	if reserved {
		claim.Status.ReservedFor = []resourcev1.ResourceClaimConsumerReference{{Resource: "pods", Name: "synthetic-pod", UID: "00000000-0000-0000-0000-000000000001"}}
	}
	return claim
}
