package main

import (
	"context"
	"github.com/intellisys-stevens/leviathan/model"
	"testing"
	"time"

	plugin "github.com/intellisys-stevens/leviathan/plugin/v1"
)

func TestFixturePluginConformance(t *testing.T) {
	if err := plugin.CheckSource(context.Background(), &fixtureSource{id: "example"}); err != nil {
		t.Fatal(err)
	}
}

func TestFixtureUsesCustomSourceAndExplicitJoins(t *testing.T) {
	s := &fixtureSource{id: "example"}
	at := time.Now().UTC()
	read := func(cap plugin.Capability) plugin.Observation {
		t.Helper()
		o, err := s.Read(context.Background(), cap, at)
		if err != nil {
			t.Fatal(err)
		}
		return o
	}
	gpu := read(plugin.GPU).GPU
	if gpu.Capabilities.GPU == nil || !gpu.Capabilities.GPU.Available || gpu.Capabilities.NVML.Available {
		t.Fatal("custom GPU capability was disguised as NVML")
	}
	if gpu.GPUs[0].Metrics["gpu_activity"].Source != model.MetricSource("example_fixture") {
		t.Fatal("missing custom source")
	}
	inventory := read(plugin.WorkloadInventory).WorkloadInventory
	process := read(plugin.Processes).Processes.Processes[0]
	allocation := read(plugin.Allocations).Allocations.Assignments[0]
	telemetry := read(plugin.WorkloadMeasurements).WorkloadMeasurements
	if inventory.Workloads[0].Platform == model.WorkloadPlatformCoder || inventory.Workloads[0].Kind == model.WorkloadKindWorkspace {
		t.Fatal("example is tied to Coder")
	}
	if process.ScopeRef != inventory.Scopes[0].ScopeRef || allocation.Resource.InstanceID != s.id || allocation.Resource.Generation != gpu.GPUs[0].Generation || telemetry.Owners[0].Ref != inventory.Owners[0].Ref {
		t.Fatal("fixture joins are inconsistent")
	}
}
