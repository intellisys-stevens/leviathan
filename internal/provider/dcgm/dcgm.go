// Package dcgm augments NVML snapshots with optional DCGM MIG profiling data.
package dcgm

import (
	"context"
	"errors"
	"fmt"
	"hash/fnv"
	"math"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	ndcgm "github.com/NVIDIA/go-dcgm/pkg/dcgm"
	"github.com/intellisys-stevens/miglens/internal/model"
	"github.com/intellisys-stevens/miglens/internal/provider"
)

type Options struct {
	Address        string
	Required       bool
	Disabled       bool
	Interval       time.Duration
	StaleAfter     time.Duration
	RescanInterval time.Duration
}

type Provider struct {
	base    provider.Provider
	options Options

	mu          sync.RWMutex
	available   bool
	message     string
	cleanup     func()
	group       ndcgm.GroupHandle
	fieldGroup  ndcgm.FieldHandle
	watching    bool
	entities    map[string]uint
	topologySig string
	refreshedAt time.Time
	profiles    map[string]*profileState

	updateAllFields func() error
	latestValues    func(ndcgm.Field_Entity_Group, uint, []ndcgm.Short) ([]ndcgm.FieldValue_v1, error)
}

type profileState struct {
	nextAt  time.Time
	metrics model.MetricSet
}

type profileTarget struct {
	gpuIndex int
	giIndex  int
	key      string
	entity   uint
	state    *profileState
	due      bool
}

var profileFields = []ndcgm.Short{
	ndcgm.DCGM_FI_PROF_GR_ENGINE_UTIL_RATIO,
	ndcgm.DCGM_FI_PROF_SM_UTIL_RATIO,
	ndcgm.DCGM_FI_PROF_SM_OCCUPANCY_RATIO,
	ndcgm.DCGM_FI_PROF_TENSOR_UTIL_RATIO,
	ndcgm.DCGM_FI_PROF_DRAM_UTIL_RATIO,
	ndcgm.DCGM_FI_PROF_PCIE_TX_BYTES,
	ndcgm.DCGM_FI_PROF_PCIE_RX_BYTES,
}

type profileDescriptor struct {
	name    string
	unit    string
	scale   float64
	percent bool
}

var profileDescriptors = map[ndcgm.Short]profileDescriptor{
	ndcgm.DCGM_FI_PROF_GR_ENGINE_UTIL_RATIO: {name: "gpu_activity", unit: "percent", scale: 100, percent: true},
	ndcgm.DCGM_FI_PROF_SM_UTIL_RATIO:        {name: "sm_activity", unit: "percent", scale: 100, percent: true},
	ndcgm.DCGM_FI_PROF_SM_OCCUPANCY_RATIO:   {name: "sm_occupancy", unit: "percent", scale: 100, percent: true},
	ndcgm.DCGM_FI_PROF_TENSOR_UTIL_RATIO:    {name: "tensor_activity", unit: "percent", scale: 100, percent: true},
	ndcgm.DCGM_FI_PROF_DRAM_UTIL_RATIO:      {name: "dram_activity", unit: "percent", scale: 100, percent: true},
	// DCGM profiling fields 1009/1010 are rates in bytes/second. Unlike the
	// ratio fields, their values are already expressed in the canonical unit.
	ndcgm.DCGM_FI_PROF_PCIE_TX_BYTES: {name: "pcie_tx_bytes_per_second", unit: "bytes_per_second", scale: 1},
	ndcgm.DCGM_FI_PROF_PCIE_RX_BYTES: {name: "pcie_rx_bytes_per_second", unit: "bytes_per_second", scale: 1},
}

// profileNames remains a small compatibility view used by diagnostics and
// tests; units and normalization live in profileDescriptors.
var profileNames = func() map[ndcgm.Short]string {
	names := make(map[ndcgm.Short]string, len(profileDescriptors))
	for field, descriptor := range profileDescriptors {
		names[field] = descriptor.name
	}
	return names
}()

func New(base provider.Provider, options Options) *Provider {
	if options.Interval <= 0 {
		options.Interval = 2 * time.Second
	}
	if options.StaleAfter <= 0 {
		options.StaleAfter = 3 * options.Interval
	}
	if options.RescanInterval <= 0 {
		options.RescanInterval = 10 * time.Second
	}
	return &Provider{
		base: base, options: options, entities: make(map[string]uint), profiles: make(map[string]*profileState),
		updateAllFields: ndcgm.UpdateAllFields, latestValues: ndcgm.EntityGetLatestValues,
	}
}

func (p *Provider) Name() string { return p.base.Name() + "+dcgm" }

func (p *Provider) Open(ctx context.Context) error {
	if err := p.base.Open(ctx); err != nil {
		return err
	}
	if p.options.Disabled {
		p.setState(false, "DCGM profiling disabled")
		return nil
	}
	args := []string{p.options.Address, "0"}
	if strings.Contains(p.options.Address, "://") {
		args = []string{p.options.Address}
	}
	cleanup, err := ndcgm.Init(ndcgm.Standalone, args...)
	if err != nil {
		p.setState(false, err.Error())
		if p.options.Required {
			_ = p.base.Close()
			return fmt.Errorf("connect to DCGM: %w", err)
		}
		return nil
	}
	p.cleanup = cleanup
	if err := p.refreshWatch(); err != nil {
		cleanup()
		p.cleanup = nil
		p.setState(false, err.Error())
		if p.options.Required {
			_ = p.base.Close()
			return fmt.Errorf("configure DCGM profiling: %w", err)
		}
		return nil
	}
	p.setState(true, "DCGM profiling counters connected")
	return nil
}

func (p *Provider) Sample(ctx context.Context, at time.Time) (model.Snapshot, error) {
	snapshot, err := p.base.Sample(ctx, at)
	if err != nil {
		return snapshot, err
	}
	p.mu.RLock()
	available := p.available
	refreshDue := at.Sub(p.refreshedAt) >= p.options.RescanInterval
	p.mu.RUnlock()
	if !available {
		snapshot.Capabilities = p.Capabilities()
		return snapshot, nil
	}
	if refreshDue {
		if err := p.refreshWatch(); err != nil {
			snapshot.Diagnostics = append(snapshot.Diagnostics, dcgmDiagnostic("dcgm_topology", "DCGM topology refresh failed", err, model.StatusError))
			snapshot.Capabilities = p.Capabilities()
			return snapshot, nil
		}
	}
	targets, seen := p.profileTargets(snapshot, at)
	p.pruneProfileStates(seen)

	due := make([]profileTarget, 0, len(targets))
	for _, target := range targets {
		if target.due {
			due = append(due, target)
		}
	}

	blankCount, queryCount := 0, 0
	if len(due) > 0 {
		if err := p.updateAllFields(); err != nil {
			snapshot.Diagnostics = append(snapshot.Diagnostics, dcgmDiagnostic("dcgm_update", "DCGM profiling update failed", err, model.StatusStale))
			for _, target := range due {
				p.storeProfileMetrics(target.state, unavailableProfileMetrics(at, model.StatusError, err.Error()))
			}
		} else {
			for _, target := range due {
				values, err := p.latestValues(ndcgm.FE_GPU_I, target.entity, profileFields)
				if err != nil {
					p.storeProfileMetrics(target.state, unavailableProfileMetrics(at, model.StatusError, err.Error()))
					continue
				}
				queryCount++
				metrics := unavailableProfileMetrics(at, model.StatusStale, "DCGM did not return this profiling field")
				returned := make(map[ndcgm.Short]bool, len(values))
				for _, value := range values {
					descriptor, known := profileDescriptors[value.FieldID]
					if !known {
						continue
					}
					returned[value.FieldID] = true
					candidate, blank := dcgmMetric(descriptor, value, at)
					if blank {
						blankCount++
					}
					metrics[descriptor.name] = candidate
				}
				for _, field := range profileFields {
					if !returned[field] {
						blankCount++
					}
				}
				p.storeProfileMetrics(target.state, metrics)
			}
		}
	}

	for _, target := range targets {
		gi := &snapshot.GPUs[target.gpuIndex].GPUInstances[target.giIndex]
		gi.Metrics = provider.MergeMetricSets(gi.Metrics, p.cachedProfileMetrics(target.state, at))
	}
	if queryCount > 0 && blankCount >= queryCount*len(profileFields) {
		snapshot.Diagnostics = append(snapshot.Diagnostics, model.Diagnostic{
			Code: "dcgm_profile_paused", Severity: "warning", Component: "DCGM", Summary: "DCGM profiling counters are blank or paused",
			Detail: "A concurrent Nsight or profiling session may own the hardware counters.", Remedy: "stop the conflicting profiler, or run MIGLens with --provider nvml or --no-profile", Status: model.StatusStale,
		})
	}
	snapshot.Capabilities = p.Capabilities()
	return snapshot, nil
}

func (p *Provider) profileTargets(snapshot model.Snapshot, at time.Time) ([]profileTarget, map[string]bool) {
	targets := make([]profileTarget, 0)
	seen := make(map[string]bool)
	for gpuIndex := range snapshot.GPUs {
		gpu := &snapshot.GPUs[gpuIndex]
		for giIndex := range gpu.GPUInstances {
			gi := &gpu.GPUInstances[giIndex]
			p.mu.RLock()
			entity, ok := p.entities[dcgmKey(gpu.UUID, gi.ID)]
			p.mu.RUnlock()
			if !ok {
				continue
			}
			key := dcgmProfileKey(gpu.UUID, *gi)
			state, due := p.profileStateFor(key, at)
			seen[key] = true
			targets = append(targets, profileTarget{gpuIndex: gpuIndex, giIndex: giIndex, key: key, entity: entity, state: state, due: due})
		}
	}
	return targets, seen
}

func (p *Provider) profileStateFor(key string, at time.Time) (*profileState, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	state := p.profiles[key]
	if state == nil {
		state = &profileState{nextAt: at}
		p.profiles[key] = state
	}
	if at.Before(state.nextAt) {
		return state, false
	}
	state.nextAt = staggeredProfileTime(at.Add(time.Nanosecond), key, p.options.Interval)
	return state, true
}

func staggeredProfileTime(at time.Time, key string, interval time.Duration) time.Time {
	if interval <= 0 {
		return at
	}
	hash := fnv.New64a()
	_, _ = hash.Write([]byte(key))
	phase := time.Duration(hash.Sum64() % uint64(interval))
	periodStart := at.Truncate(interval)
	candidate := periodStart.Add(phase)
	if candidate.Before(at) {
		candidate = candidate.Add(interval)
	}
	return candidate
}

func (p *Provider) storeProfileMetrics(state *profileState, metrics model.MetricSet) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if state.metrics == nil {
		state.metrics = make(model.MetricSet, len(metrics))
	}
	for name, candidate := range metrics {
		existing, ok := state.metrics[name]
		if ok && existing.Status == model.StatusAvailable &&
			(candidate.Status == model.StatusStale || candidate.Status == model.StatusError) {
			continue
		}
		state.metrics[name] = candidate
	}
}

func (p *Provider) cachedProfileMetrics(state *profileState, at time.Time) model.MetricSet {
	p.mu.RLock()
	metrics := copyMetricSet(state.metrics)
	p.mu.RUnlock()
	for name, metric := range metrics {
		if metric.Status == model.StatusAvailable && at.Sub(metric.SampledAt) > p.options.StaleAfter {
			metric.Value = nil
			metric.Status = model.StatusStale
			metric.Message = "DCGM profile metric cache exceeded its freshness interval"
			metrics[name] = metric
		}
	}
	return metrics
}

func (p *Provider) pruneProfileStates(seen map[string]bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	for key := range p.profiles {
		if !seen[key] {
			delete(p.profiles, key)
		}
	}
}

func copyMetricSet(metrics model.MetricSet) model.MetricSet {
	if metrics == nil {
		return make(model.MetricSet)
	}
	cloned := make(model.MetricSet, len(metrics))
	for name, metric := range metrics {
		cloned[name] = metric
	}
	return cloned
}

func unavailableProfileMetrics(at time.Time, status model.MetricStatus, message string) model.MetricSet {
	metrics := make(model.MetricSet, len(profileDescriptors))
	for _, descriptor := range profileDescriptors {
		metrics[descriptor.name] = model.UnavailableMetric(descriptor.unit, model.SourceDCGM, model.ScopeGPUInstance, at, status, message)
	}
	return metrics
}

func (p *Provider) Capabilities() model.Capabilities {
	capabilities := p.base.Capabilities()
	p.mu.RLock()
	defer p.mu.RUnlock()
	status := model.StatusUnsupported
	if p.available {
		status = model.StatusAvailable
	}
	capabilities.DCGM = model.ProviderState{Name: "DCGM", Available: p.available, Status: status, Message: p.message}
	capabilities.ProfileMetrics = capabilities.ProfileMetrics || p.available
	return capabilities
}

func (p *Provider) Close() error {
	p.destroyWatch()
	p.mu.Lock()
	cleanup := p.cleanup
	p.cleanup = nil
	p.available = false
	p.mu.Unlock()
	if cleanup != nil {
		cleanup()
	}
	return p.base.Close()
}

func (p *Provider) refreshWatch() error {
	hierarchy, err := ndcgm.GetGPUInstanceHierarchy()
	if err != nil {
		return err
	}
	entries := make([]ndcgm.MigHierarchyInfo_v2, 0, hierarchy.Count)
	sigParts := make([]string, 0, hierarchy.Count)
	for index := uint(0); index < hierarchy.Count; index++ {
		entry := hierarchy.EntityList[index]
		if entry.Entity.EntityGroupId != ndcgm.FE_GPU_I {
			continue
		}
		entries = append(entries, entry)
		sigParts = append(sigParts, fmt.Sprintf("%s:%d:%d", entry.Info.GpuUuid, entry.Info.NvmlInstanceId, entry.Entity.EntityId))
	}
	sort.Strings(sigParts)
	signature := strings.Join(sigParts, ",")
	p.mu.RLock()
	unchanged := p.watching && signature == p.topologySig
	p.mu.RUnlock()
	if unchanged {
		p.mu.Lock()
		p.refreshedAt = time.Now()
		p.mu.Unlock()
		return nil
	}
	p.destroyWatch()
	if len(entries) == 0 {
		return errors.New("DCGM returned no GPU-instance entities")
	}
	group, err := ndcgm.CreateGroup(fmt.Sprintf("miglens-%d", os.Getpid()))
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if err := ndcgm.AddEntityToGroup(group, ndcgm.FE_GPU_I, entry.Entity.EntityId); err != nil {
			_ = ndcgm.DestroyGroup(group)
			return err
		}
	}
	fieldGroup, err := ndcgm.FieldGroupCreate(fmt.Sprintf("miglens-profile-%d", os.Getpid()), profileFields)
	if err != nil {
		_ = ndcgm.DestroyGroup(group)
		return err
	}
	frequency := p.options.Interval.Microseconds()
	if frequency < 100_000 {
		frequency = 100_000
	}
	if err := ndcgm.WatchFieldsWithGroupEx(fieldGroup, group, frequency, 60, 120); err != nil {
		_ = ndcgm.FieldGroupDestroy(fieldGroup)
		_ = ndcgm.DestroyGroup(group)
		return err
	}
	entities := make(map[string]uint, len(entries))
	for _, entry := range entries {
		entities[dcgmKey(entry.Info.GpuUuid, uint32(entry.Info.NvmlInstanceId))] = entry.Entity.EntityId
	}
	p.mu.Lock()
	p.group, p.fieldGroup, p.watching = group, fieldGroup, true
	p.entities, p.topologySig, p.refreshedAt = entities, signature, time.Now()
	p.mu.Unlock()
	return nil
}

func (p *Provider) destroyWatch() {
	p.mu.Lock()
	p.profiles = make(map[string]*profileState)
	if !p.watching {
		p.mu.Unlock()
		return
	}
	group, fieldGroup := p.group, p.fieldGroup
	p.watching = false
	p.entities = make(map[string]uint)
	p.mu.Unlock()
	_ = ndcgm.UnwatchFields(fieldGroup, group)
	_ = ndcgm.FieldGroupDestroy(fieldGroup)
	_ = ndcgm.DestroyGroup(group)
}

func (p *Provider) setState(available bool, message string) {
	p.mu.Lock()
	p.available, p.message = available, message
	p.mu.Unlock()
}

func dcgmMetric(descriptor profileDescriptor, value ndcgm.FieldValue_v1, at time.Time) (model.Metric, bool) {
	if value.Status != ndcgm.DCGM_ST_OK {
		return model.UnavailableMetric(descriptor.unit, model.SourceDCGM, model.ScopeGPUInstance, at, model.StatusError, fmt.Sprintf("DCGM field status %d", value.Status)), false
	}
	return dcgmMetricValue(descriptor, value.Float64(), dcgmSampledAt(value.TS, at))
}

func dcgmSampledAt(timestampMicros int64, fallback time.Time) time.Time {
	if timestampMicros <= 0 {
		return fallback
	}
	// DCGM field timestamps are Unix epoch microseconds. Preserve the
	// provider timestamp when a watch returns a cached field value.
	return time.UnixMicro(timestampMicros).UTC()
}

func dcgmMetricValue(descriptor profileDescriptor, raw float64, at time.Time) (model.Metric, bool) {
	if math.IsNaN(raw) || math.IsInf(raw, 0) {
		return model.UnavailableMetric(descriptor.unit, model.SourceDCGM, model.ScopeGPUInstance, at, model.StatusStale, "profiling counter returned a non-finite value"), true
	}
	if raw >= ndcgm.DCGM_FT_FP64_BLANK {
		status, message := model.StatusStale, "profiling counter is blank or paused"
		if raw == ndcgm.DCGM_FT_FP64_NOT_SUPPORTED {
			status, message = model.StatusUnsupported, "profiling counter is not supported"
		} else if raw == ndcgm.DCGM_FT_FP64_NOT_PERMISSIONED {
			status, message = model.StatusPermissionDenied, "profiling counter is not permissioned"
		}
		return model.UnavailableMetric(descriptor.unit, model.SourceDCGM, model.ScopeGPUInstance, at, status, message), true
	}
	value := raw * descriptor.scale
	if descriptor.percent {
		value = math.Max(0, math.Min(100, value))
	} else if value < 0 {
		value = 0
	}
	return model.AvailableMetric(value, descriptor.unit, model.SourceDCGM, model.ScopeGPUInstance, at), false
}

func dcgmKey(gpuUUID string, giID uint32) string {
	return strings.ToLower(gpuUUID) + fmt.Sprintf("/gi/%d", giID)
}

func dcgmProfileKey(gpuUUID string, instance model.GPUInstance) string {
	children := make([]string, 0, len(instance.ComputeInstances))
	for _, child := range instance.ComputeInstances {
		children = append(children, fmt.Sprintf("%s:%d:%s:%s", child.UUID, child.ID, child.Profile, child.Generation))
	}
	sort.Strings(children)
	return fmt.Sprintf(
		"%s|uuid=%s|profile=%s|generation=%s|ci=%s",
		dcgmKey(gpuUUID, instance.ID), instance.UUID, instance.Profile, instance.Generation, strings.Join(children, ","),
	)
}

func dcgmDiagnostic(code, summary string, err error, status model.MetricStatus) model.Diagnostic {
	return model.Diagnostic{Code: code, Severity: "warning", Component: "DCGM", Summary: summary, Detail: err.Error(), Remedy: "check nv-hostengine and profiling ownership; use --provider nvml or --no-profile to disable profiling", Status: status}
}
