package uplink

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"io"
	"math"
	"path"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/intellisys-stevens/leviathan/model"
)

const (
	streamIDBytes             = 16
	maximumGPUs               = 64
	maximumFilesystems        = 256
	maximumSafeDiagnostics    = 128
	maximumDiagnosticCode     = 128
	maximumDiagnosticSummary  = 512
	maximumIdentityFieldBytes = 1024
)

var (
	ErrInvalidStreamID = errors.New("uplink stream ID is invalid")
	ErrInvalidSequence = errors.New("uplink sequence is invalid")
	ErrInvalidSnapshot = errors.New("uplink snapshot is invalid")
)

// Remote diagnostics are a closed vocabulary with server-owned summaries.
// Local details, process counts, paths, users, and provider error strings must
// never become an uplink side channel.
var safeRemoteDiagnostics = map[string]string{
	"system_cpu_partial":       "CPU telemetry is partially unavailable",
	"system_memory_partial":    "Memory telemetry is partially unavailable",
	"system_storage_partial":   "Storage telemetry is partially unavailable",
	"system_cpu":               "CPU telemetry is unavailable",
	"system_memory":            "Memory telemetry is unavailable",
	"system_storage":           "Storage telemetry is unavailable",
	"system_sample":            "Host telemetry is unavailable",
	"gpu_provider_unavailable": "GPU telemetry is unavailable",
	"collector_sample":         "GPU sample delayed",
	"nvml":                     "NVIDIA telemetry is unavailable",
	"gpu_handle":               "GPU telemetry device is unavailable",
	"gpu_uuid":                 "Stable GPU identity is unavailable",
	"mig_mode":                 "MIG mode is unavailable",
	"mig_enumeration":          "MIG topology is unavailable",
	"mig_handle":               "MIG device is unavailable",
	"mig_identity":             "MIG identity is unavailable",
	"gpm_profile_paused":       "GPU profiling counters are unavailable",
	"dcgm_profile_paused":      "GPU profiling counters are unavailable",
	"dcgm_topology":            "GPU topology telemetry is unavailable",
	"dcgm_update":              "GPU profiling telemetry is unavailable",
}

// NewStreamID returns a random, per-process stream ID. A new ID must be made
// each time serve starts; it is intentionally not a durable machine identity.
func NewStreamID() (string, error) {
	return newStreamID(rand.Reader)
}

func newStreamID(reader io.Reader) (string, error) {
	if reader == nil {
		return "", ErrInvalidStreamID
	}
	value := make([]byte, streamIDBytes)
	if _, err := io.ReadFull(reader, value); err != nil {
		return "", ErrInvalidStreamID
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}

func validStreamID(value string) bool {
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	return err == nil && len(decoded) == streamIDBytes && base64.RawURLEncoding.EncodeToString(decoded) == value
}

// Project constructs an independent, deeply copied, sanitized wire envelope.
// sequence is the stream-local upload sequence, not the collector sequence.
func Project(snapshot model.Snapshot, build model.BuildInfo, streamID string, sequence uint64) (Envelope, error) {
	return project(snapshot, build, streamID, sequence, projectionPolicy{})
}

// The v2 transport shares the sanitized host/GPU structure but permits portable
// provenance and metric names. V1 retains its independently locked vocabulary.
type projectionPolicy struct {
	portable         bool
	remainingMetrics *int
}

func project(snapshot model.Snapshot, build model.BuildInfo, streamID string, sequence uint64, policy projectionPolicy) (Envelope, error) {
	if !validStreamID(streamID) {
		return Envelope{}, ErrInvalidStreamID
	}
	if sequence == 0 {
		return Envelope{}, ErrInvalidSequence
	}
	if snapshot.SampledAt.IsZero() {
		return Envelope{}, ErrInvalidSnapshot
	}
	if !policy.systemRepresentable(snapshot.System) {
		if policy.portable {
			return Envelope{}, ErrInvalidSnapshot
		}
		return Envelope{}, ErrUnsupportedObservation
	}

	if policy.portable {
		remainingMetrics := 32768
		policy.remainingMetrics = &remainingMetrics
	}
	envelope := Envelope{
		Schema:    Schema,
		StreamID:  streamID,
		Sequence:  sequence,
		SampledAt: snapshot.SampledAt.UTC(),
		Agent: Agent{
			Version:   boundedPrintable(build.Version, maximumIdentityFieldBytes),
			Commit:    boundedPrintable(build.Commit, maximumIdentityFieldBytes),
			BuildDate: boundedPrintable(build.BuildDate, maximumIdentityFieldBytes),
		},
		Host: Host{
			Hostname: boundedPrintable(snapshot.Host.Hostname, maximumIdentityFieldBytes),
			OS:       boundedPrintable(snapshot.Host.OS, maximumIdentityFieldBytes),
			Arch:     boundedPrintable(snapshot.Host.Arch, maximumIdentityFieldBytes),
		},
		System: policy.projectSystem(snapshot.System),
		GPUs:   policy.projectGPUs(snapshot.GPUs),
	}
	envelope.Health = projectHealth(snapshot, len(envelope.GPUs))
	return envelope, nil
}

func (policy projectionPolicy) projectSystem(system model.System) System {
	filesystems := make([]Filesystem, 0, min(len(system.Storage.Filesystems), maximumFilesystems))
	for _, filesystem := range system.Storage.Filesystems {
		if policy.source(filesystem.Source) == "" || policy.scope(filesystem.Scope) == "" {
			continue
		}
		if len(filesystems) == maximumFilesystems {
			break
		}
		mountPoint, ok := normalizedMountPoint(filesystem.MountPoint)
		if !ok {
			continue
		}
		filesystemType := boundedPrintable(filesystem.FSType, 64)
		if filesystemType == "" {
			continue
		}
		filesystems = append(filesystems, Filesystem{
			ID:             opaqueFilesystemID(filesystem.ID, mountPoint, filesystemType),
			MountPoint:     mountPoint,
			FSType:         filesystemType,
			TotalBytes:     copyUint64(filesystem.TotalBytes),
			UsedBytes:      copyUint64(filesystem.UsedBytes),
			AvailableBytes: copyUint64(filesystem.AvailableBytes),
			Source:         string(filesystem.Source),
			Scope:          policy.scope(filesystem.Scope),
			SampledAt:      filesystem.SampledAt.UTC(),
			Status:         MetricStatus(filesystem.Status),
		})
	}

	return System{
		CPU: CPU{
			Model:             boundedPrintable(system.CPU.Model, maximumIdentityFieldBytes),
			LogicalProcessors: system.CPU.LogicalProcessors,
			Utilization:       policy.projectMetric(system.CPU.Utilization),
			Load1:             policy.projectMetric(system.CPU.Load1),
			Load5:             policy.projectMetric(system.CPU.Load5),
			Load15:            policy.projectMetric(system.CPU.Load15),
			Source:            policy.source(system.CPU.Source),
			SampledAt:         system.CPU.SampledAt.UTC(),
			Status:            MetricStatus(system.CPU.Status),
		},
		Memory: SystemMemory{
			TotalBytes:     copyUint64(system.Memory.TotalBytes),
			UsedBytes:      copyUint64(system.Memory.UsedBytes),
			AvailableBytes: copyUint64(system.Memory.AvailableBytes),
			Utilization:    policy.projectMetric(system.Memory.Utilization),
			Source:         policy.source(system.Memory.Source),
			Scope:          policy.scope(system.Memory.Scope),
			SampledAt:      system.Memory.SampledAt.UTC(),
			Status:         MetricStatus(system.Memory.Status),
		},
		Storage: Storage{
			TotalBytes:          copyUint64(system.Storage.TotalBytes),
			UsedBytes:           copyUint64(system.Storage.UsedBytes),
			AvailableBytes:      copyUint64(system.Storage.AvailableBytes),
			ReadBytesPerSecond:  policy.projectMetric(system.Storage.ReadBytesPerSecond),
			WriteBytesPerSecond: policy.projectMetric(system.Storage.WriteBytesPerSecond),
			Filesystems:         filesystems,
			Source:              string(system.Storage.Source),
			Scope:               policy.scope(system.Storage.Scope),
			SampledAt:           system.Storage.SampledAt.UTC(),
			Status:              MetricStatus(system.Storage.Status),
		},
		SampledAt: system.SampledAt.UTC(),
		Status:    MetricStatus(system.Status),
	}
}

func (policy projectionPolicy) projectGPUs(source []model.GPU) []GPU {
	result := make([]GPU, 0, min(len(source), maximumGPUs))
	admitted := make([]model.GPU, 0, cap(result))
	// Reserve measured physical-device metrics before a large partition tree
	// consumes the shared v2 budget. Every admitted device retains its evidence.
	for _, gpu := range source {
		if !policy.memoryRepresentable(gpu.Memory) || (policy.portable && portableIdentifier(gpu.UUID, maximumIdentityFieldBytes) == "") {
			continue
		}
		if len(result) == maximumGPUs {
			break
		}
		result = append(result, GPU{
			UUID: boundedPrintable(gpu.UUID, maximumIdentityFieldBytes), Index: gpu.Index,
			Name:       boundedPrintable(gpu.Name, maximumIdentityFieldBytes),
			MIGEnabled: gpu.MIGEnabled, MaxMIGDevices: gpu.MaxMIGDevices,
			Memory: policy.projectGPUMemory(gpu.Memory), Metrics: policy.projectMetricSet(gpu.Metrics),
			GPUInstances: []GPUInstance{},
		})
		admitted = append(admitted, gpu)
	}
	remainingPartitions := 4096
	for index, gpu := range admitted {
		for _, instance := range gpu.GPUInstances {
			if policy.portable && remainingPartitions == 0 {
				break
			}
			if !policy.memoryRepresentable(instance.Memory) || (policy.portable && portableIdentifier(instance.UUID, maximumIdentityFieldBytes) == "") {
				continue
			}
			remainingPartitions--
			projected := GPUInstance{
				UUID: boundedPrintable(instance.UUID, maximumIdentityFieldBytes), ID: instance.ID,
				Profile: boundedPrintable(instance.Profile, maximumIdentityFieldBytes),
				Memory:  policy.projectGPUMemory(instance.Memory), Metrics: policy.projectMetricSet(instance.Metrics),
				ComputeInstances: []ComputeInstance{},
			}
			for _, compute := range instance.ComputeInstances {
				if policy.portable && remainingPartitions == 0 {
					break
				}
				if !policy.memoryRepresentable(compute.Memory) || (policy.portable && portableIdentifier(compute.UUID, maximumIdentityFieldBytes) == "") {
					continue
				}
				remainingPartitions--
				projected.ComputeInstances = append(projected.ComputeInstances, ComputeInstance{
					UUID: boundedPrintable(compute.UUID, maximumIdentityFieldBytes), ID: compute.ID,
					Profile: boundedPrintable(compute.Profile, maximumIdentityFieldBytes),
					Memory:  policy.projectGPUMemory(compute.Memory), Metrics: policy.projectMetricSet(compute.Metrics),
				})
			}
			result[index].GPUInstances = append(result[index].GPUInstances, projected)
		}
	}
	return result
}

func (policy projectionPolicy) projectGPUMemory(memory model.Memory) Memory {
	return Memory{
		TotalBytes:     copyUint64(memory.TotalBytes),
		UsedBytes:      copyUint64(memory.UsedBytes),
		AvailableBytes: copyUint64(memory.FreeBytes),
		Source:         policy.source(memory.Source),
		Scope:          policy.scope(memory.Scope),
		SampledAt:      memory.SampledAt.UTC(),
		Status:         MetricStatus(memory.Status),
	}
}

var safeGPUMetrics = map[string]struct{}{
	"gpu_activity": {}, "sm_activity": {}, "sm_occupancy": {},
	"tensor_activity": {}, "dram_activity": {}, "memory_activity": {},
	"temperature": {}, "power": {}, "power_limit": {},
	"sm_clock": {}, "memory_clock": {},
	"pcie_tx_bytes_per_second": {}, "pcie_rx_bytes_per_second": {},
}

func (policy projectionPolicy) projectMetricSet(source model.MetricSet) MetricSet {
	result := make(MetricSet)
	names := make([]string, 0, len(source))
	for name := range source {
		names = append(names, name)
	}
	slices.Sort(names)
	for _, name := range names {
		if policy.remainingMetrics != nil && *policy.remainingMetrics == 0 {
			break
		}
		metric := source[name]
		if policy.metricName(name) && policy.metricRepresentable(metric) {
			result[name] = policy.projectMetric(metric)
			if policy.remainingMetrics != nil {
				*policy.remainingMetrics--
			}
		}
	}
	return result
}

func (policy projectionPolicy) projectMetric(metric model.Metric) Metric {
	value := copyFloat64(metric.Value)
	status := string(metric.Status)
	if value != nil && (math.IsNaN(*value) || math.IsInf(*value, 0)) {
		value = nil
		status = string(model.StatusError)
	}
	return Metric{
		Value:     value,
		Unit:      policy.unit(metric.Unit),
		Source:    policy.source(metric.Source),
		Scope:     policy.scope(metric.Scope),
		SampledAt: metric.SampledAt.UTC(),
		Status:    MetricStatus(status),
	}
}

func safeMetricUnit(unit string) string {
	switch unit {
	case "percent", "load", "bytes_per_second", "celsius", "watts", "mhz":
		return unit
	default:
		return ""
	}
}

func safeMetricSource(source model.MetricSource) string {
	switch source {
	case model.SourceNVML, model.SourceNVMLGPM, model.SourceDCGM, model.SourceProc, model.SourceProcFS, model.SourceStatFS, model.SourceSynthetic:
		return string(source)
	default:
		return ""
	}
}

func safeMetricScope(scope model.MetricScope) string {
	switch scope {
	case model.ScopeHost, model.ScopePhysicalGPU, model.ScopeGPUInstance, model.ScopeComputeInstance:
		return string(scope)
	default:
		return ""
	}
}

func projectHealth(snapshot model.Snapshot, representedGPUs int) Health {
	system := DomainHealth{Status: healthForMetricStatus(snapshot.System.Status), SampledAt: snapshot.System.SampledAt.UTC()}
	if system.SampledAt.IsZero() {
		system.SampledAt = snapshot.SampledAt.UTC()
	}
	gpu := DomainHealth{Status: HealthUnavailable, SampledAt: snapshot.SampledAt.UTC()}
	if representedGPUs > 0 {
		gpu.Status = HealthOK
		state := snapshot.Capabilities.NVML
		if snapshot.Capabilities.GPU != nil {
			state = *snapshot.Capabilities.GPU
		}
		if state.Status == model.StatusStale || state.Status == model.StatusError || state.Status == model.StatusPermissionDenied {
			gpu.Status = HealthDegraded
		}
	}

	diagnostics := make([]SafeDiagnostic, 0, min(len(snapshot.Diagnostics), maximumSafeDiagnostics))
	for _, diagnostic := range snapshot.Diagnostics {
		if len(diagnostics) == maximumSafeDiagnostics {
			break
		}
		summary, allowed := safeRemoteDiagnostics[diagnostic.Code]
		if !allowed {
			continue
		}
		diagnostics = append(diagnostics, SafeDiagnostic{
			Code:     diagnostic.Code,
			Severity: safeDiagnosticSeverity(diagnostic.Severity),
			Summary:  summary,
			Status:   MetricStatus(diagnostic.Status),
		})
	}

	overall := HealthDegraded
	if system.Status == HealthOK && gpu.Status == HealthOK {
		overall = HealthOK
	} else if system.Status == HealthUnavailable && gpu.Status == HealthUnavailable {
		overall = HealthUnavailable
	}
	return Health{Status: overall, System: system, GPU: gpu, Diagnostics: diagnostics}
}

func safeDiagnosticSeverity(severity string) string {
	switch severity {
	case "info", "warning", "error":
		return severity
	default:
		return "warning"
	}
}

func healthForMetricStatus(status model.MetricStatus) HealthStatus {
	switch status {
	case model.StatusAvailable, model.StatusEstimated:
		return HealthOK
	case model.StatusStale:
		return HealthDegraded
	default:
		return HealthUnavailable
	}
}

func opaqueFilesystemID(localID, mountPoint, filesystemType string) string {
	digest := sha256.Sum256([]byte("leviathan-uplink-v1\x00" + localID + "\x00" + mountPoint + "\x00" + filesystemType))
	return "fs_" + base64.RawURLEncoding.EncodeToString(digest[:16])
}

func normalizedMountPoint(value string) (string, bool) {
	if value == "" || len(value) > 4096 || !utf8.ValidString(value) || value[0] != '/' || containsControl(value) {
		return "", false
	}
	return path.Clean(value), true
}

func boundedPrintable(value string, maximumBytes int) string {
	if value == "" || maximumBytes <= 0 || !utf8.ValidString(value) || containsControl(value) {
		return ""
	}
	if len(value) <= maximumBytes {
		return value
	}
	value = value[:maximumBytes]
	for !utf8.ValidString(value) {
		value = value[:len(value)-1]
	}
	return value
}

func containsControl(value string) bool {
	return strings.IndexFunc(value, unicode.IsControl) >= 0
}

func copyFloat64(value *float64) *float64 {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func copyUint64(value *uint64) *uint64 {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}
