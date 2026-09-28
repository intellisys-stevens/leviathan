// Package v1 defines the portable Leviathan plugin protocol. Implementations
// publish independent, typed observations; the host owns scheduling and joins.
package v1

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/intellisys-stevens/leviathan/model"
)

const ProtocolVersion = "1"

type Capability string

const (
	Host                 Capability = "host"
	GPU                  Capability = "gpu"
	Processes            Capability = "processes"
	WorkloadInventory    Capability = "workload-inventory"
	Allocations          Capability = "allocations"
	WorkloadMeasurements Capability = "workload-measurements"
	GPUCapacity          Capability = "gpu-capacity"
)

func (c Capability) Valid() bool {
	switch c {
	case Host, GPU, Processes, WorkloadInventory, Allocations, WorkloadMeasurements, GPUCapacity:
		return true
	}
	return false
}

type Manifest struct {
	ProtocolVersion string                `json:"protocol_version"`
	ID              string                `json:"id"`
	Version         string                `json:"version"`
	Capabilities    map[Capability]string `json:"capabilities"`
}

func (m Manifest) Validate() error {
	if m.ProtocolVersion != ProtocolVersion || !ValidID(m.ID) || !validText(m.Version, 128, false) || len(m.Capabilities) == 0 {
		return errors.New("invalid plugin manifest")
	}
	for capability, version := range m.Capabilities {
		if !capability.Valid() || version != "1" {
			return fmt.Errorf("unsupported capability %q revision %q", capability, version)
		}
	}
	return nil
}

// Source is opened once and closed once. Open context bounds initialization only;
// background activity must end on Close. Read may run concurrently for distinct
// capabilities. Implementations must honor cancellation and retain measurement
// timestamps when returning cached data. A revision is monotone per capability
// and session; a new session permits revisions to restart.
type Source interface {
	Manifest() Manifest
	Open(context.Context) error
	Read(context.Context, Capability, time.Time) (Observation, error)
	Close() error
}

// ResourceRef names a resource owned by a configured producer instance.
// Generation distinguishes replaced resources that reuse the same ID.
type ResourceRef struct {
	InstanceID string `json:"instance_id"`
	ID         string `json:"id"`
	Generation string `json:"generation,omitempty"`
}

type HostData struct {
	System      model.System       `json:"system"`
	Diagnostics []model.Diagnostic `json:"diagnostics,omitempty"`
}

type GPUData struct {
	GPUs         []model.GPU        `json:"gpus"`
	Capabilities model.Capabilities `json:"capabilities"`
	Diagnostics  []model.Diagnostic `json:"diagnostics,omitempty"`
}

// ProcessRecord carries the private scope join which the public Process JSON
// deliberately omits. It does not expose a cgroup path or Kubernetes object ID.
type ProcessRecord struct {
	Process  model.Process `json:"process"`
	ScopeRef string        `json:"scope_ref,omitempty"`
}

type ProcessData struct {
	Processes   []ProcessRecord     `json:"processes"`
	Capability  model.ProviderState `json:"capability"`
	Diagnostics []model.Diagnostic  `json:"diagnostics,omitempty"`
}

type Owner struct {
	Ref          string                 `json:"ref"`
	Name         string                 `json:"name"`
	Platform     model.WorkloadPlatform `json:"platform"`
	WorkloadRefs []string               `json:"workload_refs"`
}

type ScopeAssignment struct {
	ScopeRef    string `json:"scope_ref"`
	WorkloadRef string `json:"workload_ref"`
	OwnerRef    string `json:"owner_ref,omitempty"`
}

type InventoryData struct {
	Workloads []model.WorkloadAttribution `json:"workloads"`
	Owners    []Owner                     `json:"owners"`
	Scopes    []ScopeAssignment           `json:"scopes,omitempty"`
}

type Assignment struct {
	WorkloadRef string                     `json:"workload_ref"`
	Resource    ResourceRef                `json:"resource"`
	EntityType  model.AllocationEntityType `json:"entity_type"`
	State       model.AllocationState      `json:"state"`
}

type AllocationData struct {
	Workloads   []model.WorkloadAttribution  `json:"workloads"`
	Assignments []Assignment                 `json:"assignments"`
	Scopes      []ScopeAssignment            `json:"scopes,omitempty"`
	Resolution  *model.AttributionResolution `json:"resolution,omitempty"`
}

// Observation contains exactly one capability payload. InstanceID is stable
// configuration identity; SessionID changes after plugin restart. Neither an
// HTTP read nor a host projection is a new source observation.
type Observation struct {
	Capability           Capability                 `json:"capability"`
	InstanceID           string                     `json:"instance_id"`
	SessionID            string                     `json:"session_id"`
	Revision             uint64                     `json:"revision"`
	ObservedAt           time.Time                  `json:"observed_at"`
	Status               string                     `json:"status"`
	Message              string                     `json:"message,omitempty"`
	Host                 *HostData                  `json:"host,omitempty"`
	GPU                  *GPUData                   `json:"gpu,omitempty"`
	Processes            *ProcessData               `json:"processes,omitempty"`
	WorkloadInventory    *InventoryData             `json:"workload_inventory,omitempty"`
	Allocations          *AllocationData            `json:"allocations,omitempty"`
	WorkloadMeasurements *model.WorkloadTelemetry   `json:"workload_measurements,omitempty"`
	GPUCapacity          *model.GPUCapacityDocument `json:"gpu_capacity,omitempty"`
}

func (o Observation) Validate() error {
	if !ValidID(o.InstanceID) || !ValidID(o.SessionID) || o.Revision == 0 || o.ObservedAt.IsZero() {
		return errors.New("invalid observation identity, revision or timestamp")
	}
	switch o.Status {
	case "available", "partial", "stale", "unavailable", "unsupported", "error":
	default:
		return errors.New("invalid observation status")
	}
	populated := map[Capability]bool{
		Host: o.Host != nil, GPU: o.GPU != nil, Processes: o.Processes != nil,
		WorkloadInventory: o.WorkloadInventory != nil, Allocations: o.Allocations != nil,
		WorkloadMeasurements: o.WorkloadMeasurements != nil, GPUCapacity: o.GPUCapacity != nil,
	}
	count := 0
	for _, present := range populated {
		if present {
			count++
		}
	}
	if count != 1 || !populated[o.Capability] {
		return errors.New("observation must contain exactly its declared capability payload")
	}
	if o.Allocations != nil {
		for _, assignment := range o.Allocations.Assignments {
			if !ValidID(assignment.Resource.InstanceID) || assignment.Resource.ID == "" || assignment.WorkloadRef == "" {
				return errors.New("allocation requires an explicit resource and workload reference")
			}
		}
	}
	if o.GPUCapacity != nil {
		return o.GPUCapacity.Validate()
	}
	return nil
}

// ValidID keeps configured producer names unambiguous in instance/resource IDs.
func ValidID(value string) bool {
	return validText(value, 128, false) && !strings.ContainsAny(value, "/\\ \t\r\n")
}
