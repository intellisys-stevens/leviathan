package uplink

import (
	"encoding/json"
	"time"
)

const EndpointPathV2 = "/api/uplink/v2/snapshots"
const SchemaV2 = "uplink-v2"

// EnvelopeV2 describes capabilities independently of collector or hardware
// implementations. Memory and metrics retain explicit units and availability.
type EnvelopeV2 struct {
	Schema       string                     `json:"schema"`
	StreamID     string                     `json:"streamId"`
	Sequence     uint64                     `json:"sequence"`
	SampledAt    time.Time                  `json:"sampledAt"`
	Agent        Agent                      `json:"agent"`
	Host         Host                       `json:"host"`
	System       System                     `json:"system"`
	Health       Health                     `json:"health"`
	Accelerators []Accelerator              `json:"accelerators"`
	Capabilities []Capability               `json:"capabilities"`
	Network      MetricSet                  `json:"network,omitempty"`
	Extensions   map[string]json.RawMessage `json:"extensions,omitempty"`
}
type Accelerator struct {
	ID         string      `json:"id"`
	Kind       string      `json:"kind"`
	Vendor     string      `json:"vendor"`
	Model      string      `json:"model"`
	Memory     Memory      `json:"memory"`
	Metrics    MetricSet   `json:"metrics"`
	Partitions []Partition `json:"partitions"`
}
type Partition struct {
	ID       string    `json:"id"`
	ParentID string    `json:"parentId"`
	Kind     string    `json:"kind"`
	Profile  string    `json:"profile"`
	Memory   Memory    `json:"memory"`
	Metrics  MetricSet `json:"metrics"`
}
type Capability struct {
	ID     string `json:"id"`
	Status string `json:"status"`
	Source string `json:"source"`
}

// ToV2 adapts the current collector's sanitized observation. New collectors can
// construct EnvelopeV2 directly without supplying NVIDIA-specific MIG fields.
func ToV2(v1 Envelope) EnvelopeV2 {
	v2 := EnvelopeV2{Schema: SchemaV2, StreamID: v1.StreamID, Sequence: v1.Sequence, SampledAt: v1.SampledAt, Agent: v1.Agent, Host: v1.Host, System: v1.System, Health: v1.Health, Accelerators: []Accelerator{}, Capabilities: []Capability{}}
	status := func(value HealthStatus) string {
		switch value {
		case HealthOK:
			return "available"
		case HealthDegraded:
			return "degraded"
		default:
			return "unavailable"
		}
	}
	v2.Capabilities = append(v2.Capabilities, Capability{ID: "host.system", Status: status(v1.Health.System.Status), Source: v1.System.CPU.Source})
	v2.Capabilities = append(v2.Capabilities, Capability{ID: "accelerator.inventory", Status: status(v1.Health.GPU.Status), Source: "leviathan"})
	for _, gpu := range v1.GPUs {
		vendor := "unknown"
		switch gpu.Memory.Source {
		case "nvml", "nvml_gpm", "dcgm":
			vendor = "nvidia"
		case "synthetic":
			vendor = "synthetic"
		}
		device := Accelerator{ID: gpu.UUID, Kind: "gpu", Vendor: vendor, Model: gpu.Name, Memory: gpu.Memory, Metrics: gpu.Metrics, Partitions: []Partition{}}
		for _, instance := range gpu.GPUInstances {
			device.Partitions = append(device.Partitions, Partition{ID: instance.UUID, ParentID: gpu.UUID, Kind: "gpu_instance", Profile: instance.Profile, Memory: instance.Memory, Metrics: instance.Metrics})
			for _, compute := range instance.ComputeInstances {
				device.Partitions = append(device.Partitions, Partition{ID: compute.UUID, ParentID: instance.UUID, Kind: "compute_instance", Profile: compute.Profile, Memory: compute.Memory, Metrics: compute.Metrics})
			}
		}
		v2.Accelerators = append(v2.Accelerators, device)
	}
	if len(v1.GPUs) > 0 {
		v2.Capabilities = append(v2.Capabilities, Capability{ID: "gpu.telemetry", Status: status(v1.Health.GPU.Status), Source: v1.GPUs[0].Memory.Source})
	}
	return v2
}
