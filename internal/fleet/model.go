// Package fleet contains the controller-side model for observing multiple
// MIGLens agents. It deliberately wraps, rather than extends, model.Snapshot.
package fleet

import (
	"strings"
	"time"

	"github.com/intellisys-stevens/miglens/internal/model"
)

const SchemaVersion = "fleet-v1"

type PlatformKind string

const (
	PlatformKindHost      PlatformKind = "host"
	PlatformKindOpenStack PlatformKind = "openstack"
)

type Platform struct {
	ID           string       `json:"id"`
	DisplayName  string       `json:"displayName"`
	Kind         PlatformKind `json:"kind"`
	DashboardURL string       `json:"dashboardUrl,omitempty"`
}

type CloudState string

const (
	CloudStateActive           CloudState = "active"
	CloudStateShelved          CloudState = "shelved"
	CloudStateShelvedOffloaded CloudState = "shelved_offloaded"
	CloudStateShutoff          CloudState = "shutoff"
	CloudStateBuilding         CloudState = "building"
	CloudStatePaused           CloudState = "paused"
	CloudStateSuspended        CloudState = "suspended"
	CloudStateError            CloudState = "error"
	CloudStateUnknown          CloudState = "unknown"
)

func NormalizeCloudState(raw string) CloudState {
	switch strings.ToUpper(strings.TrimSpace(raw)) {
	case "ACTIVE":
		return CloudStateActive
	case "SHELVED":
		return CloudStateShelved
	case "SHELVED_OFFLOADED":
		return CloudStateShelvedOffloaded
	case "SHUTOFF", "STOPPED":
		return CloudStateShutoff
	case "BUILD", "REBUILD":
		return CloudStateBuilding
	case "PAUSED":
		return CloudStatePaused
	case "SUSPENDED":
		return CloudStateSuspended
	case "ERROR":
		return CloudStateError
	default:
		return CloudStateUnknown
	}
}

// Instance contains only inventory fields safe to expose through the fleet
// API. Cloud metadata, tags, credentials, and agent endpoints do not belong in
// this type.
type Instance struct {
	UUID            string     `json:"uuid"`
	Name            string     `json:"name"`
	CreatorUsername string     `json:"creatorUsername"`
	CloudState      CloudState `json:"cloudState"`
	RawCloudState   string     `json:"rawCloudState,omitempty"`
	Flavor          string     `json:"flavor,omitempty"`
}

type InventoryStatus string

const (
	InventoryAvailable   InventoryStatus = "available"
	InventoryStale       InventoryStatus = "stale"
	InventoryUnavailable InventoryStatus = "unavailable"
)

type InventoryHealth struct {
	Status        InventoryStatus `json:"status"`
	ObservedAt    *time.Time      `json:"observedAt,omitempty"`
	LastAttemptAt time.Time       `json:"lastAttemptAt"`
	LastSuccessAt *time.Time      `json:"lastSuccessAt,omitempty"`
	Message       string          `json:"message,omitempty"`
}

type AgentStatus string

const (
	AgentNotManaged   AgentStatus = "not_managed"
	AgentAvailable    AgentStatus = "available"
	AgentUnreachable  AgentStatus = "unreachable"
	AgentStale        AgentStatus = "stale"
	AgentIncompatible AgentStatus = "incompatible"
)

type PolicyReason string

const (
	PolicyAllowed         PolicyReason = "allowed"
	PolicyNotAllowlisted  PolicyReason = "not_allowlisted"
	PolicyCreatorMismatch PolicyReason = "creator_mismatch"
	PolicyCloudNotActive  PolicyReason = "cloud_not_active"
)

type AgentObservation struct {
	Status        AgentStatus      `json:"status"`
	LastAttemptAt *time.Time       `json:"lastAttemptAt,omitempty"`
	LastSuccessAt *time.Time       `json:"lastSuccessAt,omitempty"`
	ObservedAt    *time.Time       `json:"observedAt,omitempty"`
	BuildInfo     *model.BuildInfo `json:"buildInfo,omitempty"`
	Snapshot      *model.Snapshot  `json:"snapshot,omitempty"`
	Message       string           `json:"message,omitempty"`
}

type InstanceObservation struct {
	Instance           Instance         `json:"instance"`
	Managed            bool             `json:"managed"`
	AgentProbeEligible bool             `json:"agentProbeEligible"`
	PolicyReason       PolicyReason     `json:"policyReason"`
	Agent              AgentObservation `json:"agent"`
}

type PlatformObservation struct {
	Platform  Platform              `json:"platform"`
	Inventory InventoryHealth       `json:"inventory"`
	Instances []InstanceObservation `json:"instances"`
}

type Snapshot struct {
	SchemaVersion string                `json:"schemaVersion"`
	Sequence      uint64                `json:"sequence"`
	ObservedAt    time.Time             `json:"observedAt"`
	Platforms     []PlatformObservation `json:"platforms"`
}

// InventoryObservation is the sanitized result returned by an inventory
// source. Its Instances must not contain cloud metadata or credentials.
type InventoryObservation struct {
	ObservedAt time.Time
	Instances  []Instance
}

// AgentSample is a successful observation from one existing MIGLens agent.
// The controller keeps the nested Snapshot at schema v1 while applying a
// fleet-safe projection to free-form command and provider error fields.
type AgentSample struct {
	InstanceUUID string
	ObservedAt   time.Time
	BuildInfo    *model.BuildInfo
	Snapshot     model.Snapshot
}
