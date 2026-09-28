package uplink

import (
	"errors"

	"github.com/intellisys-stevens/leviathan/model"
)

// ErrUnsupportedObservation skips an envelope whose required host fields cannot
// be represented by the independently versioned uplink contract.
var ErrUnsupportedObservation = errors.New("required host observations are not representable in uplink v1")

func metricRepresentable(metric model.Metric) bool {
	return safeMetricSource(metric.Source) != "" && safeMetricUnit(metric.Unit) != "" && safeMetricScope(metric.Scope) != ""
}
func memoryRepresentable(memory model.Memory) bool {
	return safeMetricSource(memory.Source) != "" && safeMetricScope(memory.Scope) != ""
}
func systemRepresentable(system model.System) bool {
	if safeMetricSource(system.CPU.Source) == "" || safeMetricSource(system.Memory.Source) == "" || safeMetricSource(system.Storage.Source) == "" {
		return false
	}
	if safeMetricScope(system.Memory.Scope) == "" || safeMetricScope(system.Storage.Scope) == "" {
		return false
	}
	for _, metric := range []model.Metric{system.CPU.Utilization, system.CPU.Load1, system.CPU.Load5, system.CPU.Load15, system.Memory.Utilization, system.Storage.ReadBytesPerSecond, system.Storage.WriteBytesPerSecond} {
		if !metricRepresentable(metric) {
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
		return []model.Diagnostic{diagnostic("uplink_incompatible_host", "Uplink v1 skips this snapshot because required host observations use unsupported sources, units, or scopes")}
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
		return []model.Diagnostic{diagnostic("uplink_omitted_observations", "Uplink v1 omits optional observations with unsupported metric names, sources, units, or scopes; local telemetry is preserved")}
	}
	return nil
}
