package uplink

import (
	"errors"

	"github.com/intellisys-stevens/leviathan/model"
)

// ErrUnsupportedObservation skips an envelope whose required host fields cannot
// be represented by the independently versioned uplink contract.
var ErrUnsupportedObservation = errors.New("required host observations are not representable in uplink v1")

func metricRepresentable(metric model.Metric) bool {
	return (projectionPolicy{}).metricRepresentable(metric)
}
func memoryRepresentable(memory model.Memory) bool {
	return (projectionPolicy{}).memoryRepresentable(memory)
}
func systemRepresentable(system model.System) bool {
	return (projectionPolicy{}).systemRepresentable(system)
}

func (policy projectionPolicy) source(source model.MetricSource) string {
	if policy.portable {
		return portableIdentifier(string(source), 128)
	}
	return safeMetricSource(source)
}
func (policy projectionPolicy) scope(scope model.MetricScope) string {
	if policy.portable {
		return portableIdentifier(string(scope), 128)
	}
	return safeMetricScope(scope)
}
func (policy projectionPolicy) unit(unit string) string {
	if policy.portable {
		return portableIdentifier(unit, 64)
	}
	return safeMetricUnit(unit)
}
func (policy projectionPolicy) metricName(name string) bool {
	if policy.portable {
		return portableIdentifier(name, 128) != ""
	}
	_, known := safeGPUMetrics[name]
	return known
}
func portableIdentifier(value string, limit int) string {
	if value != "" && boundedPrintable(value, limit) == value {
		return value
	}
	return ""
}
func (policy projectionPolicy) metricRepresentable(metric model.Metric) bool {
	return policy.source(metric.Source) != "" && policy.unit(metric.Unit) != "" && policy.scope(metric.Scope) != ""
}
func (policy projectionPolicy) memoryRepresentable(memory model.Memory) bool {
	return policy.source(memory.Source) != "" && policy.scope(memory.Scope) != ""
}
func (policy projectionPolicy) systemRepresentable(system model.System) bool {
	if policy.source(system.CPU.Source) == "" || policy.source(system.Memory.Source) == "" || policy.source(system.Storage.Source) == "" {
		return false
	}
	if policy.scope(system.Memory.Scope) == "" || policy.scope(system.Storage.Scope) == "" {
		return false
	}
	for _, metric := range []model.Metric{system.CPU.Utilization, system.CPU.Load1, system.CPU.Load5, system.CPU.Load15, system.Memory.Utilization, system.Storage.ReadBytesPerSecond, system.Storage.WriteBytesPerSecond} {
		if !policy.metricRepresentable(metric) {
			return false
		}
	}
	return true
}

// CompatibilityDiagnostics reports local omissions without expanding or
// relabeling the uplink vocabulary. Detail never crosses the uplink boundary.
func CompatibilityDiagnostics(snapshot model.Snapshot) []model.Diagnostic {
	diagnostic := func(code, message string) model.Diagnostic {
		return model.Diagnostic{Code: code, Severity: "warning", Component: "uplink", Summary: message, Status: model.StatusUnsupported}
	}
	if !systemRepresentable(snapshot.System) {
		return []model.Diagnostic{diagnostic("uplink_incompatible_host", "Required host observations are not representable by uplink v1; portable identifiers remain available to uplink v2")}
	}
	omitted := false
	for _, filesystem := range snapshot.System.Storage.Filesystems {
		omitted = omitted || safeMetricSource(filesystem.Source) == "" || safeMetricScope(filesystem.Scope) == ""
	}
	var checkMetrics = func(metrics model.MetricSet) {
		for name, metric := range metrics {
			if _, known := safeGPUMetrics[name]; !known || !metricRepresentable(metric) {
				omitted = true
			}
		}
	}
	for _, gpu := range snapshot.GPUs {
		omitted = omitted || !memoryRepresentable(gpu.Memory)
		checkMetrics(gpu.Metrics)
		for _, gi := range gpu.GPUInstances {
			omitted = omitted || !memoryRepresentable(gi.Memory)
			checkMetrics(gi.Metrics)
			for _, ci := range gi.ComputeInstances {
				omitted = omitted || !memoryRepresentable(ci.Memory)
				checkMetrics(ci.Metrics)
			}
		}
	}
	if omitted {
		return []model.Diagnostic{diagnostic("uplink_omitted_observations", "Some optional observations are not representable by uplink v1; local telemetry and portable uplink v2 identifiers are preserved")}
	}
	return nil
}
