package collector

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"runtime"
	"sort"
	"time"

	"github.com/intellisys-stevens/leviathan/internal/plugins"
	"github.com/intellisys-stevens/leviathan/model"
	v1 "github.com/intellisys-stevens/leviathan/plugin/v1"
)

type pluginObservation struct {
	event plugins.Event
	value *v1.Observation
}

type resourceIdentity struct {
	id, generation string
	kind           model.AllocationEntityType
}

func NewPluginEngine(sources *plugins.Runtime, options Options) *Engine {
	engine := NewWithOptions(nil, options)
	engine.plugins = sources
	engine.observations = map[string]pluginObservation{}
	return engine
}

func (e *Engine) Plugins() []plugins.Health {
	if e.plugins == nil {
		return []plugins.Health{}
	}
	return e.plugins.List()
}

func (e *Engine) startPlugins(parent context.Context) error {
	ctx, cancel := context.WithCancel(parent)
	e.mu.Lock()
	e.cancel = cancel
	e.mu.Unlock()
	// A bounded, empty initial snapshot exposes adapter failures in Diagnostics
	// even when this host has no usable hardware collectors.
	e.AcceptObservation(plugins.Event{At: time.Now().UTC()})
	go func() { defer close(e.done); e.plugins.Run(ctx, e.AcceptObservation) }()
	return nil
}

// AcceptObservation is the only plugin ingress. Sources cannot replace a whole
// snapshot. Assembly is serialized; published snapshots and source values stay
// immutable, and unrelated domains do not gain history samples on this event.
func (e *Engine) AcceptObservation(event plugins.Event) {
	e.assembleMu.Lock()
	defer e.assembleMu.Unlock()
	if e.observations == nil {
		e.observations = map[string]pluginObservation{}
	}
	cached := false
	if event.InstanceID != "" {
		key := event.InstanceID + "/" + string(event.Capability)
		previous := e.observations[key]
		if prior, next := previous.value, event.Observation; prior != nil && next != nil {
			wasStale := previous.event.At.Sub(prior.ObservedAt) > 3*previous.event.Interval
			isStale := event.At.Sub(next.ObservedAt) > 3*event.Interval
			cached = prior.SessionID == next.SessionID && prior.Revision == next.Revision && prior.ObservedAt.Equal(next.ObservedAt) && prior.Status == next.Status && wasStale == isStale
		}
		previous.event = event
		if event.Observation != nil {
			delete(e.observations, event.InstanceID+"/")
			previous.value = event.Observation
		}
		e.observations[key] = previous
	}
	snapshot := e.assemblePlugins(event.At)
	domain := domainMetadata
	switch event.Capability {
	case v1.Host:
		domain = domainSystem
	case v1.GPU:
		domain = domainGPU
	case v1.WorkloadMeasurements:
		domain = domainWorkload
	}
	if cached {
		domain = domainMetadata
	}
	e.storeSnapshot(snapshot, true, domain, event)
}

func (e *Engine) assemblePlugins(at time.Time) model.Snapshot {
	hostname, _ := os.Hostname()
	snapshot := model.Snapshot{SampledAt: at, Host: model.Host{Hostname: hostname, OS: runtime.GOOS, Arch: runtime.GOARCH}, GPUs: []model.GPU{}, Processes: []model.Process{}, Diagnostics: []model.Diagnostic{}}
	keys := make([]string, 0, len(e.observations))
	for key := range e.observations {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	entries := make([]pluginObservation, 0, len(keys))
	for _, key := range keys {
		entries = append(entries, e.observations[key])
	}
	diagnostic := func(code, component, message string) {
		snapshot.Diagnostics = append(snapshot.Diagnostics, model.Diagnostic{Code: code, Component: component, Severity: "warning", Summary: message, Status: model.StatusError})
	}
	stale := func(entry pluginObservation) bool {
		return entry.event.Err != nil || entry.value == nil || entry.value.Status != "available" && entry.value.Status != "partial" || at.Sub(entry.value.ObservedAt) > 3*entry.event.Interval
	}
	gpuOwners := map[string]int{}
	hostCount := 0
	for _, entry := range entries {
		if entry.event.Err != nil {
			diagnostic("plugin_observation", entry.event.InstanceID, entry.event.Err.Error())
		}
		if entry.value == nil {
			continue
		}
		if entry.value.Host != nil {
			hostCount++
		}
		if entry.value.GPU != nil {
			for _, gpu := range entry.value.GPU.GPUs {
				gpuOwners[gpu.UUID]++
			}
		}
	}
	resources := map[string]resourceIdentity{}
	gpuStates := 0
	gpuAvailable := 0
	for _, entry := range entries {
		value := entry.value
		if value == nil {
			continue
		}
		id, native := entry.event.InstanceID, entry.event.Native
		if stale(entry) {
			diagnostic("plugin_stale", id, "Source observation is unavailable or stale")
		}
		if value.Host != nil {
			if hostCount > 1 {
				diagnostic("plugin_ownership_conflict", id, "Multiple plugins claim the host; measurements withheld")
				continue
			}
			snapshot.System = value.Host.System
			snapshot.Diagnostics = append(snapshot.Diagnostics, value.Host.Diagnostics...)
			if stale(entry) {
				snapshot.System = stalePluginSystem(snapshot.System)
			}
			snapshot.Capabilities.System = model.ProviderState{Name: id, Available: !stale(entry), Status: snapshot.System.Status, Message: snapshot.System.Message}
		}
		if value.GPU != nil {
			gpuStates++
			state := value.GPU.Capabilities
			if stale(entry) {
				state = staleCapabilities(state, "Plugin observation is stale")
			}
			snapshot.Capabilities.NVML = mergePluginProvider(snapshot.Capabilities.NVML, state.NVML)
			snapshot.Capabilities.GPM = mergePluginProvider(snapshot.Capabilities.GPM, state.GPM)
			snapshot.Capabilities.DCGM = mergePluginProvider(snapshot.Capabilities.DCGM, state.DCGM)
			snapshot.Capabilities.ProfileMetrics = snapshot.Capabilities.ProfileMetrics || state.ProfileMetrics
			snapshot.Diagnostics = append(snapshot.Diagnostics, value.GPU.Diagnostics...)
			for _, original := range value.GPU.GPUs {
				if gpuOwners[original.UUID] > 1 {
					diagnostic("plugin_ownership_conflict", id, "Multiple plugins claim GPU "+original.UUID+"; measurements withheld")
					continue
				}
				gpu := original
				gpu.UUID = definedID(id, native, original.UUID)
				gpu.Generation = pluginGeneration(gpu.UUID, native, original.Generation)
				resources[id+"/"+original.UUID] = resourceIdentity{id: gpu.UUID, generation: original.Generation, kind: model.AllocationEntityPhysicalGPU}
				gpu.GPUInstances = append([]model.GPUInstance{}, original.GPUInstances...)
				for giIndex := range gpu.GPUInstances {
					gi := &gpu.GPUInstances[giIndex]
					gi.UUID = definedID(id, native, gi.UUID)
					gi.Generation = pluginGeneration(gi.UUID, native, gi.Generation)
					gi.ComputeInstances = append([]model.ComputeInstance{}, gi.ComputeInstances...)
					for ciIndex := range gi.ComputeInstances {
						ci := &gi.ComputeInstances[ciIndex]
						raw, generation := ci.UUID, ci.Generation
						ci.UUID = definedID(id, native, ci.UUID)
						ci.Generation = pluginGeneration(ci.UUID, native, generation)
						resources[id+"/"+raw] = resourceIdentity{id: ci.UUID, generation: generation, kind: model.AllocationEntityComputeInstance}
					}
				}
				if stale(entry) {
					gpu = staleSnapshot(model.Snapshot{GPUs: []model.GPU{gpu}}, at, "Plugin observation is stale").GPUs[0]
				} else {
					gpuAvailable++
				}
				snapshot.GPUs = append(snapshot.GPUs, gpu)
			}
		}
	}
	if gpuStates > 0 {
		status := model.StatusAvailable
		if len(snapshot.GPUs) == 0 {
			status = model.StatusUnsupported
		} else if gpuAvailable == 0 {
			status = model.StatusStale
		}
		snapshot.Capabilities.GPU = &model.ProviderState{Name: "GPU plugins", Available: len(snapshot.GPUs) > 0 && gpuAvailable > 0, Status: status}
	}
	workloads := map[string]model.WorkloadAttribution{}
	workloadOwner := map[string]string{}
	workloadObserved := map[string]time.Time{}
	ambiguousWorkloads := map[string]bool{}
	scopes := map[string]string{}
	ambiguousScopes := map[string]bool{}
	var pendingScopes []struct {
		entry pluginObservation
		join  v1.ScopeAssignment
	}
	var pendingResolutions []struct {
		entry pluginObservation
		item  model.WorkloadAssignmentResolution
	}
	var allocations []struct {
		entry      pluginObservation
		assignment v1.Assignment
	}
	resolution := model.AttributionResolution{Status: "complete", ReasonCodes: []string{}, Workloads: []model.WorkloadAssignmentResolution{}}
	resolutionPresent := false
	attributionStatus := model.AttributionAvailable
	var observedAt *time.Time
	for _, entry := range entries {
		value := entry.value
		if value == nil {
			continue
		}
		id, native := entry.event.InstanceID, entry.event.Native
		var inventory []model.WorkloadAttribution
		var joins []v1.ScopeAssignment
		if value.WorkloadInventory != nil {
			inventory = value.WorkloadInventory.Workloads
			joins = value.WorkloadInventory.Scopes
		}
		if value.Allocations != nil && at.Sub(value.ObservedAt) <= max(12*entry.event.Interval, 60*time.Second) {
			inventory = append(append([]model.WorkloadAttribution{}, inventory...), value.Allocations.Workloads...)
			joins = append(append([]v1.ScopeAssignment{}, joins...), value.Allocations.Scopes...)
			for _, assignment := range value.Allocations.Assignments {
				allocations = append(allocations, struct {
					entry      pluginObservation
					assignment v1.Assignment
				}{entry, assignment})
			}
			if incoming := value.Allocations.Resolution; incoming != nil {
				resolutionPresent = true
				resolution.UnresolvedAssignments += incoming.UnresolvedAssignments
				resolution.ReasonCodes = append(resolution.ReasonCodes, incoming.ReasonCodes...)
				if incoming.Status == "unknown" || incoming.Status != "complete" && resolution.Status == "complete" {
					resolution.Status = incoming.Status
				}
				for _, item := range incoming.Workloads {
					pendingResolutions = append(pendingResolutions, struct {
						entry pluginObservation
						item  model.WorkloadAssignmentResolution
					}{entry, item})
				}
			}
		}
		if value.WorkloadInventory == nil && value.Allocations == nil {
			continue
		}
		if observedAt == nil || value.ObservedAt.Before(*observedAt) {
			timestamp := value.ObservedAt
			observedAt = &timestamp
		}
		if stale(entry) {
			attributionStatus = model.AttributionStale
		}
		// Metadata expiry removes joins; stale identity can still explain retained UI.
		if at.Sub(value.ObservedAt) > max(12*entry.event.Interval, 60*time.Second) {
			continue
		}
		for _, workload := range inventory {
			workload.Ref = definedID(id, native, workload.Ref)
			if _, exists := workloads[workload.Ref]; exists {
				if workloadOwner[workload.Ref] != id {
					ambiguousWorkloads[workload.Ref] = true
					diagnostic("plugin_identity_conflict", id, "Conflicting workload identity "+workload.Ref)
					continue
				}
				// Capability reads are independent. Within one owner, newer
				// metadata wins; sorted capability order breaks timestamp ties.
				if value.ObservedAt.Before(workloadObserved[workload.Ref]) {
					continue
				}
			}
			workloads[workload.Ref] = workload
			workloadOwner[workload.Ref] = id
			workloadObserved[workload.Ref] = value.ObservedAt
		}
		if stale(entry) {
			continue
		} // never attach stale ownership to a new process
		for _, join := range joins {
			pendingScopes = append(pendingScopes, struct {
				entry pluginObservation
				join  v1.ScopeAssignment
			}{entry, join})
		}
	}
	for ref := range ambiguousWorkloads {
		delete(workloads, ref)
	}
	resolveWorkload := func(entry pluginObservation, ref string) string {
		if ref == "" {
			return ""
		}
		local := definedID(entry.event.InstanceID, entry.event.Native, ref)
		_, localExists := workloads[local]
		_, explicitExists := workloads[ref]
		explicitExists = explicitExists && workloadOwner[ref] != entry.event.InstanceID
		if localExists && explicitExists && local != ref {
			diagnostic("plugin_ambiguous_reference", entry.event.InstanceID, "Workload reference matches both local and external identities: "+ref)
			return ""
		}
		if explicitExists && !localExists {
			return ref
		}
		return local
	}
	for _, pending := range pendingScopes {
		ref := resolveWorkload(pending.entry, pending.join.WorkloadRef)
		if ref == "" {
			ambiguousScopes[pending.join.ScopeRef] = true
			continue
		}
		if previous, exists := scopes[pending.join.ScopeRef]; exists && previous != ref {
			ambiguousScopes[pending.join.ScopeRef] = true
			diagnostic("plugin_scope_conflict", pending.entry.event.InstanceID, "Ambiguous execution scope; process join withheld")
		}
		scopes[pending.join.ScopeRef] = ref
	}
	for _, pending := range pendingResolutions {
		pending.item.WorkloadRef = resolveWorkload(pending.entry, pending.item.WorkloadRef)
		if pending.item.WorkloadRef != "" {
			resolution.Workloads = append(resolution.Workloads, pending.item)
		}
	}
	for scope := range ambiguousScopes {
		delete(scopes, scope)
	}
	if observedAt != nil {
		attribution := &model.Attribution{Provider: "plugins", Status: attributionStatus, ObservedAt: observedAt, Workloads: []model.WorkloadAttribution{}, Assignments: []model.ResourceAssignment{}}
		refs := make([]string, 0, len(workloads))
		for ref := range workloads {
			refs = append(refs, ref)
		}
		sort.Strings(refs)
		for _, ref := range refs {
			attribution.Workloads = append(attribution.Workloads, workloads[ref])
		}
		seen := map[string]bool{}
		resourceWorkloads := map[string]string{}
		conflicts := map[string]bool{}
		for _, item := range allocations {
			a := item.assignment
			ref := resolveWorkload(item.entry, a.WorkloadRef)
			resource, exists := resources[a.Resource.InstanceID+"/"+a.Resource.ID]
			if _, known := workloads[ref]; !known || !exists || resource.kind != a.EntityType || a.Resource.Generation != "" && a.Resource.Generation != resource.generation {
				diagnostic("plugin_unresolved_reference", item.entry.event.InstanceID, "Allocation target or generation is unresolved")
				continue
			}
			if previous, exists := resourceWorkloads[resource.id]; exists && previous != ref {
				conflicts[resource.id] = true
				diagnostic("plugin_allocation_conflict", item.entry.event.InstanceID, "Conflicting resource ownership; assignment withheld")
			}
			resourceWorkloads[resource.id] = ref
			key := resource.id + "/" + ref + "/" + string(a.State)
			if seen[key] {
				continue
			}
			seen[key] = true
			attribution.Assignments = append(attribution.Assignments, model.ResourceAssignment{WorkloadRef: ref, EntityUUID: resource.id, EntityType: a.EntityType, State: a.State})
		}
		filtered := attribution.Assignments[:0]
		for _, assignment := range attribution.Assignments {
			if !conflicts[assignment.EntityUUID] {
				filtered = append(filtered, assignment)
			}
		}
		attribution.Assignments = filtered
		if resolutionPresent {
			attribution.Resolution = &resolution
		}
		snapshot.Attribution = attribution
	}
	processOwners := map[uint32]int{}
	for _, entry := range entries {
		if entry.value != nil && entry.value.Processes != nil {
			for _, record := range entry.value.Processes.Processes {
				processOwners[record.Process.PID]++
			}
		}
	}
	telemetry := &model.WorkloadTelemetry{Status: model.WorkloadTelemetryAvailable, Owners: []model.WorkloadOwnerTelemetry{}}
	telemetryPresent := false
	ownerRefs := map[string]bool{}
	ambiguousOwners := map[string]bool{}
	for _, entry := range entries {
		value := entry.value
		if value == nil {
			continue
		}
		id, native := entry.event.InstanceID, entry.event.Native
		if value.Processes != nil {
			snapshot.Capabilities.Proc = value.Processes.Capability
			snapshot.Diagnostics = append(snapshot.Diagnostics, value.Processes.Diagnostics...)
			for _, record := range value.Processes.Processes {
				process := record.Process
				if processOwners[process.PID] > 1 {
					diagnostic("plugin_process_conflict", id, fmt.Sprintf("Multiple plugins claim process %d; observation withheld", process.PID))
					continue
				}
				process.ScopeRef = record.ScopeRef
				process.WorkloadRef = resolveWorkload(entry, process.WorkloadRef)
				if record.Process.WorkloadRef == "" {
					process.WorkloadRef = scopes[record.ScopeRef]
				}
				if _, valid := workloads[process.WorkloadRef]; !valid {
					process.WorkloadRef = ""
				}
				if stale(entry) {
					process.Status = model.StatusStale
					process.WorkloadRef = ""
					process.Message = "Plugin observation is stale"
				}
				snapshot.Processes = append(snapshot.Processes, process)
			}
		}
		if value.WorkloadMeasurements != nil {
			telemetryPresent = true
			source := value.WorkloadMeasurements
			if source.SampledAt.After(telemetry.SampledAt) {
				telemetry.SampledAt = source.SampledAt
			}
			sourceObservedAt := value.ObservedAt
			if source.ObservedAt != nil {
				sourceObservedAt = *source.ObservedAt
			}
			if telemetry.ObservedAt == nil || sourceObservedAt.Before(*telemetry.ObservedAt) {
				timestamp := sourceObservedAt
				telemetry.ObservedAt = &timestamp
			}
			if source.Status != model.WorkloadTelemetryAvailable {
				telemetry.Status = source.Status
			}
			for _, owner := range source.Owners {
				owner.Ref = definedID(id, native, owner.Ref)
				if ownerRefs[owner.Ref] {
					ambiguousOwners[owner.Ref] = true
					diagnostic("plugin_owner_conflict", id, "Conflicting owner telemetry")
					continue
				}
				ownerRefs[owner.Ref] = true
				owner.Workspaces = append([]model.WorkloadAttribution{}, owner.Workspaces...)
				workspaces := owner.Workspaces[:0]
				for _, workspace := range owner.Workspaces {
					workspace.Ref = resolveWorkload(entry, workspace.Ref)
					if workspace.Ref != "" {
						workspaces = append(workspaces, workspace)
					}
				}
				owner.Workspaces = workspaces
				if stale(entry) {
					owner.Status = model.WorkloadTelemetryStale
					owner.Metrics = staleMetrics(owner.Metrics, "Plugin observation is stale")
					telemetry.Status = model.WorkloadTelemetryStale
				}
				telemetry.Owners = append(telemetry.Owners, owner)
			}
		}
	}
	if telemetryPresent {
		owners := telemetry.Owners[:0]
		for _, owner := range telemetry.Owners {
			if !ambiguousOwners[owner.Ref] {
				owners = append(owners, owner)
			}
		}
		telemetry.Owners = owners
		snapshot.WorkloadTelemetry = telemetry
	}
	return snapshot
}

// Read exposes capacity as a separate, non-additive allocation observation.
func (e *Engine) Read(_ context.Context, at time.Time) (model.GPUCapacityDocument, error) {
	e.assembleMu.Lock()
	defer e.assembleMu.Unlock()
	var result *model.GPUCapacityDocument
	for _, entry := range e.observations {
		if entry.value == nil || entry.value.GPUCapacity == nil {
			continue
		}
		if result != nil {
			return model.UnavailableGPUCapacity("Conflicting capacity plugins"), nil
		}
		value := entry.value.GPUCapacity.At(at)
		if entry.event.Err != nil {
			value = model.UnavailableGPUCapacity("Capacity plugin is unavailable")
		}
		result = &value
	}
	if result == nil {
		return model.UnavailableGPUCapacity("No capacity plugin observation is available"), nil
	}
	return *result, nil
}

func definedID(instance string, native bool, id string) string {
	if id == "" || native {
		return id
	}
	return instance + "/" + id
}

func pluginGeneration(resource string, native bool, generation string) string {
	if generation == "" || native {
		return generation
	}
	return resource + "@plugin:" + url.QueryEscape(generation)
}

// Provider groups are optional. An empty external group cannot erase a native
// provider, and a healthy provider wins over another source's unavailable group.
// Iteration order supplies a deterministic tie-break for equivalent states.
func mergePluginProvider(current, incoming model.ProviderState) model.ProviderState {
	if incoming == (model.ProviderState{}) {
		return current
	}
	if current == (model.ProviderState{}) || incoming.Available && !current.Available {
		return incoming
	}
	return current
}

func stalePluginSystem(system model.System) model.System {
	stale := staleSystem(system, system.SampledAt, "Plugin observation is stale")
	stale.CPU.SampledAt = system.CPU.SampledAt
	stale.CPU.Utilization.SampledAt = system.CPU.Utilization.SampledAt
	stale.CPU.Load1.SampledAt = system.CPU.Load1.SampledAt
	stale.CPU.Load5.SampledAt = system.CPU.Load5.SampledAt
	stale.CPU.Load15.SampledAt = system.CPU.Load15.SampledAt
	stale.Memory.SampledAt = system.Memory.SampledAt
	stale.Memory.Utilization.SampledAt = system.Memory.Utilization.SampledAt
	stale.Storage.SampledAt = system.Storage.SampledAt
	stale.Storage.ReadBytesPerSecond.SampledAt = system.Storage.ReadBytesPerSecond.SampledAt
	stale.Storage.WriteBytesPerSecond.SampledAt = system.Storage.WriteBytesPerSecond.SampledAt
	for index := range stale.Storage.Filesystems {
		stale.Storage.Filesystems[index].SampledAt = system.Storage.Filesystems[index].SampledAt
	}
	if stale.Uptime != nil {
		stale.Uptime.SampledAt = system.Uptime.SampledAt
	}
	return stale
}

func (e *Engine) pluginHistorySnapshot(snapshot model.Snapshot, event plugins.Event) model.Snapshot {
	entry := e.observations[event.InstanceID+"/"+string(event.Capability)]
	value := entry.value
	at := event.At
	if value != nil && event.Err == nil && (value.Status == "available" || value.Status == "partial") && event.At.Sub(value.ObservedAt) <= 3*event.Interval {
		at = value.ObservedAt
	}
	snapshot.SampledAt = at
	if event.Capability == v1.GPU {
		owned := map[string]bool{}
		if value != nil && value.GPU != nil {
			for _, gpu := range value.GPU.GPUs {
				owned[definedID(event.InstanceID, event.Native, gpu.UUID)] = true
			}
		}
		gpus := make([]model.GPU, 0, len(snapshot.GPUs))
		for _, gpu := range snapshot.GPUs {
			if owned[gpu.UUID] {
				gpus = append(gpus, gpu)
			}
		}
		snapshot.GPUs = gpus
	}
	if event.Capability == v1.WorkloadMeasurements && snapshot.WorkloadTelemetry != nil {
		telemetry := *snapshot.WorkloadTelemetry
		telemetry.SampledAt = at
		owned := map[string]bool{}
		if value != nil && value.WorkloadMeasurements != nil {
			for _, owner := range value.WorkloadMeasurements.Owners {
				owned[definedID(event.InstanceID, event.Native, owner.Ref)] = true
			}
		}
		telemetry.Owners = []model.WorkloadOwnerTelemetry{}
		for _, owner := range snapshot.WorkloadTelemetry.Owners {
			if owned[owner.Ref] {
				if !at.Equal(value.ObservedAt) {
					owner.SampledAt = at
					owner.Metrics = staleMetrics(owner.Metrics, "Plugin observation is stale")
				}
				telemetry.Owners = append(telemetry.Owners, owner)
			}
		}
		snapshot.WorkloadTelemetry = &telemetry
	}
	return snapshot
}
