// Package fleet contains the controller-side model for observing multiple
// Leviathan agents. It deliberately wraps, rather than extends, model.Snapshot.
package fleet

import (
	"strings"
	"time"

	"github.com/intellisys-stevens/leviathan/internal/model"
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

// Instance contains sanitized inventory plus one controller-only identity pin.
// Cloud metadata, tags, credentials, agent endpoints, and CreatorID never cross
// the fleet API boundary.
type Instance struct {
	UUID            string `json:"uuid"`
	Name            string `json:"name"`
	CreatorUsername string `json:"creatorUsername"`
	// CreatorID is the authoritative Nova user_id used only for controller
	// policy evaluation. It must never cross the fleet API boundary.
	CreatorID     string            `json:"-"`
	CloudState    CloudState        `json:"cloudState"`
	RawCloudState string            `json:"rawCloudState,omitempty"`
	Flavor        string            `json:"flavor,omitempty"`
	Capacity      *InstanceCapacity `json:"capacity,omitempty"`
}

// InstanceCapacity is the static Nova flavor allocation for one instance. It
// describes provisioned capacity only; it must never be presented as live CPU,
// memory, or disk utilization.
type InstanceCapacity struct {
	VCPUs       int64 `json:"vcpus"`
	RAMMiB      int64 `json:"ramMiB"`
	RootDiskGiB int64 `json:"rootDiskGiB"`
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
	AgentNotManaged    AgentStatus = "not_managed"
	AgentNotConfigured AgentStatus = "not_configured"
	AgentAvailable     AgentStatus = "available"
	AgentUnreachable   AgentStatus = "unreachable"
	AgentStale         AgentStatus = "stale"
	AgentIncompatible  AgentStatus = "incompatible"
)

// TelemetrySource identifies the transport and fidelity of a successful
// observation. It is deliberately separate from model.MetricSource: one fleet
// observation can contain metrics from several local providers while still
// arriving through one controller-side transport.
type TelemetrySource string

const (
	TelemetrySourceLeviathanAgent   TelemetrySource = "leviathan_agent"
	TelemetrySourceExosphereConsole TelemetrySource = "exosphere_console"
	TelemetrySourceLeviathanUplink  TelemetrySource = "leviathan_uplink"
)

type PolicyReason string

const (
	PolicyAllowed            PolicyReason = "allowed"
	PolicyNotAllowlisted     PolicyReason = "not_allowlisted"
	PolicyCreatorMismatch    PolicyReason = "creator_mismatch"
	PolicyCloudNotActive     PolicyReason = "cloud_not_active"
	PolicyAgentNotConfigured PolicyReason = "agent_not_configured"
)

type AgentObservation struct {
	Status        AgentStatus      `json:"status"`
	Source        TelemetrySource  `json:"source,omitempty"`
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

// AgentSample is a successful observation from one existing Leviathan agent.
// The controller keeps the nested Snapshot at schema v1 while applying a
// fleet-safe projection to free-form command and provider error fields.
type AgentSample struct {
	InstanceUUID string
	// CreatorID is populated only for authenticated fleet uplinks. It remains an
	// internal authorization/accounting value and never crosses the public API.
	CreatorID  string
	Source     TelemetrySource
	ObservedAt time.Time
	BuildInfo  *model.BuildInfo
	Snapshot   model.Snapshot
}
