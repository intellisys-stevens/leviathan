package fleetuplink

import (
	"time"

	"github.com/intellisys-stevens/miglens/internal/fleet"
	"github.com/intellisys-stevens/miglens/internal/model"
)

func cloneAgentSample(input fleet.AgentSample) fleet.AgentSample {
	output := input
	if input.BuildInfo != nil {
		buildInfo := *input.BuildInfo
		output.BuildInfo = &buildInfo
	}
	output.Snapshot = cloneSnapshot(input.Snapshot)
	return output
}

func cloneSnapshot(input model.Snapshot) model.Snapshot {
	output := input
	output.GPUs = cloneSlice(input.GPUs)
	for index := range output.GPUs {
		output.GPUs[index] = cloneGPU(input.GPUs[index])
	}
	output.Processes = cloneSlice(input.Processes)
	for index := range output.Processes {
		output.Processes[index].StartTime = cloneTime(input.Processes[index].StartTime)
	}
	if input.Attribution != nil {
		attribution := *input.Attribution
		attribution.ObservedAt = cloneTime(input.Attribution.ObservedAt)
		attribution.Workloads = cloneSlice(input.Attribution.Workloads)
		attribution.Assignments = cloneSlice(input.Attribution.Assignments)
		output.Attribution = &attribution
	}
	output.Diagnostics = cloneSlice(input.Diagnostics)
	return output
}

func cloneGPU(input model.GPU) model.GPU {
	output := input
	output.Memory = cloneMemory(input.Memory)
	output.Metrics = cloneMetricSet(input.Metrics)
	output.GPUInstances = cloneSlice(input.GPUInstances)
	for index := range output.GPUInstances {
		output.GPUInstances[index] = cloneGPUInstance(input.GPUInstances[index])
	}
	return output
}

func cloneGPUInstance(input model.GPUInstance) model.GPUInstance {
	output := input
	output.Memory = cloneMemory(input.Memory)
	output.Metrics = cloneMetricSet(input.Metrics)
	output.ComputeInstances = cloneSlice(input.ComputeInstances)
	for index := range output.ComputeInstances {
		compute := input.ComputeInstances[index]
		compute.Memory = cloneMemory(compute.Memory)
		compute.Metrics = cloneMetricSet(compute.Metrics)
		compute.Diagnostics = cloneSlice(compute.Diagnostics)
		output.ComputeInstances[index] = compute
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
	output.TotalBytes = cloneUint64(input.TotalBytes)
	output.UsedBytes = cloneUint64(input.UsedBytes)
	output.FreeBytes = cloneUint64(input.FreeBytes)
	return output
}

func cloneUint64(input *uint64) *uint64 {
	if input == nil {
		return nil
	}
	value := *input
	return &value
}

func cloneTime(input *time.Time) *time.Time {
	if input == nil {
		return nil
	}
	value := *input
	return &value
}

func cloneSlice[T any](input []T) []T {
	if input == nil {
		return nil
	}
	output := make([]T, len(input))
	copy(output, input)
	return output
}
