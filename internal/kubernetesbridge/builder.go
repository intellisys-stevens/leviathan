// Package kubernetesbridge turns node-local Kubernetes DRA allocation state
// into the sanitized attribution handoff consumed by Leviathan.
package kubernetesbridge

import (
	"crypto/sha256"
	"encoding/hex"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/intellisys-stevens/leviathan/internal/attribution"
	"github.com/intellisys-stevens/leviathan/internal/model"
	resourcev1 "k8s.io/api/resource/v1"
)

const (
	LabelCoderResource      = "com.coder.resource"
	LabelCoderWorkspaceID   = "com.coder.workspace.id"
	LabelCoderWorkspaceName = "com.coder.workspace.name"
	LabelCoderUsername      = "com.coder.user.username"
)

type BuildStats struct {
	Claims                 int
	PendingClaims          int
	MatchedAllocations     int
	ProcessScopes          int
	AmbiguousProcessScopes int
	InvalidConsumers       int
	UnresolvedDevices      int
	InvalidClaims          int
	IncompletePools        int
}

type deviceKey struct {
	driver string
	pool   string
	device string
}

type resolvedDevice struct {
	uuid       string
	entityType model.AllocationEntityType
}

type poolKey struct {
	driver string
	pool   string
}

type poolGeneration struct {
	expected int64
	slices   []*resourcev1.ResourceSlice
}

func BuildInventory(claims []*resourcev1.ResourceClaim, slices []*resourcev1.ResourceSlice, nodeName, driver string) ([]model.WorkloadAttribution, []model.ResourceAssignment, []attribution.ProcessScope, BuildStats) {
	stats := BuildStats{Claims: len(claims)}
	devices, incomplete := indexDevices(slices, nodeName, driver)
	stats.IncompletePools = incomplete

	sortedClaims := append([]*resourcev1.ResourceClaim(nil), claims...)
	sort.SliceStable(sortedClaims, func(i, j int) bool {
		if sortedClaims[i] == nil {
			return false
		}
		if sortedClaims[j] == nil {
			return true
		}
		if sortedClaims[i].Namespace == sortedClaims[j].Namespace {
			return sortedClaims[i].Name < sortedClaims[j].Name
		}
		return sortedClaims[i].Namespace < sortedClaims[j].Namespace
	})
	workloadByRef := make(map[string]model.WorkloadAttribution)
	assignmentByKey := make(map[string]model.ResourceAssignment)
	processScopeByRef := make(map[string]attribution.ProcessScope)
	ambiguousProcessScopes := make(map[string]struct{})
	for _, claim := range sortedClaims {
		if claim == nil {
			stats.InvalidClaims++
			continue
		}
		workspaceID := strings.TrimSpace(claim.Labels[LabelCoderWorkspaceID])
		workspaceName := strings.TrimSpace(claim.Labels[LabelCoderWorkspaceName])
		username := strings.TrimSpace(claim.Labels[LabelCoderUsername])
		if claim.Labels[LabelCoderResource] != "true" || !safeDisplay(workspaceID, 253) || !safeDisplay(workspaceName, 253) || !safeDisplay(username, 128) {
			stats.InvalidClaims++
			continue
		}
		if claim.Status.Allocation == nil {
			stats.PendingClaims++
			continue
		}
		workloadRef := HashRef("workspace_", workspaceID)
		workload := model.WorkloadAttribution{
			Ref: workloadRef, Platform: model.WorkloadPlatformCoder, Kind: model.WorkloadKindWorkspace,
			Name: workspaceName, OwnerName: username,
		}
		if existing, ok := workloadByRef[workloadRef]; ok && existing != workload {
			stats.InvalidClaims++
			continue
		}
		workloadByRef[workloadRef] = workload
		// An allocated claim with a reserved consumer is assigned to a live
		// workload. Allocation without a consumer remains scheduler-reserved.
		state := model.AllocationStateReserved
		if len(claim.Status.ReservedFor) > 0 {
			state = model.AllocationStateAllocated
		}
		matchedClaim := false
		for _, result := range claim.Status.Allocation.Devices.Results {
			device, ok := devices[deviceKey{driver: result.Driver, pool: result.Pool, device: result.Device}]
			if !ok {
				stats.UnresolvedDevices++
				continue
			}
			matchedClaim = true
			assignment := model.ResourceAssignment{WorkloadRef: workloadRef, EntityType: device.entityType, EntityUUID: device.uuid, State: state}
			key := workloadRef + "\x00" + string(device.entityType) + "\x00" + device.uuid
			if previous, exists := assignmentByKey[key]; !exists || (previous.State == model.AllocationStateReserved && state == model.AllocationStateAllocated) {
				assignmentByKey[key] = assignment
			}
		}
		if !matchedClaim {
			continue
		}
		for _, consumer := range claim.Status.ReservedFor {
			if consumer.APIGroup != "" || consumer.Resource != "pods" {
				stats.InvalidConsumers++
				continue
			}
			scopeRef, ok := attribution.ScopeRefForPodUID(string(consumer.UID))
			if !ok {
				stats.InvalidConsumers++
				continue
			}
			if _, ambiguous := ambiguousProcessScopes[scopeRef]; ambiguous {
				continue
			}
			if previous, exists := processScopeByRef[scopeRef]; exists {
				if previous.WorkloadRef != workloadRef {
					delete(processScopeByRef, scopeRef)
					ambiguousProcessScopes[scopeRef] = struct{}{}
					stats.AmbiguousProcessScopes++
				}
				continue
			}
			processScopeByRef[scopeRef] = attribution.ProcessScope{ScopeRef: scopeRef, WorkloadRef: workloadRef}
		}
	}

	assignments := make([]model.ResourceAssignment, 0, len(assignmentByKey))
	for _, assignment := range assignmentByKey {
		assignments = append(assignments, assignment)
	}
	sort.Slice(assignments, func(i, j int) bool {
		left := assignments[i].WorkloadRef + "\x00" + string(assignments[i].EntityType) + "\x00" + assignments[i].EntityUUID
		right := assignments[j].WorkloadRef + "\x00" + string(assignments[j].EntityType) + "\x00" + assignments[j].EntityUUID
		return left < right
	})
	stats.MatchedAllocations = len(assignments)
	if len(assignments) > attribution.MaxAssignments {
		assignments = assignments[:attribution.MaxAssignments]
	}
	processScopes := make([]attribution.ProcessScope, 0, len(processScopeByRef))
	for _, processScope := range processScopeByRef {
		processScopes = append(processScopes, processScope)
	}
	sort.Slice(processScopes, func(i, j int) bool { return processScopes[i].ScopeRef < processScopes[j].ScopeRef })
	stats.ProcessScopes = len(processScopes)
	if len(processScopes) > attribution.MaxProcessScopes {
		processScopes = processScopes[:attribution.MaxProcessScopes]
	}
	referenced := make(map[string]struct{}, len(assignments)+len(processScopes))
	for _, assignment := range assignments {
		referenced[assignment.WorkloadRef] = struct{}{}
	}
	for _, processScope := range processScopes {
		referenced[processScope.WorkloadRef] = struct{}{}
	}
	workloads := make([]model.WorkloadAttribution, 0, len(referenced))
	for reference := range referenced {
		workloads = append(workloads, workloadByRef[reference])
	}
	sort.Slice(workloads, func(i, j int) bool { return workloads[i].Ref < workloads[j].Ref })
	if len(workloads) > attribution.MaxWorkloads {
		workloads = workloads[:attribution.MaxWorkloads]
		allowed := make(map[string]struct{}, len(workloads))
		for _, workload := range workloads {
			allowed[workload.Ref] = struct{}{}
		}
		filtered := assignments[:0]
		for _, assignment := range assignments {
			if _, ok := allowed[assignment.WorkloadRef]; ok {
				filtered = append(filtered, assignment)
			}
		}
		assignments = filtered
		filteredScopes := processScopes[:0]
		for _, processScope := range processScopes {
			if _, ok := allowed[processScope.WorkloadRef]; ok {
				filteredScopes = append(filteredScopes, processScope)
			}
		}
		processScopes = filteredScopes
	}
	return workloads, assignments, processScopes, stats
}

func indexDevices(slices []*resourcev1.ResourceSlice, nodeName, driver string) (map[deviceKey]resolvedDevice, int) {
	pools := make(map[poolKey]map[int64]*poolGeneration)
	for _, slice := range slices {
		if slice == nil || slice.Spec.Driver != driver || slice.Spec.NodeName == nil || *slice.Spec.NodeName != nodeName {
			continue
		}
		key := poolKey{driver: slice.Spec.Driver, pool: slice.Spec.Pool.Name}
		generations := pools[key]
		if generations == nil {
			generations = make(map[int64]*poolGeneration)
			pools[key] = generations
		}
		generation := generations[slice.Spec.Pool.Generation]
		if generation == nil {
			generation = &poolGeneration{expected: slice.Spec.Pool.ResourceSliceCount}
			generations[slice.Spec.Pool.Generation] = generation
		} else if generation.expected != slice.Spec.Pool.ResourceSliceCount {
			generation.expected = -1
		}
		generation.slices = append(generation.slices, slice)
	}

	result := make(map[deviceKey]resolvedDevice)
	ambiguous := make(map[deviceKey]struct{})
	incomplete := 0
	for key, generations := range pools {
		generationNumbers := make([]int64, 0, len(generations))
		for number := range generations {
			generationNumbers = append(generationNumbers, number)
		}
		sort.Slice(generationNumbers, func(i, j int) bool { return generationNumbers[i] > generationNumbers[j] })
		var selected *poolGeneration
		for _, number := range generationNumbers {
			candidate := generations[number]
			if candidate.expected > 0 && int64(len(candidate.slices)) == candidate.expected {
				selected = candidate
				break
			}
		}
		if selected == nil {
			incomplete++
			continue
		}
		sort.Slice(selected.slices, func(i, j int) bool { return selected.slices[i].Name < selected.slices[j].Name })
		for _, slice := range selected.slices {
			for _, device := range slice.Spec.Devices {
				uuid, uuidOK := stringAttribute(device, key.driver, "uuid")
				kind, kindOK := stringAttribute(device, key.driver, "type")
				if !uuidOK || !kindOK {
					continue
				}
				var entityType model.AllocationEntityType
				switch kind {
				case "gpu":
					if !strings.HasPrefix(uuid, "GPU-") {
						continue
					}
					entityType = model.AllocationEntityPhysicalGPU
				case "mig":
					if !strings.HasPrefix(uuid, "MIG-") {
						continue
					}
					entityType = model.AllocationEntityComputeInstance
				default:
					continue
				}
				lookupKey := deviceKey{driver: key.driver, pool: key.pool, device: device.Name}
				resolved := resolvedDevice{uuid: uuid, entityType: entityType}
				if previous, exists := result[lookupKey]; exists && previous != resolved {
					delete(result, lookupKey)
					ambiguous[lookupKey] = struct{}{}
					continue
				}
				if _, exists := ambiguous[lookupKey]; !exists {
					result[lookupKey] = resolved
				}
			}
		}
	}
	return result, incomplete
}

func stringAttribute(device resourcev1.Device, driver, name string) (string, bool) {
	value := ""
	for _, key := range []resourcev1.QualifiedName{resourcev1.QualifiedName(name), resourcev1.QualifiedName(driver + "/" + name)} {
		attribute, exists := device.Attributes[key]
		if !exists {
			continue
		}
		if attribute.StringValue == nil || !safeDisplay(*attribute.StringValue, 128) {
			return "", false
		}
		if value != "" && value != *attribute.StringValue {
			return "", false
		}
		value = *attribute.StringValue
	}
	return value, value != ""
}

func HashRef(prefix, value string) string {
	digest := sha256.Sum256([]byte(prefix + "\x00" + value))
	return prefix + hex.EncodeToString(digest[:16])
}

func safeDisplay(value string, maximum int) bool {
	if value == "" || len(value) > maximum || !utf8.ValidString(value) {
		return false
	}
	for _, character := range value {
		if unicode.IsControl(character) || unicode.Is(unicode.Cf, character) || unicode.Is(unicode.Zl, character) || unicode.Is(unicode.Zp, character) {
			return false
		}
	}
	return true
}
