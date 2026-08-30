// Package attribution implements the versioned, local handoff between an
// optional workload-attribution bridge and the MIGLens telemetry process.
package attribution

import (
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/intellisys-stevens/miglens/internal/model"
)

const (
	SchemaVersion    = "miglens.attribution/v1"
	MaxDocumentBytes = 1 << 20
	MaxWorkloads     = 1024
	MaxAssignments   = 2048
)

type SourceState string

const (
	SourceAvailable SourceState = "available"
	SourceStale     SourceState = "stale"
	SourceError     SourceState = "error"
)

type SourceStatus struct {
	State             SourceState `json:"state"`
	HasValidInventory bool        `json:"hasValidInventory"`
	Message           string      `json:"message,omitempty"`
}

// Document is the complete bridge handoff. Upstream Kubernetes identifiers
// are replaced with opaque hashes before they enter this boundary.
type Document struct {
	SchemaVersion    string                      `json:"schemaVersion"`
	BridgeVersion    string                      `json:"bridgeVersion"`
	InstanceID       string                      `json:"instanceId"`
	Revision         uint64                      `json:"revision"`
	GeneratedAt      time.Time                   `json:"generatedAt"`
	SourceObservedAt time.Time                   `json:"sourceObservedAt"`
	NodeRef          string                      `json:"nodeRef"`
	Status           SourceStatus                `json:"status"`
	Workloads        []model.WorkloadAttribution `json:"workloads"`
	Assignments      []model.ResourceAssignment  `json:"assignments"`
}

func (d Document) Validate() error {
	if d.SchemaVersion != SchemaVersion {
		return fmt.Errorf("unsupported attribution schema %q", d.SchemaVersion)
	}
	if !validOpaqueRef(d.InstanceID, "instance_") {
		return errors.New("invalid bridge instance reference")
	}
	if !validOpaqueRef(d.NodeRef, "node_") {
		return errors.New("invalid node reference")
	}
	if d.GeneratedAt.IsZero() || d.SourceObservedAt.IsZero() {
		return errors.New("attribution timestamps are required")
	}
	if d.Revision == 0 || !validDisplayString(d.BridgeVersion, 128, false) {
		return errors.New("invalid bridge version or revision")
	}
	if d.SourceObservedAt.After(d.GeneratedAt.Add(time.Minute)) {
		return errors.New("source observation time is after document generation")
	}
	switch d.Status.State {
	case SourceAvailable, SourceStale, SourceError:
	default:
		return fmt.Errorf("invalid attribution source state %q", d.Status.State)
	}
	if d.Status.State == SourceAvailable && !d.Status.HasValidInventory {
		return errors.New("available attribution source has no valid inventory")
	}
	if !validDisplayString(d.Status.Message, 512, true) {
		return errors.New("invalid attribution status message")
	}
	if len(d.Workloads) > MaxWorkloads || len(d.Assignments) > MaxAssignments {
		return errors.New("attribution document exceeds entity limits")
	}

	workloads := make(map[string]struct{}, len(d.Workloads))
	for _, workload := range d.Workloads {
		if !validOpaqueRef(workload.Ref, "workspace_") {
			return errors.New("invalid workload reference")
		}
		if _, exists := workloads[workload.Ref]; exists {
			return errors.New("duplicate workload reference")
		}
		workloads[workload.Ref] = struct{}{}
		if workload.Platform != model.WorkloadPlatformCoder {
			return fmt.Errorf("unsupported workload platform %q", workload.Platform)
		}
		if workload.Kind != model.WorkloadKindWorkspace {
			return fmt.Errorf("unsupported workload kind %q", workload.Kind)
		}
		if !validDisplayString(workload.Name, 253, false) || !validDisplayString(workload.OwnerName, 128, false) {
			return errors.New("invalid workload display identity")
		}
	}

	assignments := make(map[string]struct{}, len(d.Assignments))
	for _, assignment := range d.Assignments {
		if _, exists := workloads[assignment.WorkloadRef]; !exists {
			return errors.New("assignment references an unknown workload")
		}
		switch assignment.EntityType {
		case model.AllocationEntityPhysicalGPU:
			if !strings.HasPrefix(assignment.EntityUUID, "GPU-") {
				return errors.New("physical GPU assignment has an invalid UUID")
			}
		case model.AllocationEntityComputeInstance:
			if !strings.HasPrefix(assignment.EntityUUID, "MIG-") {
				return errors.New("compute-instance assignment has an invalid UUID")
			}
		default:
			return fmt.Errorf("invalid assignment entity type %q", assignment.EntityType)
		}
		if !validDisplayString(assignment.EntityUUID, 128, false) {
			return errors.New("invalid assignment entity UUID")
		}
		switch assignment.State {
		case model.AllocationStateAllocated, model.AllocationStateReserved:
		default:
			return fmt.Errorf("invalid assignment state %q", assignment.State)
		}
		key := assignment.WorkloadRef + "\x00" + string(assignment.EntityType) + "\x00" + assignment.EntityUUID
		if _, exists := assignments[key]; exists {
			return errors.New("duplicate assignment")
		}
		assignments[key] = struct{}{}
	}
	return nil
}

func validOpaqueRef(value, prefix string) bool {
	if !strings.HasPrefix(value, prefix) || len(value) != len(prefix)+32 {
		return false
	}
	for _, character := range value[len(prefix):] {
		if (character < '0' || character > '9') && (character < 'a' || character > 'f') {
			return false
		}
	}
	return true
}

func validDisplayString(value string, maximum int, emptyOK bool) bool {
	if (!emptyOK && value == "") || len(value) > maximum || !utf8.ValidString(value) {
		return false
	}
	for _, character := range value {
		if unicode.IsControl(character) || unicode.Is(unicode.Cf, character) || unicode.Is(unicode.Zl, character) || unicode.Is(unicode.Zp, character) {
			return false
		}
	}
	return true
}
