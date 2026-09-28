package model

// NormalizeSnapshot completes sparse observations for the shared HTTP and CLI
// projection. It preserves source identifiers and times, never stamps arrival
// time, and never turns an absent measurement into zero. Nested mutable values
// are copied so normalization and callers cannot modify the source snapshot.
func NormalizeSnapshot(snapshot Snapshot) Snapshot {
	if snapshot.SchemaVersion == "" {
		snapshot.SchemaVersion = "v1"
	}
	snapshot.Capabilities = NormalizeCapabilities(snapshot.Capabilities)
	snapshot.System = normalizeSystem(snapshot.System)
	snapshot.GPUs = append([]GPU{}, snapshot.GPUs...)
	for i := range snapshot.GPUs {
		gpu := &snapshot.GPUs[i]
		gpu.Memory = normalizeMemory(gpu.Memory, ScopePhysicalGPU)
		gpu.Metrics = normalizeMetrics(gpu.Metrics, ScopePhysicalGPU)
		gpu.GPUInstances = append([]GPUInstance{}, gpu.GPUInstances...)
		for j := range gpu.GPUInstances {
			gi := &gpu.GPUInstances[j]
			gi.Memory = normalizeMemory(gi.Memory, ScopeGPUInstance)
			gi.Metrics = normalizeMetrics(gi.Metrics, ScopeGPUInstance)
			gi.ComputeInstances = append([]ComputeInstance{}, gi.ComputeInstances...)
			for k := range gi.ComputeInstances {
				ci := &gi.ComputeInstances[k]
				ci.Memory = normalizeMemory(ci.Memory, ScopeComputeInstance)
				ci.Metrics = normalizeMetrics(ci.Metrics, ScopeComputeInstance)
				ci.Diagnostics = normalizeDiagnostics(ci.Diagnostics)
			}
		}
	}
	snapshot.Diagnostics = normalizeDiagnostics(snapshot.Diagnostics)
	if snapshot.Attribution != nil {
		attribution := *snapshot.Attribution
		attribution.ObservedAt = copyPointer(attribution.ObservedAt)
		if attribution.Status == "" {
			attribution.Status = AttributionUnavailable
		}
		attribution.Workloads = normalizeWorkloads(attribution.Workloads)
		attribution.Assignments = append([]ResourceAssignment{}, attribution.Assignments...)
		if attribution.Resolution != nil {
			resolution := *attribution.Resolution
			if resolution.Status == "" {
				resolution.Status = "unknown"
			}
			resolution.ReasonCodes = append([]string{}, resolution.ReasonCodes...)
			resolution.Workloads = append([]WorkloadAssignmentResolution{}, resolution.Workloads...)
			for i := range resolution.Workloads {
				resolution.Workloads[i].ReasonCodes = append([]string{}, resolution.Workloads[i].ReasonCodes...)
			}
			attribution.Resolution = &resolution
		}
		snapshot.Attribution = &attribution
	}
	if snapshot.WorkloadTelemetry != nil {
		telemetry := *snapshot.WorkloadTelemetry
		telemetry.ObservedAt = copyPointer(telemetry.ObservedAt)
		if telemetry.Status == "" {
			telemetry.Status = WorkloadTelemetryUnavailable
		}
		telemetry.Owners = append([]WorkloadOwnerTelemetry{}, telemetry.Owners...)
		for i := range telemetry.Owners {
			owner := &telemetry.Owners[i]
			if owner.Platform == "" {
				owner.Platform = "unknown"
			}
			if owner.Status == "" {
				owner.Status = WorkloadTelemetryUnavailable
			}
			owner.Workspaces = normalizeWorkloads(owner.Workspaces)
			owner.Metrics = normalizeMetrics(owner.Metrics, ScopeWorkloadOwner)
		}
		snapshot.WorkloadTelemetry = &telemetry
	}
	validWorkloads := map[string]bool{}
	if snapshot.Attribution != nil {
		for _, workload := range snapshot.Attribution.Workloads {
			validWorkloads[workload.Ref] = true
		}
	}
	snapshot.Processes = append([]Process{}, snapshot.Processes...)
	for i := range snapshot.Processes {
		process := &snapshot.Processes[i]
		process.StartTime = copyPointer(process.StartTime)
		if process.Status == "" {
			process.Status = StatusUnsupported
		}
		if !validWorkloads[process.WorkloadRef] {
			process.WorkloadRef = ""
		}
	}
	return snapshot
}

// NormalizeCapabilities fills absent provider states without asserting that any
// implementation, including NVML, is available. Generic GPU capability remains
// optional and carries the source's actual identity when supplied.
func NormalizeCapabilities(capabilities Capabilities) Capabilities {
	normalize := func(state ProviderState, name string) ProviderState {
		if state.Name == "" {
			state.Name = name
		}
		if state.Status == "" {
			state.Status, state.Available = StatusUnsupported, false
		}
		return state
	}
	capabilities.System = normalize(capabilities.System, "Host telemetry")
	capabilities.NVML = normalize(capabilities.NVML, "NVML")
	capabilities.GPM = normalize(capabilities.GPM, "NVML GPM")
	capabilities.DCGM = normalize(capabilities.DCGM, "DCGM")
	capabilities.Proc = normalize(capabilities.Proc, "Process telemetry")
	if capabilities.GPU != nil {
		state := normalize(*capabilities.GPU, "GPU telemetry")
		capabilities.GPU = &state
	}
	return capabilities
}

func normalizeSystem(system System) System {
	cpu := &system.CPU
	cpu.Source = normalizeSource(cpu.Source)
	cpu.Status = normalizeStatus(cpu.Status)
	cpu.Utilization = normalizeMetric(cpu.Utilization, "percent", ScopeHost)
	cpu.Load1 = normalizeMetric(cpu.Load1, "load", ScopeHost)
	cpu.Load5 = normalizeMetric(cpu.Load5, "load", ScopeHost)
	cpu.Load15 = normalizeMetric(cpu.Load15, "load", ScopeHost)
	memory := &system.Memory
	memory.TotalBytes, memory.UsedBytes, memory.AvailableBytes = copyPointer(memory.TotalBytes), copyPointer(memory.UsedBytes), copyPointer(memory.AvailableBytes)
	if memory.Status == "" {
		memory.TotalBytes, memory.UsedBytes, memory.AvailableBytes = nil, nil, nil
	}
	memory.Source, memory.Scope, memory.Status = normalizeSource(memory.Source), normalizeScope(memory.Scope, ScopeHost), normalizeStatus(memory.Status)
	memory.Utilization = normalizeMetric(memory.Utilization, "percent", ScopeHost)
	storage := &system.Storage
	storage.TotalBytes, storage.UsedBytes, storage.AvailableBytes = copyPointer(storage.TotalBytes), copyPointer(storage.UsedBytes), copyPointer(storage.AvailableBytes)
	if storage.Status == "" {
		storage.TotalBytes, storage.UsedBytes, storage.AvailableBytes = nil, nil, nil
	}
	storage.Source, storage.Scope, storage.Status = normalizeSource(storage.Source), normalizeScope(storage.Scope, ScopeHost), normalizeStatus(storage.Status)
	storage.ReadBytesPerSecond = normalizeMetric(storage.ReadBytesPerSecond, "bytes_per_second", ScopeHost)
	storage.WriteBytesPerSecond = normalizeMetric(storage.WriteBytesPerSecond, "bytes_per_second", ScopeHost)
	storage.Filesystems = append([]Filesystem{}, storage.Filesystems...)
	for i := range storage.Filesystems {
		filesystem := &storage.Filesystems[i]
		filesystem.TotalBytes, filesystem.UsedBytes, filesystem.AvailableBytes = copyPointer(filesystem.TotalBytes), copyPointer(filesystem.UsedBytes), copyPointer(filesystem.AvailableBytes)
		filesystem.Source, filesystem.Scope, filesystem.Status = normalizeSource(filesystem.Source), normalizeScope(filesystem.Scope, ScopeHost), normalizeStatus(filesystem.Status)
	}
	if system.Uptime != nil {
		uptime := normalizeMetric(*system.Uptime, "seconds", ScopeHost)
		system.Uptime = &uptime
	}
	system.Status = normalizeStatus(system.Status)
	return system
}

func normalizeMetric(metric Metric, unit string, scope MetricScope) Metric {
	metric.Value = copyPointer(metric.Value)
	if metric.Status == "" {
		metric.Value = nil
		metric.Status = StatusUnsupported
	}
	if metric.Unit == "" {
		metric.Unit = unit
	}
	metric.Source, metric.Scope = normalizeSource(metric.Source), normalizeScope(metric.Scope, scope)
	return metric
}

func normalizeMemory(memory Memory, scope MetricScope) Memory {
	memory.TotalBytes, memory.UsedBytes, memory.FreeBytes = copyPointer(memory.TotalBytes), copyPointer(memory.UsedBytes), copyPointer(memory.FreeBytes)
	if memory.Status == "" {
		memory.TotalBytes, memory.UsedBytes, memory.FreeBytes = nil, nil, nil
	}
	memory.Source, memory.Scope, memory.Status = normalizeSource(memory.Source), normalizeScope(memory.Scope, scope), normalizeStatus(memory.Status)
	return memory
}

func normalizeMetrics(metrics MetricSet, scope MetricScope) MetricSet {
	result := make(MetricSet, len(metrics))
	for name, metric := range metrics {
		result[name] = normalizeMetric(metric, metricUnit(name), scope)
	}
	return result
}

func metricUnit(name string) string {
	switch name {
	case "gpu_activity", "sm_activity", "tensor_activity", "dram_activity", "memory_activity", "fp16_activity", "fp32_activity", "fp64_activity", "integer_activity", "occupancy", "sm_occupancy", "cpu_utilization", "memory_utilization":
		return "percent"
	case "temperature":
		return "celsius"
	case "power", "power_limit":
		return "watts"
	case "graphics_clock", "sm_clock", "memory_clock", "video_clock":
		return "mhz"
	case "pcie_rx_bytes_per_second", "pcie_tx_bytes_per_second", "storage_read_bps", "storage_write_bps":
		return "bytes_per_second"
	case "cpu_cores":
		return "cores"
	case "memory_used_bytes", "memory_total_bytes", "memory_free_bytes":
		return "bytes"
	}
	// A custom metric without a declared unit cannot be assigned a physical unit.
	return "unknown"
}
func normalizeSource(source MetricSource) MetricSource {
	if source == "" {
		return SourceUnknown
	}
	return source
}
func normalizeScope(scope, fallback MetricScope) MetricScope {
	if scope == "" {
		return fallback
	}
	return scope
}
func normalizeStatus(status MetricStatus) MetricStatus {
	if status == "" {
		return StatusUnsupported
	}
	return status
}
func normalizeDiagnostics(diagnostics []Diagnostic) []Diagnostic {
	result := append([]Diagnostic{}, diagnostics...)
	for i := range result {
		result[i].Status = normalizeStatus(result[i].Status)
		if result[i].Severity == "" {
			result[i].Severity = "info"
		}
	}
	return result
}
func normalizeWorkloads(workloads []WorkloadAttribution) []WorkloadAttribution {
	result := append([]WorkloadAttribution{}, workloads...)
	for i := range result {
		if result[i].Platform == "" {
			result[i].Platform = "unknown"
		}
		if result[i].Kind == "" {
			result[i].Kind = "unknown"
		}
	}
	return result
}
func copyPointer[T any](value *T) *T {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}
