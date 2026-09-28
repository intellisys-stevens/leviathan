package kubernetesbridge

import (
	"context"
	"errors"
	"sync/atomic"
	"time"

	"github.com/intellisys-stevens/leviathan/adapters/kubernetes/attribution"
	"github.com/intellisys-stevens/leviathan/model"
	plugin "github.com/intellisys-stevens/leviathan/plugin/v1"
)

// bridgePlugin publishes only environment observations. Local cgroup and NVIDIA
// checkpoint access stays with host adapters and is never requested from here.
type bridgePlugin struct {
	server   *Server
	revision atomic.Uint64
}

func (p *bridgePlugin) Manifest() plugin.Manifest {
	capabilities := map[plugin.Capability]string{plugin.Allocations: "1"}
	if p.server.workloads != nil {
		capabilities[plugin.WorkloadInventory] = "1"
	}
	if p.server.capacity != nil {
		capabilities[plugin.GPUCapacity] = "1"
	}
	version := p.server.state.bridgeVersion
	if version == "" {
		version = "dev"
	}
	return plugin.Manifest{ProtocolVersion: plugin.ProtocolVersion, ID: "coder-kubernetes", Version: version, Capabilities: capabilities}
}
func (p *bridgePlugin) Open(context.Context) error { return nil }
func (p *bridgePlugin) Close() error               { return nil }
func (p *bridgePlugin) Read(ctx context.Context, capability plugin.Capability, now time.Time) (plugin.Observation, error) {
	if err := ctx.Err(); err != nil {
		return plugin.Observation{}, err
	}
	o := plugin.Observation{Capability: capability, Revision: p.revision.Add(1), ObservedAt: now, Status: "unavailable"}
	switch capability {
	case plugin.WorkloadInventory:
		if p.server.workloads == nil {
			return o, errors.New("workload inventory disabled")
		}
		d := p.server.workloads.Document(now)
		o.ObservedAt, o.Status, o.Message = d.ObservedAt, string(d.Status), d.Message
		data := &plugin.InventoryData{Workloads: []model.WorkloadAttribution{}, Owners: []plugin.Owner{}, Scopes: []plugin.ScopeAssignment{}}
		for _, owner := range d.Owners {
			entry := plugin.Owner{Ref: owner.Ref, Name: owner.Name, Platform: owner.Platform, WorkloadRefs: []string{}}
			for _, workload := range owner.Workspaces {
				data.Workloads = append(data.Workloads, workload)
				entry.WorkloadRefs = append(entry.WorkloadRefs, workload.Ref)
			}
			data.Owners = append(data.Owners, entry)
		}
		for _, scope := range d.Pods {
			data.Scopes = append(data.Scopes, plugin.ScopeAssignment{ScopeRef: scope.ScopeRef, OwnerRef: scope.OwnerRef, WorkloadRef: scope.WorkloadRef})
		}
		o.WorkloadInventory = data
	case plugin.Allocations:
		d := p.server.state.DocumentV2(now)
		o.ObservedAt = d.SourceObservedAt
		o.Status = string(d.Status.State)
		if o.Status == string(attribution.SourceError) {
			o.Status = "unavailable"
		}
		if !d.Status.HasValidInventory {
			o.Status = "unavailable"
		}
		resolution := attribution.CloneResolution(d.Resolution)
		data := &plugin.AllocationData{Workloads: d.Workloads, Assignments: []plugin.Assignment{}, Scopes: []plugin.ScopeAssignment{}, Resolution: &resolution}
		for _, assignment := range d.Assignments {
			data.Assignments = append(data.Assignments, plugin.Assignment{WorkloadRef: assignment.WorkloadRef, Resource: plugin.ResourceRef{InstanceID: p.server.gpuInstanceID, ID: assignment.EntityUUID}, EntityType: assignment.EntityType, State: assignment.State})
		}
		for _, scope := range d.ProcessScopes {
			data.Scopes = append(data.Scopes, plugin.ScopeAssignment{ScopeRef: scope.ScopeRef, WorkloadRef: scope.WorkloadRef})
		}
		// Dynamic bindings require host checkpoint/topology resolution. The legacy
		// private handoff remains available to that adapter during migration.
		for _, binding := range d.Bindings {
			attribution.AddResolutionIssue(&resolution, binding.WorkloadRef, "host_resolution_required", 1)
		}
		o.Allocations = data
	case plugin.GPUCapacity:
		if p.server.capacity == nil {
			return o, errors.New("GPU capacity disabled")
		}
		d := p.server.capacity.Document(now)
		o.Status, o.Message = d.Status, d.Message
		if d.ObservedAt != nil {
			o.ObservedAt = *d.ObservedAt
		}
		o.GPUCapacity = &d
	default:
		return o, errors.New("unsupported capability")
	}
	return o, nil
}

// WithPluginIdentity names this bridge producer and the host GPU producer whose
// resources its assignments reference. Existing private endpoints are retained.
func (s *Server) WithPluginIdentity(instanceID, gpuInstanceID string) *Server {
	s.pluginInstanceID, s.gpuInstanceID = instanceID, gpuInstanceID
	return s
}
