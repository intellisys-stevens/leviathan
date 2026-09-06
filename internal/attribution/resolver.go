package attribution

import (
	"fmt"
	"sort"
	"strings"

	"github.com/intellisys-stevens/leviathan/internal/model"
)

type bindingPin struct {
	UUID     string
	Epoch    uint64
	Replaced bool
}
type bindingResolver struct{ pins map[string]bindingPin }
type liveInstance struct{ UUID, Parent, Profile string }

func tupleKey(parent string, gi, ci uint32) string { return fmt.Sprintf("%s/%d/%d", parent, gi, ci) }

func (r *bindingResolver) resolve(value *model.Attribution, modern *DocumentV2, snapshot model.Snapshot, cp checkpointObservation) {
	if modern == nil || value.Status != model.AttributionAvailable {
		return
	}
	if r.pins == nil {
		r.pins = map[string]bindingPin{}
	}
	resolution := value.Resolution
	// A configured identity source losing coverage cannot prove that a just-
	// disappeared bridge allocation is free. Static-only installations may opt out.
	if cp.Reason != "" && cp.Reason != "checkpoint_disabled" {
		AddResolutionIssue(resolution, "", cp.Reason, 0)
	}
	live := map[string][]liveInstance{}
	known := map[string]bool{}
	parentByCI := map[string]string{}
	uuidTuples := map[string]string{}
	inconsistentTopology := false
	for _, gpu := range snapshot.GPUs {
		if known["physical_gpu/"+gpu.UUID] || (!gpu.MIGEnabled && len(gpu.GPUInstances) > 0) {
			inconsistentTopology = true
		}
		known["physical_gpu/"+gpu.UUID] = true
		for _, gi := range gpu.GPUInstances {
			for _, ci := range gi.ComputeInstances {
				if !strings.HasPrefix(ci.UUID, "MIG-") {
					continue
				}
				key := tupleKey(gpu.UUID, gi.ID, ci.ID)
				if previous, exists := uuidTuples[ci.UUID]; exists && previous != key {
					inconsistentTopology = true
				}
				uuidTuples[ci.UUID] = key
				live[key] = append(live[key], liveInstance{UUID: ci.UUID, Parent: gpu.UUID, Profile: gi.Profile})
				known["compute_instance/"+ci.UUID] = true
				parentByCI[ci.UUID] = gpu.UUID
			}
		}
	}
	topologyOK := !inconsistentTopology && snapshot.Capabilities.NVML.Available && snapshot.Capabilities.NVML.Status == model.StatusAvailable
	for _, d := range snapshot.Diagnostics {
		switch d.Code {
		case "gpu_handle", "gpu_uuid", "mig_mode", "mig_enumeration", "mig_handle", "mig_identity":
			topologyOK = false
		}
	}
	if !topologyOK {
		AddResolutionIssue(resolution, "", "topology_unavailable", 0)
	}
	direct := value.Assignments
	value.Assignments = []model.ResourceAssignment{}
	for _, a := range direct {
		if known[string(a.EntityType)+"/"+a.EntityUUID] {
			value.Assignments = append(value.Assignments, a)
		} else {
			AddResolutionIssue(resolution, a.WorkloadRef, "topology_mismatch", 1)
		}
	}
	expected := map[string]bool{}
	for _, b := range modern.Bindings {
		expected[b.Ref] = true
		fail := func(reason string) { AddResolutionIssue(resolution, b.WorkloadRef, reason, 1) }
		if cp.Reason != "" {
			fail(cp.Reason)
			continue
		}
		if !topologyOK {
			fail("topology_unavailable")
			continue
		}
		prepared, exists := cp.Entries[b.Ref]
		if !exists {
			fail("preparation_pending")
			continue
		}
		if prepared.ClaimRef != b.ClaimRef || prepared.ParentUUID != b.ParentGPUUUID {
			fail("binding_mismatch")
			continue
		}
		candidates := live[tupleKey(prepared.ParentUUID, prepared.GIID, prepared.CIID)]
		if len(candidates) != 1 {
			fail("topology_mismatch")
			continue
		}
		current := candidates[0]
		if current.Profile != b.Profile || (strings.HasPrefix(prepared.MIGUUID, "MIG-") && prepared.MIGUUID != current.UUID) {
			fail("binding_mismatch")
			continue
		}
		pin, pinned := r.pins[b.Ref]
		if pinned && pin.Epoch == prepared.Epoch && (pin.Replaced || pin.UUID != current.UUID) {
			pin.Replaced = true
			r.pins[b.Ref] = pin
			fail("binding_replaced")
			continue
		}
		r.pins[b.Ref] = bindingPin{UUID: current.UUID, Epoch: prepared.Epoch}
		value.Assignments = append(value.Assignments, model.ResourceAssignment{WorkloadRef: b.WorkloadRef, EntityType: model.AllocationEntityComputeInstance, EntityUUID: current.UUID, State: b.State})
	}
	// A successfully read checkpoint can precede the bridge's claim watch.
	// An unrecognized prepared MIG must not be declared free during that gap.
	if cp.Reason == "" {
		for ref, prepared := range cp.Entries {
			if expected[ref] {
				continue
			}
			accounted := false
			for _, a := range direct {
				if a.EntityType == model.AllocationEntityComputeInstance && a.EntityUUID == prepared.MIGUUID {
					accounted = true
				}
			}
			if !accounted {
				AddResolutionIssue(resolution, "", "binding_mismatch", 1)
			}
		}
	}
	// Pins remain while the bridge still asserts a binding; disk errors cannot
	// erase lifetime evidence. Both sources must observe removal before pruning.
	for ref := range r.pins {
		if _, prepared := cp.Entries[ref]; !expected[ref] && !prepared && cp.Reason == "" {
			delete(r.pins, ref)
		}
	}
	removeConflictingAssignments(value, parentByCI)
}

func removeConflictingAssignments(value *model.Attribution, parentByCI map[string]string) {
	owners := map[string]string{}
	conflicts := map[string]bool{}
	for _, a := range value.Assignments {
		key := string(a.EntityType) + "/" + a.EntityUUID
		if owner, exists := owners[key]; exists && owner != a.WorkloadRef {
			conflicts[key] = true
		}
		owners[key] = a.WorkloadRef
	}
	for _, a := range value.Assignments {
		if a.EntityType != model.AllocationEntityComputeInstance {
			continue
		}
		parent := "physical_gpu/" + parentByCI[a.EntityUUID]
		if owner, exists := owners[parent]; exists && owner != a.WorkloadRef {
			conflicts[parent] = true
			conflicts["compute_instance/"+a.EntityUUID] = true
		}
	}
	unique := map[string]model.ResourceAssignment{}
	for _, a := range value.Assignments {
		entity := string(a.EntityType) + "/" + a.EntityUUID
		if conflicts[entity] {
			AddResolutionIssue(value.Resolution, a.WorkloadRef, "assignment_conflict", 1)
			continue
		}
		key := a.WorkloadRef + "/" + entity
		if old, exists := unique[key]; !exists || old.State == model.AllocationStateReserved {
			unique[key] = a
		}
	}
	value.Assignments = []model.ResourceAssignment{}
	for _, a := range unique {
		value.Assignments = append(value.Assignments, a)
	}
	sort.Slice(value.Assignments, func(i, j int) bool {
		a, b := value.Assignments[i], value.Assignments[j]
		return a.WorkloadRef+string(a.EntityType)+a.EntityUUID < b.WorkloadRef+string(b.EntityType)+b.EntityUUID
	})
}
