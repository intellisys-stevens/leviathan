package fleet

import (
	"time"

	"github.com/intellisys-stevens/leviathan/internal/model"
)

func cloneSnapshot(input Snapshot) Snapshot {
	output := input
	output.Platforms = make([]PlatformObservation, len(input.Platforms))
	for platformIndex, platform := range input.Platforms {
		output.Platforms[platformIndex] = platform
		output.Platforms[platformIndex].Inventory = cloneInventoryHealth(platform.Inventory)
		output.Platforms[platformIndex].Instances = make([]InstanceObservation, len(platform.Instances))
		for instanceIndex, instance := range platform.Instances {
			output.Platforms[platformIndex].Instances[instanceIndex] = instance
			output.Platforms[platformIndex].Instances[instanceIndex].Agent = cloneAgentObservation(instance.Agent)
		}
	}
	return output
}

func cloneInventoryHealth(input InventoryHealth) InventoryHealth {
	output := input
	output.ObservedAt = cloneTime(input.ObservedAt)
	output.LastSuccessAt = cloneTime(input.LastSuccessAt)
	return output
}

func cloneAgentObservation(input AgentObservation) AgentObservation {
	output := input
	output.LastAttemptAt = cloneTime(input.LastAttemptAt)
	output.LastSuccessAt = cloneTime(input.LastSuccessAt)
	output.ObservedAt = cloneTime(input.ObservedAt)
	if input.BuildInfo != nil {
		buildInfo := *input.BuildInfo
		output.BuildInfo = &buildInfo
	}
	if input.Snapshot != nil {
		snapshot := cloneModelSnapshot(*input.Snapshot)
		output.Snapshot = &snapshot
	}
	return output
}

func cloneBuildInfo(input *model.BuildInfo) *model.BuildInfo {
	if input == nil {
		return nil
	}
	output := *input
	return &output
}

// sanitizedModelSnapshot is the fleet-safe projection of a trusted agent
// Snapshot. The local agent API remains unchanged, while fields most likely to
// contain command arguments or raw provider errors are omitted at the hub.
func sanitizedModelSnapshot(input model.Snapshot) model.Snapshot {
	output := cloneModelSnapshot(input)
	output.Capabilities.NVML.Message = ""
	output.Capabilities.GPM.Message = ""
	output.Capabilities.DCGM.Message = ""
	output.Capabilities.Proc.Message = ""
	for index := range output.Processes {
		output.Processes[index].CommandLine = ""
		output.Processes[index].Message = ""
	}
	for index := range output.Diagnostics {
		output.Diagnostics[index].Detail = ""
	}
	for gpuIndex := range output.GPUs {
		sanitizeMetricSet(output.GPUs[gpuIndex].Metrics)
		output.GPUs[gpuIndex].Memory.Message = ""
		for gpuInstanceIndex := range output.GPUs[gpuIndex].GPUInstances {
			gpuInstance := &output.GPUs[gpuIndex].GPUInstances[gpuInstanceIndex]
			sanitizeMetricSet(gpuInstance.Metrics)
			gpuInstance.Memory.Message = ""
			for computeIndex := range gpuInstance.ComputeInstances {
				compute := &gpuInstance.ComputeInstances[computeIndex]
				sanitizeMetricSet(compute.Metrics)
				compute.Memory.Message = ""
				for diagnosticIndex := range compute.Diagnostics {
					compute.Diagnostics[diagnosticIndex].Detail = ""
				}
			}
		}
	}
	return output
}

func sanitizeMetricSet(metrics model.MetricSet) {
	for name, metric := range metrics {
		metric.Message = ""
		metrics[name] = metric
	}
}

func cloneModelSnapshot(input model.Snapshot) model.Snapshot {
	output := input
	output.GPUs = make([]model.GPU, len(input.GPUs))
	for gpuIndex, gpu := range input.GPUs {
		output.GPUs[gpuIndex] = cloneGPU(gpu)
	}
	output.Processes = make([]model.Process, len(input.Processes))
	for processIndex, process := range input.Processes {
		output.Processes[processIndex] = process
		output.Processes[processIndex].StartTime = cloneTime(process.StartTime)
	}
	if input.Attribution != nil {
		attribution := *input.Attribution
		attribution.ObservedAt = cloneTime(input.Attribution.ObservedAt)
		attribution.Workloads = append([]model.WorkloadAttribution(nil), input.Attribution.Workloads...)
		attribution.Assignments = append([]model.ResourceAssignment(nil), input.Attribution.Assignments...)
		output.Attribution = &attribution
	}
	output.Diagnostics = append([]model.Diagnostic{}, input.Diagnostics...)
	return output
}

func cloneGPU(input model.GPU) model.GPU {
	output := input
	output.Memory = cloneMemory(input.Memory)
	output.Metrics = cloneMetricSet(input.Metrics)
	output.GPUInstances = make([]model.GPUInstance, len(input.GPUInstances))
	for index, instance := range input.GPUInstances {
		output.GPUInstances[index] = cloneGPUInstance(instance)
	}
	return output
}

func cloneGPUInstance(input model.GPUInstance) model.GPUInstance {
	output := input
	output.Memory = cloneMemory(input.Memory)
	output.Metrics = cloneMetricSet(input.Metrics)
	output.ComputeInstances = make([]model.ComputeInstance, len(input.ComputeInstances))
	for index, instance := range input.ComputeInstances {
		output.ComputeInstances[index] = instance
		output.ComputeInstances[index].Memory = cloneMemory(instance.Memory)
		output.ComputeInstances[index].Metrics = cloneMetricSet(instance.Metrics)
		output.ComputeInstances[index].Diagnostics = append([]model.Diagnostic(nil), instance.Diagnostics...)
	}
	return output
}

func cloneMetricSet(input model.MetricSet) model.MetricSet {
	if input == nil {
		return nil
	}
	output := make(model.MetricSet, len(input))
	for name, metric := range input {
		if metric.Value != nil {
			value := *metric.Value
			metric.Value = &value
		}
		output[name] = metric
	}
	return output
}

func cloneMemory(input model.Memory) model.Memory {
	output := input
	if input.TotalBytes != nil {
		value := *input.TotalBytes
		output.TotalBytes = &value
	}
	if input.UsedBytes != nil {
		value := *input.UsedBytes
		output.UsedBytes = &value
	}
	if input.FreeBytes != nil {
		value := *input.FreeBytes
		output.FreeBytes = &value
	}
	return output
}

func cloneTime(input *time.Time) *time.Time {
	if input == nil {
		return nil
	}
	value := *input
	return &value
}
