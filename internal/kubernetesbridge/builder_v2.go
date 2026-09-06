package kubernetesbridge

import (
	"sort"
	"strings"

	"github.com/intellisys-stevens/leviathan/internal/attribution"
	"github.com/intellisys-stevens/leviathan/internal/model"
	corev1 "k8s.io/api/core/v1"
	resourcev1 "k8s.io/api/resource/v1"
)

type InventoryV2 struct {
	Workloads     []model.WorkloadAttribution
	Assignments   []model.ResourceAssignment
	ProcessScopes []attribution.ProcessScope
	Bindings      []attribution.DynamicBinding
	Resolution    model.AttributionResolution
}

type inventoryDevice struct{ uuid, kind, parent, profile string }

// V2 keeps abstract dynamic MIG allocations separate from concrete UUIDs.
// Incomplete newest generations never silently fall back to an older pool.
func BuildInventoryV2(claims []*resourcev1.ResourceClaim, slices []*resourcev1.ResourceSlice, nodeName, driver string) InventoryV2 {
	out := InventoryV2{
		Workloads: []model.WorkloadAttribution{}, Assignments: []model.ResourceAssignment{},
		ProcessScopes: []attribution.ProcessScope{}, Bindings: []attribution.DynamicBinding{},
		Resolution: attribution.CompleteResolution(),
	}
	pools := make(map[string][]*resourcev1.ResourceSlice)
	generations := make(map[string]int64)
	for _, s := range slices {
		if s == nil || s.Spec.Driver != driver || s.Spec.NodeName == nil || *s.Spec.NodeName != nodeName {
			continue
		}
		name := s.Spec.Pool.Name
		g, exists := generations[name]
		if !exists || s.Spec.Pool.Generation > g {
			generations[name] = s.Spec.Pool.Generation
			pools[name] = nil
		}
		if s.Spec.Pool.Generation == generations[name] {
			pools[name] = append(pools[name], s)
		}
	}
	if len(pools) == 0 {
		attribution.AddResolutionIssue(&out.Resolution, "", "inventory_incomplete", 0)
	}
	devices := make(map[deviceKey]inventoryDevice)
	for pool, parts := range pools {
		complete := len(parts) > 0
		names := make(map[string]bool)
		for _, s := range parts {
			if s.Spec.Pool.ResourceSliceCount != int64(len(parts)) || names[s.Name] {
				complete = false
			}
			names[s.Name] = true
		}
		if !complete {
			attribution.AddResolutionIssue(&out.Resolution, "", "inventory_incomplete", 0)
			continue
		}
		duplicates := make(map[deviceKey]bool)
		for _, s := range parts {
			for _, d := range s.Spec.Devices {
				key := deviceKey{driver: driver, pool: pool, device: d.Name}
				if _, exists := devices[key]; exists {
					duplicates[key] = true
				}
				uuid, _ := stringAttribute(d, driver, "uuid")
				kind, _ := stringAttribute(d, driver, "type")
				parent, _ := stringAttribute(d, driver, "parentUUID")
				profile, _ := stringAttribute(d, driver, "profile")
				devices[key] = inventoryDevice{uuid: uuid, kind: kind, parent: parent, profile: profile}
			}
		}
		for key := range duplicates {
			delete(devices, key)
			attribution.AddResolutionIssue(&out.Resolution, "", "inventory_incomplete", 0)
		}
	}
	workloads := make(map[string]model.WorkloadAttribution)
	conflicts := make(map[string]bool)
	assignments := make(map[string]model.ResourceAssignment)
	bindings := make(map[string]attribution.DynamicBinding)
	bindingConflicts := make(map[string]bool)
	scopes := make(map[string]string)
	ambiguousScopes := make(map[string]bool)
	sorted := append([]*resourcev1.ResourceClaim{}, claims...)
	sort.SliceStable(sorted, func(i, j int) bool {
		if sorted[i] == nil {
			return false
		}
		if sorted[j] == nil {
			return true
		}
		return sorted[i].Namespace+"/"+sorted[i].Name < sorted[j].Namespace+"/"+sorted[j].Name
	})
	for _, c := range sorted {
		if c == nil || c.Status.Allocation == nil || definitelyRemote(c, nodeName) {
			continue
		}
		results := []resourcev1.DeviceRequestAllocationResult{}
		for _, r := range c.Status.Allocation.Devices.Results {
			if r.Driver == driver {
				results = append(results, r)
			}
		}
		if len(results) == 0 {
			continue
		}
		id, name, owner := strings.TrimSpace(c.Labels[LabelCoderWorkspaceID]), strings.TrimSpace(c.Labels[LabelCoderWorkspaceName]), strings.TrimSpace(c.Labels[LabelCoderUsername])
		if c.Labels[LabelCoderResource] != "true" || !safeDisplay(id, 253) || !safeDisplay(name, 253) || !safeDisplay(owner, 128) {
			attribution.AddResolutionIssue(&out.Resolution, "", "invalid_identity", len(results))
			continue
		}
		ref := HashRef("workspace_", id)
		w := model.WorkloadAttribution{Ref: ref, Platform: model.WorkloadPlatformCoder, Kind: model.WorkloadKindWorkspace, Name: name, OwnerName: owner}
		if previous, exists := workloads[ref]; exists && previous != w {
			conflicts[ref] = true
		}
		workloads[ref] = w
		state := model.AllocationStateReserved
		if len(c.Status.ReservedFor) > 0 {
			state = model.AllocationStateAllocated
		}
		localClaim := false
		for _, r := range results {
			d, found := devices[deviceKey{driver: r.Driver, pool: r.Pool, device: r.Device}]
			if !found || (r.AdminAccess != nil && *r.AdminAccess) || r.ShareID != nil {
				attribution.AddResolutionIssue(&out.Resolution, ref, "allocation_unresolved", 1)
				continue
			}
			localClaim = true
			if (d.kind == "gpu" && strings.HasPrefix(d.uuid, "GPU-")) || (d.kind == "mig" && strings.HasPrefix(d.uuid, "MIG-")) {
				entity := model.AllocationEntityPhysicalGPU
				if d.kind == "mig" {
					entity = model.AllocationEntityComputeInstance
				}
				a := model.ResourceAssignment{WorkloadRef: ref, EntityType: entity, EntityUUID: d.uuid, State: state}
				key := ref + "\x00" + string(entity) + "\x00" + d.uuid
				if previous, exists := assignments[key]; !exists || previous.State == model.AllocationStateReserved {
					assignments[key] = a
				}
				continue
			}
			claimRef, validClaim := attribution.ClaimRef(string(c.UID))
			if d.kind == "mig" && d.uuid == "" && strings.HasPrefix(d.parent, "GPU-") && d.profile != "" && validClaim {
				key := attribution.AllocationRef(string(c.UID), r.Request, r.Driver, r.Pool, r.Device)
				b := attribution.DynamicBinding{Ref: key, ClaimRef: claimRef, WorkloadRef: ref, ParentGPUUUID: d.parent, Profile: d.profile, State: state}
				if old, exists := bindings[key]; bindingConflicts[key] || (exists && old != b) {
					delete(bindings, key)
					bindingConflicts[key] = true
					attribution.AddResolutionIssue(&out.Resolution, ref, "assignment_conflict", 1)
				} else {
					bindings[key] = b
				}
				continue
			}
			attribution.AddResolutionIssue(&out.Resolution, ref, "allocation_unresolved", 1)
		}
		if localClaim {
			for _, consumer := range c.Status.ReservedFor {
				if consumer.APIGroup != "" || consumer.Resource != "pods" {
					continue
				}
				scope, valid := attribution.ScopeRefForPodUID(string(consumer.UID))
				if !valid || ambiguousScopes[scope] {
					continue
				}
				if old, exists := scopes[scope]; exists && old != ref {
					delete(scopes, scope)
					ambiguousScopes[scope] = true
				} else {
					scopes[scope] = ref
				}
			}
		}
	}
	for ref := range conflicts {
		delete(workloads, ref)
		attribution.AddResolutionIssue(&out.Resolution, "", "assignment_conflict", 0)
	}
	for ref, w := range workloads {
		if !conflicts[ref] {
			out.Workloads = append(out.Workloads, w)
		}
	}
	for _, a := range assignments {
		if conflicts[a.WorkloadRef] {
			attribution.AddResolutionIssue(&out.Resolution, "", "assignment_conflict", 1)
		} else {
			out.Assignments = append(out.Assignments, a)
		}
	}
	for _, b := range bindings {
		if conflicts[b.WorkloadRef] {
			attribution.AddResolutionIssue(&out.Resolution, "", "assignment_conflict", 1)
		} else {
			out.Bindings = append(out.Bindings, b)
		}
	}
	for scope, ref := range scopes {
		if !conflicts[ref] {
			out.ProcessScopes = append(out.ProcessScopes, attribution.ProcessScope{ScopeRef: scope, WorkloadRef: ref})
		}
	}
	filtered := out.Resolution.Workloads[:0]
	for _, r := range out.Resolution.Workloads {
		if !conflicts[r.WorkloadRef] {
			filtered = append(filtered, r)
		}
	}
	out.Resolution.Workloads = filtered
	sort.Slice(out.Workloads, func(i, j int) bool { return out.Workloads[i].Ref < out.Workloads[j].Ref })
	sort.Slice(out.Assignments, func(i, j int) bool {
		a, b := out.Assignments[i], out.Assignments[j]
		return a.WorkloadRef+string(a.EntityType)+a.EntityUUID < b.WorkloadRef+string(b.EntityType)+b.EntityUUID
	})
	sort.Slice(out.Bindings, func(i, j int) bool { return out.Bindings[i].Ref < out.Bindings[j].Ref })
	sort.Slice(out.ProcessScopes, func(i, j int) bool { return out.ProcessScopes[i].ScopeRef < out.ProcessScopes[j].ScopeRef })
	if len(out.Workloads) > attribution.MaxWorkloads || len(out.Assignments)+len(out.Bindings) > attribution.MaxAssignments || len(out.ProcessScopes) > attribution.MaxProcessScopes || out.Resolution.UnresolvedAssignments > attribution.MaxAssignments {
		out = InventoryV2{Workloads: []model.WorkloadAttribution{}, Assignments: []model.ResourceAssignment{}, Bindings: []attribution.DynamicBinding{}, ProcessScopes: []attribution.ProcessScope{}, Resolution: attribution.CompleteResolution()}
		attribution.AddResolutionIssue(&out.Resolution, "", "inventory_incomplete", 0)
	}
	return out
}

// Only a definitive metadata.name exclusion proves this claim belongs elsewhere.
// Unresolvable potentially local claims must not establish free capacity.
func definitelyRemote(c *resourcev1.ResourceClaim, node string) bool {
	selector := c.Status.Allocation.NodeSelector
	if selector == nil || len(selector.NodeSelectorTerms) == 0 {
		return false
	}
	for _, term := range selector.NodeSelectorTerms {
		excluded := false
		for _, field := range term.MatchFields {
			if field.Key != "metadata.name" {
				continue
			}
			contains := false
			for _, value := range field.Values {
				if value == node {
					contains = true
				}
			}
			if (field.Operator == corev1.NodeSelectorOpIn && !contains) || (field.Operator == corev1.NodeSelectorOpNotIn && contains) {
				excluded = true
			}
		}
		if !excluded {
			return false
		}
	}
	return true
}
