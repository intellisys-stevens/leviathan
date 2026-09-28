package app

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/intellisys-stevens/leviathan/adapters/kubernetes/attribution"
	"github.com/intellisys-stevens/leviathan/internal/collector"
	"github.com/intellisys-stevens/leviathan/internal/config"
	"github.com/intellisys-stevens/leviathan/internal/gpucapacity"
	"github.com/intellisys-stevens/leviathan/internal/plugins"
	"github.com/intellisys-stevens/leviathan/internal/process"
	"github.com/intellisys-stevens/leviathan/internal/provider"
	systemtelemetry "github.com/intellisys-stevens/leviathan/internal/system"
	"github.com/intellisys-stevens/leviathan/internal/workload"
	"github.com/intellisys-stevens/leviathan/model"
	v1 "github.com/intellisys-stevens/leviathan/plugin/v1"
)

type nativeSource struct {
	id, implementation, session string
	capabilities                map[v1.Capability]string
	open                        func(context.Context) error
	read                        func(context.Context, v1.Capability, time.Time) (v1.Observation, error)
	close                       func() error
	mu                          sync.Mutex
	revisions                   map[v1.Capability]uint64
	timestamps                  map[v1.Capability]time.Time
}

func newNative(id, name string, capabilities ...v1.Capability) *nativeSource {
	result := &nativeSource{id: id, implementation: name, session: fmt.Sprintf("%d", time.Now().UnixNano()), capabilities: map[v1.Capability]string{}, revisions: map[v1.Capability]uint64{}, timestamps: map[v1.Capability]time.Time{}}
	for _, capability := range capabilities {
		result.capabilities[capability] = "1"
	}
	return result
}
func (s *nativeSource) Manifest() v1.Manifest {
	return v1.Manifest{ProtocolVersion: v1.ProtocolVersion, ID: s.implementation, Version: "1", Capabilities: s.capabilities}
}
func (s *nativeSource) Open(ctx context.Context) error {
	if s.open != nil {
		return s.open(ctx)
	}
	return nil
}
func (s *nativeSource) Close() error {
	if s.close != nil {
		return s.close()
	}
	return nil
}
func (s *nativeSource) Read(ctx context.Context, capability v1.Capability, at time.Time) (v1.Observation, error) {
	observation, err := s.read(ctx, capability, at)
	if err != nil {
		return observation, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	observation.InstanceID, observation.SessionID, observation.Capability = s.id, s.session, capability
	if observation.ObservedAt.IsZero() {
		observation.ObservedAt = at
	}
	if s.revisions[capability] == 0 || !s.timestamps[capability].Equal(observation.ObservedAt) {
		s.revisions[capability]++
		s.timestamps[capability] = observation.ObservedAt
	}
	observation.Revision = s.revisions[capability]
	if observation.Status == "" {
		observation.Status = "available"
		switch {
		case observation.Host != nil:
			observation.Status = observationStatus(observation.Host.System.Status)
		case observation.Processes != nil:
			observation.Status = observationStatus(observation.Processes.Capability.Status)
		case observation.GPU != nil:
			state := observation.GPU.Capabilities.NVML
			if observation.GPU.Capabilities.GPU != nil {
				state = *observation.GPU.Capabilities.GPU
			}
			observation.Status = observationStatus(state.Status)
		}
	}
	return observation, nil
}

func observationStatus(status model.MetricStatus) string {
	switch status {
	case model.StatusAvailable, model.StatusEstimated:
		return "available"
	case model.StatusStale:
		return "stale"
	case model.StatusError:
		return "error"
	default:
		return "unavailable"
	}
}

type factoryContext struct {
	cfg      config.Config
	latest   func() model.Snapshot
	hardware []provider.Provider
}
type builtinFactory func(*factoryContext, config.PluginConfig) (v1.Source, error)

// Registered built-ins use the same typed observations and scheduler as external
// services. Factories do no I/O; Open and Read own collector lifecycle.
var builtinFactories = map[string]builtinFactory{
	"host": newHostSource, "nvidia": newGPUSource, "fake": newGPUSource, "processes": newProcessSource,
	"coder-kubernetes": newEnvironmentSource, "workload-cgroups": newWorkloadSource, "gpu-capacity": newCapacitySource,
}

func NewEngine(cfg config.Config) (*collector.Engine, *plugins.Runtime, error) {
	var engine *collector.Engine
	context := &factoryContext{cfg: cfg, latest: func() model.Snapshot {
		if engine != nil {
			snapshot, _ := engine.Current()
			return snapshot
		}
		return model.Snapshot{}
	}}
	var instances []plugins.Instance
	for _, entry := range config.PluginComposition(cfg) {
		if entry.Disabled {
			instances = append(instances, plugins.Instance{Config: entry, Native: entry.Builtin != "", Interval: entry.SamplingInterval(cfg.Interval)})
			continue
		}
		var source v1.Source
		var err error
		if entry.Builtin != "" {
			factory := builtinFactories[entry.Builtin]
			if factory == nil {
				return nil, nil, fmt.Errorf("unregistered builtin %s", entry.Builtin)
			}
			source, err = factory(context, entry)
		} else {
			source, err = v1.NewUnixClient(entry.Socket)
		}
		if err != nil {
			return nil, nil, err
		}
		instances = append(instances, plugins.Instance{Config: entry, Source: source, Native: entry.Builtin != "", Interval: entry.SamplingInterval(cfg.Interval)})
	}
	sources, err := plugins.New(instances)
	if err != nil {
		return nil, nil, err
	}
	engine = collector.NewPluginEngine(sources, collector.Options{SamplingInterval: cfg.Interval, HistoryWindow: cfg.HistoryWindow, ProfileInterval: effectiveInterval(cfg.ProfileInterval, cfg.Interval), ProcessInterval: effectiveInterval(cfg.ProcessInterval, cfg.Interval)})
	return engine, sources, nil
}

func newHostSource(factory *factoryContext, entry config.PluginConfig) (v1.Source, error) {
	sampler := systemtelemetry.Default()
	source := newNative(entry.ID, "host", v1.Host)
	source.read = func(ctx context.Context, _ v1.Capability, at time.Time) (v1.Observation, error) {
		system, diagnostics, err := sampler.Sample(ctx, at)
		return v1.Observation{ObservedAt: system.SampledAt, Host: &v1.HostData{System: system, Diagnostics: diagnostics}}, err
	}
	return source, nil
}

func newGPUSource(factory *factoryContext, entry config.PluginConfig) (v1.Source, error) {
	cfg := factory.cfg
	if entry.Builtin == "fake" {
		cfg.Provider = "fake"
	} else {
		cfg.Fixture = ""
		if cfg.Provider == "fake" {
			cfg.Provider = "auto"
		}
	}
	hardware, err := HardwareProvider(cfg)
	if err != nil {
		return nil, err
	}
	factory.hardware = append(factory.hardware, hardware)
	source := newNative(entry.ID, entry.Builtin, v1.GPU)
	if entry.Builtin == "fake" {
		for _, capability := range []v1.Capability{v1.Host, v1.Processes, v1.WorkloadInventory, v1.Allocations, v1.WorkloadMeasurements} {
			source.capabilities[capability] = "1"
		}
	}
	source.open, source.close = hardware.Open, hardware.Close
	var mu sync.Mutex
	var cached model.Snapshot
	var last time.Time
	source.read = func(ctx context.Context, capability v1.Capability, at time.Time) (v1.Observation, error) {
		mu.Lock()
		defer mu.Unlock()
		if entry.Builtin != "fake" || last.IsZero() || at.Sub(last) >= min(entry.SamplingInterval(cfg.Interval)/2, 100*time.Millisecond) {
			sample, err := hardware.Sample(ctx, at)
			if err != nil {
				return v1.Observation{}, err
			}
			cached = sample
			last = at
		}
		result := v1.Observation{ObservedAt: cached.SampledAt}
		switch capability {
		case v1.Host:
			result.Host = &v1.HostData{System: cached.System}
		case v1.GPU:
			result.GPU = &v1.GPUData{GPUs: cached.GPUs, Capabilities: cached.Capabilities, Diagnostics: cached.Diagnostics}
		case v1.Processes:
			result.Processes = processData(cached.Processes, cached.Capabilities.Proc, nil)
		case v1.WorkloadInventory:
			result.WorkloadInventory = &v1.InventoryData{Workloads: []model.WorkloadAttribution{}, Owners: []v1.Owner{}}
			if cached.Attribution != nil {
				result.WorkloadInventory.Workloads = cached.Attribution.Workloads
			}
		case v1.Allocations:
			result.Allocations = &v1.AllocationData{Workloads: []model.WorkloadAttribution{}, Assignments: []v1.Assignment{}}
			if cached.Attribution != nil {
				result.Allocations = allocationData(cached.Attribution, nil, entry.ID)
			}
		case v1.WorkloadMeasurements:
			result.WorkloadMeasurements = cached.WorkloadTelemetry
			if result.WorkloadMeasurements == nil {
				result.WorkloadMeasurements = &model.WorkloadTelemetry{SampledAt: at, Status: model.WorkloadTelemetryUnavailable, Owners: []model.WorkloadOwnerTelemetry{}}
				result.Status = "unavailable"
			}
		}
		return result, nil
	}
	return source, nil
}

func processData(processes []model.Process, capability model.ProviderState, diagnostics []model.Diagnostic) *v1.ProcessData {
	result := &v1.ProcessData{Processes: []v1.ProcessRecord{}, Capability: capability, Diagnostics: diagnostics}
	for _, process := range processes {
		result.Processes = append(result.Processes, v1.ProcessRecord{Process: process, ScopeRef: process.ScopeRef})
	}
	return result
}
func newProcessSource(factory *factoryContext, entry config.PluginConfig) (v1.Source, error) {
	scanner := process.NewScannerWithAttribution(factory.cfg.ShowCommandLine, factory.cfg.AttributionSocket != "")
	source := newNative(entry.ID, "processes", v1.Processes)
	source.read = func(ctx context.Context, _ v1.Capability, at time.Time) (v1.Observation, error) {
		if err := ctx.Err(); err != nil {
			return v1.Observation{}, err
		}
		inventory := scanner.Scan()
		return v1.Observation{ObservedAt: at, Processes: processData(inventory.Processes, inventory.Capability, inventory.Diagnostics)}, nil
	}
	return source, nil
}
func allocationData(value *model.Attribution, scopes map[string]string, hardwareID string) *v1.AllocationData {
	result := &v1.AllocationData{Workloads: value.Workloads, Assignments: []v1.Assignment{}, Resolution: value.Resolution}
	for _, assignment := range value.Assignments {
		result.Assignments = append(result.Assignments, v1.Assignment{WorkloadRef: assignment.WorkloadRef, Resource: v1.ResourceRef{InstanceID: hardwareID, ID: assignment.EntityUUID}, EntityType: assignment.EntityType, State: assignment.State})
	}
	for scope, workloadRef := range scopes {
		result.Scopes = append(result.Scopes, v1.ScopeAssignment{ScopeRef: scope, WorkloadRef: workloadRef})
	}
	return result
}
func newEnvironmentSource(factory *factoryContext, entry config.PluginConfig) (v1.Source, error) {
	client, err := attribution.NewClient(attribution.DefaultClientOptions(factory.cfg.AttributionSocket))
	if err != nil {
		return nil, err
	}
	adapter := attribution.NewAdapter(client, factory.cfg.AttributionCheckpointPath)
	source := newNative(entry.ID, "coder-kubernetes", v1.WorkloadInventory, v1.Allocations)
	source.open, source.close = adapter.Open, adapter.Close
	hardwareID := "hardware"
	for _, candidate := range config.PluginComposition(factory.cfg) {
		if !candidate.Disabled && (candidate.Builtin == "nvidia" || candidate.Builtin == "fake") && enabledCapability(candidate, v1.GPU) {
			hardwareID = candidate.ID
			break
		}
	}
	source.read = func(ctx context.Context, capability v1.Capability, at time.Time) (v1.Observation, error) {
		if err := ctx.Err(); err != nil {
			return v1.Observation{}, err
		}
		if adapter.NeedsTopologyRefresh(at) {
			for _, hardware := range factory.hardware {
				if refresher, ok := hardware.(provider.TopologyRefresher); ok {
					refresher.RefreshTopology()
				}
			}
		}
		topology, targets := adapterTopology(factory.latest(), config.PluginComposition(factory.cfg), hardwareID)
		snapshot, scopes := adapter.ObserveWithScopes(topology)
		value := snapshot.Attribution
		result := v1.Observation{Status: string(value.Status)}
		if value.ObservedAt != nil {
			result.ObservedAt = *value.ObservedAt
		}
		data := allocationData(value, scopes, hardwareID)
		for index := range data.Assignments {
			if target, ok := targets[data.Assignments[index].Resource.ID]; ok {
				data.Assignments[index].Resource = target
			}
		}
		if capability == v1.Allocations {
			result.Allocations = data
		} else {
			result.WorkloadInventory = &v1.InventoryData{Workloads: value.Workloads, Owners: []v1.Owner{}, Scopes: data.Scopes}
		}
		return result, nil
	}
	return source, nil
}
func newWorkloadSource(factory *factoryContext, entry config.PluginConfig) (v1.Source, error) {
	sampler, err := workload.NewSampler(workload.Options{SocketPath: factory.cfg.AttributionSocket})
	if err != nil {
		return nil, err
	}
	source := newNative(entry.ID, "workload-cgroups", v1.WorkloadMeasurements)
	source.close = sampler.Close
	source.read = func(ctx context.Context, _ v1.Capability, at time.Time) (v1.Observation, error) {
		value, err := sampler.Sample(ctx, at)
		return v1.Observation{ObservedAt: value.SampledAt, Status: string(value.Status), WorkloadMeasurements: &value}, err
	}
	return source, nil
}
func newCapacitySource(factory *factoryContext, entry config.PluginConfig) (v1.Source, error) {
	client, err := gpucapacity.NewClient(factory.cfg.AttributionSocket)
	if err != nil {
		return nil, err
	}
	source := newNative(entry.ID, "gpu-capacity", v1.GPUCapacity)
	source.close = func() error { client.Close(); return nil }
	source.read = func(ctx context.Context, _ v1.Capability, at time.Time) (v1.Observation, error) {
		document, err := client.Read(ctx, at)
		result := v1.Observation{Status: document.Status, GPUCapacity: &document}
		if document.ObservedAt != nil {
			result.ObservedAt = *document.ObservedAt
		}
		return result, err
	}
	return source, nil
}

func enabledCapability(entry config.PluginConfig, capability v1.Capability) bool {
	if len(entry.Capabilities) == 0 {
		return true
	}
	for _, value := range entry.Capabilities {
		if value == string(capability) {
			return true
		}
	}
	return false
}

// The Kubernetes host resolver consumes hardware UUIDs; translate the core's
// qualified presentation IDs back to UUIDs, retaining explicit producer refs.
func adapterTopology(snapshot model.Snapshot, composition []config.PluginConfig, fallback string) (model.Snapshot, map[string]v1.ResourceRef) {
	external := map[string]bool{}
	for _, entry := range composition {
		if !entry.Disabled && entry.Socket != "" {
			external[entry.ID] = true
		}
	}
	targets := map[string]v1.ResourceRef{}
	unwrap := func(id, generation string) string {
		producer, local, qualified := strings.Cut(id, "/")
		if qualified && external[producer] {
			targets[local] = v1.ResourceRef{InstanceID: producer, ID: local, Generation: strings.TrimPrefix(generation, producer+"/")}
			return local
		}
		targets[id] = v1.ResourceRef{InstanceID: fallback, ID: id}
		return id
	}
	snapshot.GPUs = append([]model.GPU{}, snapshot.GPUs...)
	for index := range snapshot.GPUs {
		gpu := &snapshot.GPUs[index]
		gpu.UUID = unwrap(gpu.UUID, gpu.Generation)
		gpu.GPUInstances = append([]model.GPUInstance{}, gpu.GPUInstances...)
		for giIndex := range gpu.GPUInstances {
			gi := &gpu.GPUInstances[giIndex]
			gi.UUID = unwrap(gi.UUID, gi.Generation)
			gi.ComputeInstances = append([]model.ComputeInstance{}, gi.ComputeInstances...)
			for ciIndex := range gi.ComputeInstances {
				ci := &gi.ComputeInstances[ciIndex]
				ci.UUID = unwrap(ci.UUID, ci.Generation)
			}
		}
	}
	return snapshot, targets
}
