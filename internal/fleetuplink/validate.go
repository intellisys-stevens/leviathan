package fleetuplink

import (
	"fmt"
	"math"
	"time"
	"unicode/utf8"

	"github.com/intellisys-stevens/leviathan/internal/fleet"
	"github.com/intellisys-stevens/leviathan/internal/model"
)

type sampleCounts struct {
	gpuInstances int
	compute      int
	diagnostics  int
	metrics      int
}

func validateSample(sample fleet.AgentSample, now time.Time, config Config) error {
	snapshot := sample.Snapshot
	if snapshot.SchemaVersion != "v1" {
		return ErrIncompatibleSchema
	}
	if snapshot.SampledAt.IsZero() {
		return fmt.Errorf("%w: sampledAt is required", ErrInvalidSample)
	}
	if snapshot.SampledAt.After(now.Add(config.MaxFutureSkew)) {
		return ErrSampleInFuture
	}
	if snapshot.SampledAt.Before(now.Add(-config.MaxSampleAge)) {
		return ErrSampleTooOld
	}
	latestAllowedAt := now.Add(config.MaxFutureSkew)
	if snapshot.GPUs == nil || snapshot.Processes == nil || snapshot.Diagnostics == nil {
		return fmt.Errorf("%w: required snapshot collections must not be nil", ErrInvalidSample)
	}
	if len(snapshot.GPUs) > config.MaxGPUs || len(snapshot.Processes) > config.MaxProcesses {
		return fmt.Errorf("%w: snapshot collection limit exceeded", ErrInvalidSample)
	}

	validator := fieldValidator{maxBytes: config.MaxFieldBytes}
	if err := validator.required("host.hostname", snapshot.Host.Hostname); err != nil {
		return err
	}
	if err := validator.required("host.os", snapshot.Host.OS); err != nil {
		return err
	}
	if err := validator.required("host.arch", snapshot.Host.Arch); err != nil {
		return err
	}
	if err := validateBuildInfo(sample.BuildInfo, validator); err != nil {
		return err
	}
	if err := validateCapabilities(snapshot.Capabilities, validator); err != nil {
		return err
	}

	counts := sampleCounts{diagnostics: len(snapshot.Diagnostics)}
	if counts.diagnostics > config.MaxDiagnostics {
		return fmt.Errorf("%w: diagnostic limit exceeded", ErrInvalidSample)
	}
	for _, diagnostic := range snapshot.Diagnostics {
		if err := validateDiagnostic(diagnostic, validator); err != nil {
			return err
		}
	}
	for _, process := range snapshot.Processes {
		if err := validateProcess(process, latestAllowedAt, validator); err != nil {
			return err
		}
	}
	for _, gpu := range snapshot.GPUs {
		if err := validateGPU(gpu, latestAllowedAt, validator, &counts, config); err != nil {
			return err
		}
	}
	if snapshot.Attribution != nil {
		if err := validateAttribution(*snapshot.Attribution, latestAllowedAt, validator, config); err != nil {
			return err
		}
	}
	return nil
}

type fieldValidator struct {
	maxBytes int
}

func (v fieldValidator) optional(name, value string) error {
	if len(value) > v.maxBytes || !utf8.ValidString(value) {
		return fmt.Errorf("%w: field %s exceeds its limit or is not UTF-8", ErrInvalidSample, name)
	}
	return nil
}

func (v fieldValidator) required(name, value string) error {
	if value == "" {
		return fmt.Errorf("%w: field %s is required", ErrInvalidSample, name)
	}
	return v.optional(name, value)
}

func validateBuildInfo(buildInfo *model.BuildInfo, validator fieldValidator) error {
	if buildInfo == nil {
		return nil
	}
	for name, value := range map[string]string{
		"buildInfo.version":   buildInfo.Version,
		"buildInfo.commit":    buildInfo.Commit,
		"buildInfo.buildDate": buildInfo.BuildDate,
	} {
		if err := validator.optional(name, value); err != nil {
			return err
		}
	}
	return nil
}

func validateCapabilities(capabilities model.Capabilities, validator fieldValidator) error {
	providers := []struct {
		name  string
		state model.ProviderState
	}{
		{name: "nvml", state: capabilities.NVML},
		{name: "gpm", state: capabilities.GPM},
		{name: "dcgm", state: capabilities.DCGM},
		{name: "proc", state: capabilities.Proc},
	}
	for _, provider := range providers {
		if err := validator.required("capabilities."+provider.name+".name", provider.state.Name); err != nil {
			return err
		}
		if !validMetricStatus(provider.state.Status) {
			return fmt.Errorf("%w: capabilities.%s.status is unsupported", ErrInvalidSample, provider.name)
		}
		if provider.state.Available != (provider.state.Status == model.StatusAvailable) {
			return fmt.Errorf("%w: capabilities.%s availability contradicts status", ErrInvalidSample, provider.name)
		}
		if err := validator.required("capabilities."+provider.name+".status", string(provider.state.Status)); err != nil {
			return err
		}
		if err := validator.optional("capabilities."+provider.name+".message", provider.state.Message); err != nil {
			return err
		}
	}
	return nil
}

func validateProcess(process model.Process, latestAllowedAt time.Time, validator fieldValidator) error {
	if !validMetricStatus(process.Status) {
		return fmt.Errorf("%w: process status is unsupported", ErrInvalidSample)
	}
	if process.StartTime != nil && (process.StartTime.IsZero() || process.StartTime.After(latestAllowedAt)) {
		return fmt.Errorf("%w: process startTime is invalid", ErrInvalidSample)
	}
	for name, value := range map[string]string{
		"process.user":        process.User,
		"process.executable":  process.Executable,
		"process.commandLine": process.CommandLine,
		"process.workloadRef": process.WorkloadRef,
		"process.scopeRef":    process.ScopeRef,
		"process.status":      string(process.Status),
		"process.message":     process.Message,
	} {
		if err := validator.optional(name, value); err != nil {
			return err
		}
	}
	return nil
}

func validateGPU(gpu model.GPU, latestAllowedAt time.Time, validator fieldValidator, counts *sampleCounts, config Config) error {
	if gpu.Metrics == nil || gpu.GPUInstances == nil {
		return fmt.Errorf("%w: required GPU collections must not be nil", ErrInvalidSample)
	}
	if gpu.Index < 0 || gpu.MaxMIGDevices < 0 {
		return fmt.Errorf("%w: GPU index and maxMIGDevices must not be negative", ErrInvalidSample)
	}
	for name, value := range map[string]string{
		"gpu.uuid":     gpu.UUID,
		"gpu.name":     gpu.Name,
		"gpu.pciBusId": gpu.PCIBusID,
	} {
		if err := validator.optional(name, value); err != nil {
			return err
		}
	}
	if err := validateMemory(gpu.Memory, latestAllowedAt, validator); err != nil {
		return err
	}
	if err := validateMetrics(gpu.Metrics, latestAllowedAt, validator, counts, config); err != nil {
		return err
	}
	counts.gpuInstances += len(gpu.GPUInstances)
	if counts.gpuInstances > config.MaxGPUInstances {
		return fmt.Errorf("%w: GPU instance limit exceeded", ErrInvalidSample)
	}
	for _, gpuInstance := range gpu.GPUInstances {
		if err := validateGPUInstance(gpuInstance, latestAllowedAt, validator, counts, config); err != nil {
			return err
		}
	}
	return nil
}

func validateGPUInstance(instance model.GPUInstance, latestAllowedAt time.Time, validator fieldValidator, counts *sampleCounts, config Config) error {
	if instance.Metrics == nil || instance.ComputeInstances == nil {
		return fmt.Errorf("%w: required GPU instance collections must not be nil", ErrInvalidSample)
	}
	for name, value := range map[string]string{
		"gpuInstance.uuid":       instance.UUID,
		"gpuInstance.profile":    instance.Profile,
		"gpuInstance.generation": instance.Generation,
	} {
		if err := validator.optional(name, value); err != nil {
			return err
		}
	}
	if err := validateMemory(instance.Memory, latestAllowedAt, validator); err != nil {
		return err
	}
	if err := validateMetrics(instance.Metrics, latestAllowedAt, validator, counts, config); err != nil {
		return err
	}
	counts.compute += len(instance.ComputeInstances)
	if counts.compute > config.MaxComputeInstances {
		return fmt.Errorf("%w: compute instance limit exceeded", ErrInvalidSample)
	}
	for _, compute := range instance.ComputeInstances {
		if err := validateCompute(compute, latestAllowedAt, validator, counts, config); err != nil {
			return err
		}
	}
	return nil
}

func validateCompute(compute model.ComputeInstance, latestAllowedAt time.Time, validator fieldValidator, counts *sampleCounts, config Config) error {
	if compute.Metrics == nil {
		return fmt.Errorf("%w: compute instance metrics must not be nil", ErrInvalidSample)
	}
	for name, value := range map[string]string{
		"computeInstance.uuid":       compute.UUID,
		"computeInstance.profile":    compute.Profile,
		"computeInstance.generation": compute.Generation,
	} {
		if err := validator.optional(name, value); err != nil {
			return err
		}
	}
	if err := validateMemory(compute.Memory, latestAllowedAt, validator); err != nil {
		return err
	}
	if err := validateMetrics(compute.Metrics, latestAllowedAt, validator, counts, config); err != nil {
		return err
	}
	counts.diagnostics += len(compute.Diagnostics)
	if counts.diagnostics > config.MaxDiagnostics {
		return fmt.Errorf("%w: diagnostic limit exceeded", ErrInvalidSample)
	}
	for _, diagnostic := range compute.Diagnostics {
		if err := validateDiagnostic(diagnostic, validator); err != nil {
			return err
		}
	}
	return nil
}

func validateMemory(memory model.Memory, latestAllowedAt time.Time, validator fieldValidator) error {
	if !validMetricSource(memory.Source) || !validMetricScope(memory.Scope) || !validMetricStatus(memory.Status) {
		return fmt.Errorf("%w: memory source, scope, or status is unsupported", ErrInvalidSample)
	}
	if err := validateMeasurementTime("memory.sampledAt", memory.SampledAt, latestAllowedAt); err != nil {
		return err
	}
	if memory.Status == model.StatusAvailable {
		if memory.TotalBytes == nil || memory.UsedBytes == nil || memory.FreeBytes == nil {
			return fmt.Errorf("%w: available memory requires total, used, and free values", ErrInvalidSample)
		}
		if *memory.UsedBytes > *memory.TotalBytes || *memory.FreeBytes > *memory.TotalBytes {
			return fmt.Errorf("%w: available memory values exceed total", ErrInvalidSample)
		}
	} else if memory.UsedBytes != nil || memory.FreeBytes != nil {
		return fmt.Errorf("%w: unavailable memory must not expose used or free values", ErrInvalidSample)
	}
	for name, value := range map[string]string{
		"memory.source":  string(memory.Source),
		"memory.scope":   string(memory.Scope),
		"memory.status":  string(memory.Status),
		"memory.message": memory.Message,
	} {
		if err := validator.optional(name, value); err != nil {
			return err
		}
	}
	return nil
}

func validateMetrics(metrics model.MetricSet, latestAllowedAt time.Time, validator fieldValidator, counts *sampleCounts, config Config) error {
	counts.metrics += len(metrics)
	if counts.metrics > config.MaxMetrics {
		return fmt.Errorf("%w: metric limit exceeded", ErrInvalidSample)
	}
	for name, metric := range metrics {
		if err := validator.required("metric.name", name); err != nil {
			return err
		}
		if !validMetricSource(metric.Source) || !validMetricScope(metric.Scope) || !validMetricStatus(metric.Status) {
			return fmt.Errorf("%w: metric source, scope, or status is unsupported", ErrInvalidSample)
		}
		if err := validateMeasurementTime("metric.sampledAt", metric.SampledAt, latestAllowedAt); err != nil {
			return err
		}
		if metric.Status == model.StatusAvailable && metric.Value == nil {
			return fmt.Errorf("%w: available metric requires a value", ErrInvalidSample)
		}
		if metric.Status != model.StatusAvailable && metric.Value != nil {
			return fmt.Errorf("%w: unavailable metric must not expose a value", ErrInvalidSample)
		}
		for field, value := range map[string]string{
			"metric.unit":    metric.Unit,
			"metric.source":  string(metric.Source),
			"metric.scope":   string(metric.Scope),
			"metric.status":  string(metric.Status),
			"metric.message": metric.Message,
		} {
			if err := validator.optional(field, value); err != nil {
				return err
			}
		}
		if metric.Value != nil && (math.IsNaN(*metric.Value) || math.IsInf(*metric.Value, 0)) {
			return fmt.Errorf("%w: metric value must be finite", ErrInvalidSample)
		}
	}
	return nil
}

func validateMeasurementTime(name string, sampledAt, latestAllowedAt time.Time) error {
	if sampledAt.IsZero() || sampledAt.After(latestAllowedAt) {
		return fmt.Errorf("%w: %s is zero or exceeds the allowed future skew", ErrInvalidSample, name)
	}
	return nil
}

func validateDiagnostic(diagnostic model.Diagnostic, validator fieldValidator) error {
	if !validDiagnosticSeverity(diagnostic.Severity) || !validMetricStatus(diagnostic.Status) {
		return fmt.Errorf("%w: diagnostic severity or status is unsupported", ErrInvalidSample)
	}
	for name, value := range map[string]string{
		"diagnostic.code":      diagnostic.Code,
		"diagnostic.severity":  diagnostic.Severity,
		"diagnostic.component": diagnostic.Component,
		"diagnostic.summary":   diagnostic.Summary,
		"diagnostic.detail":    diagnostic.Detail,
		"diagnostic.remedy":    diagnostic.Remedy,
		"diagnostic.status":    string(diagnostic.Status),
	} {
		if err := validator.optional(name, value); err != nil {
			return err
		}
	}
	return nil
}

func validateAttribution(attribution model.Attribution, latestAllowedAt time.Time, validator fieldValidator, config Config) error {
	if attribution.Workloads == nil || attribution.Assignments == nil {
		return fmt.Errorf("%w: required attribution collections must not be nil", ErrInvalidSample)
	}
	if len(attribution.Workloads) > config.MaxWorkloads || len(attribution.Assignments) > config.MaxAssignments {
		return fmt.Errorf("%w: attribution collection limit exceeded", ErrInvalidSample)
	}
	if attribution.Provider != model.AttributionProviderKubernetesDRA || !validAttributionStatus(attribution.Status) {
		return fmt.Errorf("%w: attribution provider or status is unsupported", ErrInvalidSample)
	}
	if attribution.Status == model.AttributionUnavailable {
		if attribution.ObservedAt != nil || len(attribution.Workloads) != 0 || len(attribution.Assignments) != 0 {
			return fmt.Errorf("%w: unavailable attribution must not expose retained state", ErrInvalidSample)
		}
	} else {
		if attribution.ObservedAt == nil {
			return fmt.Errorf("%w: available or stale attribution requires observedAt", ErrInvalidSample)
		}
		if err := validateMeasurementTime("attribution.observedAt", *attribution.ObservedAt, latestAllowedAt); err != nil {
			return err
		}
	}
	if err := validator.required("attribution.provider", attribution.Provider); err != nil {
		return err
	}
	if err := validator.required("attribution.status", string(attribution.Status)); err != nil {
		return err
	}
	for _, workload := range attribution.Workloads {
		if !validWorkloadPlatform(workload.Platform) || !validWorkloadKind(workload.Kind) {
			return fmt.Errorf("%w: workload platform or kind is unsupported", ErrInvalidSample)
		}
		for name, value := range map[string]string{
			"workload.ref":       workload.Ref,
			"workload.platform":  string(workload.Platform),
			"workload.kind":      string(workload.Kind),
			"workload.name":      workload.Name,
			"workload.ownerName": workload.OwnerName,
		} {
			if err := validator.optional(name, value); err != nil {
				return err
			}
		}
	}
	for _, assignment := range attribution.Assignments {
		if !validAllocationEntityType(assignment.EntityType) || !validAllocationState(assignment.State) {
			return fmt.Errorf("%w: assignment entity type or state is unsupported", ErrInvalidSample)
		}
		for name, value := range map[string]string{
			"assignment.workloadRef": assignment.WorkloadRef,
			"assignment.entityType":  string(assignment.EntityType),
			"assignment.entityUuid":  assignment.EntityUUID,
			"assignment.state":       string(assignment.State),
		} {
			if err := validator.optional(name, value); err != nil {
				return err
			}
		}
	}
	return nil
}

// The model uses string-backed types, so JSON decoding alone accepts arbitrary
// values. These allowlists deliberately mirror the public v1 OpenAPI enums and
// must be reviewed when that contract gains a new value.
func validMetricStatus(value model.MetricStatus) bool {
	switch value {
	case model.StatusAvailable, model.StatusUnsupported, model.StatusPermissionDenied, model.StatusStale, model.StatusError:
		return true
	default:
		return false
	}
}

func validMetricSource(value model.MetricSource) bool {
	switch value {
	case model.SourceNVML, model.SourceNVMLGPM, model.SourceDCGM, model.SourceProc, model.SourceSynthetic:
		return true
	default:
		return false
	}
}

func validMetricScope(value model.MetricScope) bool {
	switch value {
	case model.ScopeHost, model.ScopePhysicalGPU, model.ScopeGPUInstance, model.ScopeComputeInstance:
		return true
	default:
		return false
	}
}

func validDiagnosticSeverity(value string) bool {
	switch value {
	case "info", "warning", "error":
		return true
	default:
		return false
	}
}

func validAttributionStatus(value model.AttributionStatus) bool {
	switch value {
	case model.AttributionAvailable, model.AttributionStale, model.AttributionUnavailable:
		return true
	default:
		return false
	}
}

func validWorkloadPlatform(value model.WorkloadPlatform) bool {
	return value == model.WorkloadPlatformCoder
}

func validWorkloadKind(value model.WorkloadKind) bool {
	return value == model.WorkloadKindWorkspace
}

func validAllocationEntityType(value model.AllocationEntityType) bool {
	switch value {
	case model.AllocationEntityPhysicalGPU, model.AllocationEntityComputeInstance:
		return true
	default:
		return false
	}
}

func validAllocationState(value model.AllocationState) bool {
	switch value {
	case model.AllocationStateAllocated, model.AllocationStateReserved:
		return true
	default:
		return false
	}
}
