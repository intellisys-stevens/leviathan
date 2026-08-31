// Package model contains MIGLens' provider-neutral wire model.
package model

import "time"

type MetricStatus string

const (
	StatusAvailable        MetricStatus = "available"
	StatusUnsupported      MetricStatus = "unsupported"
	StatusPermissionDenied MetricStatus = "permission_denied"
	StatusStale            MetricStatus = "stale"
	StatusError            MetricStatus = "error"
)

type MetricSource string

const (
	SourceNVML      MetricSource = "nvml"
	SourceNVMLGPM   MetricSource = "nvml_gpm"
	SourceDCGM      MetricSource = "dcgm"
	SourceProc      MetricSource = "proc"
	SourceSynthetic MetricSource = "synthetic"
)

type MetricScope string

const (
	ScopeHost            MetricScope = "host"
	ScopePhysicalGPU     MetricScope = "physical_gpu"
	ScopeGPUInstance     MetricScope = "gpu_instance"
	ScopeComputeInstance MetricScope = "compute_instance"
)

// Metric is an explicitly scoped measurement. A nil Value is never interpreted as zero.
type Metric struct {
	Value     *float64     `json:"value"`
	Unit      string       `json:"unit"`
	Source    MetricSource `json:"source"`
	Scope     MetricScope  `json:"scope"`
	SampledAt time.Time    `json:"sampledAt"`
	Status    MetricStatus `json:"status"`
	Message   string       `json:"message,omitempty"`
}

// Memory keeps byte values integral on the wire while retaining metric provenance.
type Memory struct {
	TotalBytes *uint64      `json:"totalBytes"`
	UsedBytes  *uint64      `json:"usedBytes"`
	FreeBytes  *uint64      `json:"freeBytes"`
	Source     MetricSource `json:"source"`
	Scope      MetricScope  `json:"scope"`
	SampledAt  time.Time    `json:"sampledAt"`
	Status     MetricStatus `json:"status"`
	Message    string       `json:"message,omitempty"`
}

type Process struct {
	PID         uint32     `json:"pid"`
	User        string     `json:"user,omitempty"`
	Executable  string     `json:"executable,omitempty"`
	CommandLine string     `json:"commandLine,omitempty"`
	StartTime   *time.Time `json:"startTime,omitempty"`
	WorkloadRef string     `json:"workloadRef,omitempty"`
	// ScopeRef is an internal, opaque join key derived from a Kubernetes Pod
	// UID. It must never cross the public API boundary.
	ScopeRef string       `json:"-"`
	Status   MetricStatus `json:"status"`
	Message  string       `json:"message,omitempty"`
}

type WorkloadPlatform string

const (
	WorkloadPlatformCoder WorkloadPlatform = "coder"
)

type WorkloadKind string

const (
	WorkloadKindWorkspace WorkloadKind = "workspace"
)

type AllocationEntityType string

const (
	AllocationEntityPhysicalGPU     AllocationEntityType = "physical_gpu"
	AllocationEntityComputeInstance AllocationEntityType = "compute_instance"
)

type AllocationState string

const (
	AllocationStateAllocated AllocationState = "allocated"
	AllocationStateReserved  AllocationState = "reserved"
)

// WorkloadAttribution is sanitized display identity supplied by an optional
// attribution source. Ref is opaque and source-scoped rather than an upstream ID.
type WorkloadAttribution struct {
	Ref       string           `json:"ref"`
	Platform  WorkloadPlatform `json:"platform"`
	Kind      WorkloadKind     `json:"kind"`
	Name      string           `json:"name"`
	OwnerName string           `json:"ownerName"`
}

// ResourceAssignment associates a scheduler-assigned device with a workload.
// It does not assert that a process is actively using the device.
type ResourceAssignment struct {
	WorkloadRef string               `json:"workloadRef"`
	EntityType  AllocationEntityType `json:"entityType"`
	EntityUUID  string               `json:"entityUuid"`
	State       AllocationState      `json:"state"`
}

type AttributionStatus string

const (
	AttributionAvailable   AttributionStatus = "available"
	AttributionStale       AttributionStatus = "stale"
	AttributionUnavailable AttributionStatus = "unavailable"
)

const AttributionProviderKubernetesDRA = "kubernetes_dra"

type Attribution struct {
	Provider    string                `json:"provider"`
	Status      AttributionStatus     `json:"status"`
	ObservedAt  *time.Time            `json:"observedAt,omitempty"`
	Workloads   []WorkloadAttribution `json:"workloads"`
	Assignments []ResourceAssignment  `json:"assignments"`
}

type ComputeInstance struct {
	UUID        string       `json:"uuid"`
	ID          uint32       `json:"id"`
	Profile     string       `json:"profile"`
	Memory      Memory       `json:"memory"`
	Metrics     MetricSet    `json:"metrics"`
	Generation  string       `json:"generation"`
	Diagnostics []Diagnostic `json:"diagnostics,omitempty"`
}

type GPUInstance struct {
	UUID             string            `json:"uuid"`
	ID               uint32            `json:"id"`
	Profile          string            `json:"profile"`
	Generation       string            `json:"generation"`
	Memory           Memory            `json:"memory"`
	Metrics          MetricSet         `json:"metrics"`
	ComputeInstances []ComputeInstance `json:"computeInstances"`
}

type GPU struct {
	UUID          string        `json:"uuid"`
	Index         int           `json:"index"`
	Name          string        `json:"name"`
	PCIBusID      string        `json:"pciBusId,omitempty"`
	MIGEnabled    bool          `json:"migEnabled"`
	MaxMIGDevices int           `json:"maxMigDevices"`
	Memory        Memory        `json:"memory"`
	Metrics       MetricSet     `json:"metrics"`
	GPUInstances  []GPUInstance `json:"gpuInstances"`
}

type MetricSet map[string]Metric

type ProviderState struct {
	Name      string       `json:"name"`
	Available bool         `json:"available"`
	Status    MetricStatus `json:"status"`
	Message   string       `json:"message,omitempty"`
}

type Capabilities struct {
	NVML           ProviderState `json:"nvml"`
	GPM            ProviderState `json:"gpm"`
	DCGM           ProviderState `json:"dcgm"`
	Proc           ProviderState `json:"proc"`
	ProfileMetrics bool          `json:"profileMetrics"`
}

type Diagnostic struct {
	Code      string       `json:"code"`
	Severity  string       `json:"severity"`
	Component string       `json:"component"`
	Summary   string       `json:"summary"`
	Detail    string       `json:"detail,omitempty"`
	Remedy    string       `json:"remedy,omitempty"`
	Status    MetricStatus `json:"status"`
}

type Host struct {
	Hostname string `json:"hostname"`
	OS       string `json:"os"`
	Arch     string `json:"arch"`
}

// RuntimeSettings are process-local controls exposed by the dashboard. They
// are intentionally separate from persisted configuration.
type RuntimeSettings struct {
	SamplingIntervalMs         int64   `json:"samplingIntervalMs"`
	ProfileIntervalMs          int64   `json:"profileIntervalMs"`
	ProcessIntervalMs          int64   `json:"processIntervalMs"`
	HistoryWindowMs            int64   `json:"historyWindowMs"`
	AllowedSamplingIntervalsMs []int64 `json:"allowedSamplingIntervalsMs"`
}

// BuildInfo identifies the running MIGLens binary. These values are supplied
// at build time and are read-only for the lifetime of the process.
type BuildInfo struct {
	Version   string `json:"version"`
	Commit    string `json:"commit"`
	BuildDate string `json:"buildDate"`
}

type Snapshot struct {
	SchemaVersion string       `json:"schemaVersion"`
	Sequence      uint64       `json:"sequence"`
	SampledAt     time.Time    `json:"sampledAt"`
	Host          Host         `json:"host"`
	GPUs          []GPU        `json:"gpus"`
	Processes     []Process    `json:"processes"`
	Attribution   *Attribution `json:"attribution,omitempty"`
	Capabilities  Capabilities `json:"capabilities"`
	Diagnostics   []Diagnostic `json:"diagnostics"`
}

func Float(value float64) *float64 { return &value }
func Uint64(value uint64) *uint64  { return &value }

func UnavailableMetric(unit string, source MetricSource, scope MetricScope, at time.Time, status MetricStatus, message string) Metric {
	return Metric{Unit: unit, Source: source, Scope: scope, SampledAt: at, Status: status, Message: message}
}

func AvailableMetric(value float64, unit string, source MetricSource, scope MetricScope, at time.Time) Metric {
	return Metric{Value: Float(value), Unit: unit, Source: source, Scope: scope, SampledAt: at, Status: StatusAvailable}
}

func UnavailableMemory(source MetricSource, scope MetricScope, at time.Time, status MetricStatus, message string) Memory {
	return Memory{Source: source, Scope: scope, SampledAt: at, Status: status, Message: message}
}
