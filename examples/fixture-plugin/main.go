// fixture-plugin is an independently supervised example. Every reading is
// synthetic fixture data, not a measurement of the machine running this binary.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/intellisys-stevens/leviathan/model"
	plugin "github.com/intellisys-stevens/leviathan/plugin/v1"
)

type fixtureSource struct {
	id       string
	revision atomic.Uint64
}

func (s *fixtureSource) Manifest() plugin.Manifest {
	return plugin.Manifest{ProtocolVersion: plugin.ProtocolVersion, ID: "fixture-example", Version: "1.0.0", Capabilities: map[plugin.Capability]string{plugin.Host: "1", plugin.GPU: "1", plugin.Processes: "1", plugin.WorkloadMeasurements: "1", plugin.WorkloadInventory: "1", plugin.Allocations: "1", plugin.GPUCapacity: "1"}}
}
func (s *fixtureSource) Open(context.Context) error { return nil }
func (s *fixtureSource) Close() error               { return nil }
func (s *fixtureSource) Read(ctx context.Context, capability plugin.Capability, at time.Time) (plugin.Observation, error) {
	if err := ctx.Err(); err != nil {
		return plugin.Observation{}, err
	}
	o := plugin.Observation{Capability: capability, InstanceID: s.id, SessionID: "fixture", Revision: s.revision.Add(1), ObservedAt: at, Status: "available"}
	metric := func(value float64, unit string, scope model.MetricScope) model.Metric {
		return model.AvailableMetric(value, unit, model.MetricSource("example_fixture"), scope, at)
	}
	workload := model.WorkloadAttribution{Ref: "job-a", Platform: "example-batch", Kind: "job", Name: "Synthetic batch job", OwnerName: "Example owner"}
	switch capability {
	case plugin.Host:
		o.Host = &plugin.HostData{System: model.System{SampledAt: at, Status: model.StatusAvailable, CPU: model.CPU{Model: "Synthetic CPU", LogicalProcessors: 8, Utilization: metric(25, "percent", model.ScopeHost), Load1: metric(1, "load", model.ScopeHost), Load5: metric(1, "load", model.ScopeHost), Load15: metric(1, "load", model.ScopeHost), Source: model.MetricSource("example_fixture"), SampledAt: at, Status: model.StatusAvailable}, Memory: model.SystemMemory{TotalBytes: model.Uint64(16 << 30), UsedBytes: model.Uint64(4 << 30), AvailableBytes: model.Uint64(12 << 30), Utilization: metric(25, "percent", model.ScopeHost), Source: model.MetricSource("example_fixture"), Scope: model.ScopeHost, SampledAt: at, Status: model.StatusAvailable}, Storage: model.Storage{ReadBytesPerSecond: metric(1024, "bytes_per_second", model.ScopeHost), WriteBytesPerSecond: metric(512, "bytes_per_second", model.ScopeHost), Filesystems: []model.Filesystem{}, Source: model.MetricSource("example_fixture"), Scope: model.ScopeHost, SampledAt: at, Status: model.StatusAvailable}}}
	case plugin.GPU:
		o.GPU = &plugin.GPUData{Capabilities: model.Capabilities{GPU: &model.ProviderState{Name: "example_fixture", Available: true, Status: model.StatusAvailable}}, GPUs: []model.GPU{{UUID: "GPU-example", Generation: "fixture-1", Name: "Synthetic GPU", Memory: model.Memory{TotalBytes: model.Uint64(16 << 30), UsedBytes: model.Uint64(2 << 30), FreeBytes: model.Uint64(14 << 30), Source: model.MetricSource("example_fixture"), Scope: model.ScopePhysicalGPU, SampledAt: at, Status: model.StatusAvailable}, Metrics: model.MetricSet{"gpu_activity": metric(50, "percent", model.ScopePhysicalGPU)}, GPUInstances: []model.GPUInstance{}}}}
	case plugin.Processes:
		o.Processes = &plugin.ProcessData{Capability: model.ProviderState{Name: "example_fixture", Available: true, Status: model.StatusAvailable}, Processes: []plugin.ProcessRecord{{Process: model.Process{PID: 1234, Executable: "synthetic-job", User: "fixture", Status: model.StatusAvailable}, ScopeRef: "scope-job-a"}}}
	case plugin.WorkloadMeasurements:
		o.WorkloadMeasurements = &model.WorkloadTelemetry{SampledAt: at, ObservedAt: &at, Status: model.WorkloadTelemetryAvailable, Owners: []model.WorkloadOwnerTelemetry{{Ref: "owner-a", Name: "Example owner", Platform: workload.Platform, Workspaces: []model.WorkloadAttribution{workload}, SampledAt: at, Status: model.WorkloadTelemetryAvailable, Metrics: model.MetricSet{"cpu_cores": metric(2, "cores", model.ScopeWorkloadOwner), "memory_used_bytes": metric(1<<30, "bytes", model.ScopeWorkloadOwner)}}}}
	case plugin.WorkloadInventory:
		o.WorkloadInventory = &plugin.InventoryData{Workloads: []model.WorkloadAttribution{workload}, Owners: []plugin.Owner{{Ref: "owner-a", Name: workload.OwnerName, Platform: workload.Platform, WorkloadRefs: []string{workload.Ref}}}, Scopes: []plugin.ScopeAssignment{{ScopeRef: "scope-job-a", WorkloadRef: workload.Ref, OwnerRef: "owner-a"}}}
	case plugin.Allocations:
		o.Allocations = &plugin.AllocationData{Workloads: []model.WorkloadAttribution{workload}, Assignments: []plugin.Assignment{{WorkloadRef: workload.Ref, Resource: plugin.ResourceRef{InstanceID: s.id, ID: "GPU-example", Generation: "fixture-1"}, EntityType: model.AllocationEntityPhysicalGPU, State: model.AllocationStateAllocated}}, Scopes: []plugin.ScopeAssignment{{ScopeRef: "scope-job-a", WorkloadRef: workload.Ref, OwnerRef: "owner-a"}}, Resolution: &model.AttributionResolution{Status: "complete", ReasonCodes: []string{}, Workloads: []model.WorkloadAssignmentResolution{}}}
	case plugin.GPUCapacity:
		memory, count := int64(16<<30), int64(1)
		o.GPUCapacity = &model.GPUCapacityDocument{Status: "available", ObservedAt: &at, Revision: o.Revision, Rows: []model.GPUCapacityRow{{ID: "capacity_00000000000000000000000000000001", Mode: "native", Model: "Synthetic GPU", MemoryBytes: &memory, Available: &count, Status: "available"}}}
	default:
		return plugin.Observation{}, errors.New("unsupported capability")
	}
	return o, nil
}

func main() {
	socket := flag.String("socket", "", "Unix socket path")
	id := flag.String("id", "example", "configured producer instance ID")
	flag.Parse()
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if err := plugin.ServeUnix(ctx, *socket, &fixtureSource{id: *id}, plugin.HandlerOptions{InstanceID: *id}); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
