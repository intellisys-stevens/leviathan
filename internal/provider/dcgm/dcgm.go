// Package dcgm augments NVML snapshots with optional DCGM MIG profiling data.
package dcgm

import (
	"context"
	"errors"
	"fmt"
	"math"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	ndcgm "github.com/NVIDIA/go-dcgm/pkg/dcgm"
	"github.com/miglens/miglens/internal/model"
	"github.com/miglens/miglens/internal/provider"
)

type Options struct {
	Address        string
	Required       bool
	Disabled       bool
	Interval       time.Duration
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
}

var profileFields = []ndcgm.Short{
	ndcgm.DCGM_FI_PROF_GR_ENGINE_UTIL_RATIO,
	ndcgm.DCGM_FI_PROF_SM_UTIL_RATIO,
	ndcgm.DCGM_FI_PROF_SM_OCCUPANCY_RATIO,
	ndcgm.DCGM_FI_PROF_TENSOR_UTIL_RATIO,
	ndcgm.DCGM_FI_PROF_DRAM_UTIL_RATIO,
}

var profileNames = map[ndcgm.Short]string{
	ndcgm.DCGM_FI_PROF_GR_ENGINE_UTIL_RATIO: "gpu_activity",
	ndcgm.DCGM_FI_PROF_SM_UTIL_RATIO:        "sm_activity",
	ndcgm.DCGM_FI_PROF_SM_OCCUPANCY_RATIO:   "sm_occupancy",
	ndcgm.DCGM_FI_PROF_TENSOR_UTIL_RATIO:    "tensor_activity",
	ndcgm.DCGM_FI_PROF_DRAM_UTIL_RATIO:      "dram_activity",
}

func New(base provider.Provider, options Options) *Provider {
	if options.Interval <= 0 {
		options.Interval = time.Second
	}
	if options.RescanInterval <= 0 {
		options.RescanInterval = 10 * time.Second
	}
	return &Provider{base: base, options: options, entities: make(map[string]uint)}
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
	if err := ndcgm.UpdateAllFields(); err != nil {
		snapshot.Diagnostics = append(snapshot.Diagnostics, dcgmDiagnostic("dcgm_update", "DCGM profiling update failed", err, model.StatusStale))
		snapshot.Capabilities = p.Capabilities()
		return snapshot, nil
	}

	blankCount, queryCount := 0, 0
	for gpuIndex := range snapshot.GPUs {
		for giIndex := range snapshot.GPUs[gpuIndex].GPUInstances {
			gi := &snapshot.GPUs[gpuIndex].GPUInstances[giIndex]
			key := dcgmKey(snapshot.GPUs[gpuIndex].UUID, gi.ID)
			p.mu.RLock()
			entity, ok := p.entities[key]
			p.mu.RUnlock()
			if !ok {
				continue
			}
			queryCount++
			values, err := ndcgm.EntityGetLatestValues(ndcgm.FE_GPU_I, entity, profileFields)
			if err != nil {
				for _, field := range profileFields {
					name := profileNames[field]
					candidate := model.UnavailableMetric("percent", model.SourceDCGM, model.ScopeGPUInstance, at, model.StatusError, err.Error())
					gi.Metrics[name] = provider.MergeMetric(gi.Metrics[name], candidate)
				}
				continue
			}
			for _, value := range values {
				name, known := profileNames[value.FieldID]
				if !known {
					continue
				}
				candidate, blank := dcgmMetric(value, at)
				if blank {
					blankCount++
				}
				gi.Metrics[name] = provider.MergeMetric(gi.Metrics[name], candidate)
			}
		}
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

func dcgmMetric(value ndcgm.FieldValue_v1, at time.Time) (model.Metric, bool) {
	if value.Status != ndcgm.DCGM_ST_OK {
		return model.UnavailableMetric("percent", model.SourceDCGM, model.ScopeGPUInstance, at, model.StatusError, fmt.Sprintf("DCGM field status %d", value.Status)), false
	}
	ratio := value.Float64()
	if ratio >= ndcgm.DCGM_FT_FP64_BLANK {
		status, message := model.StatusStale, "profiling counter is blank or paused"
		if ratio == ndcgm.DCGM_FT_FP64_NOT_SUPPORTED {
			status, message = model.StatusUnsupported, "profiling counter is not supported"
		} else if ratio == ndcgm.DCGM_FT_FP64_NOT_PERMISSIONED {
			status, message = model.StatusPermissionDenied, "profiling counter is not permissioned"
		}
		return model.UnavailableMetric("percent", model.SourceDCGM, model.ScopeGPUInstance, at, status, message), true
	}
	percent := math.Max(0, math.Min(100, ratio*100))
	return model.AvailableMetric(percent, "percent", model.SourceDCGM, model.ScopeGPUInstance, at), false
}

func dcgmKey(gpuUUID string, giID uint32) string {
	return strings.ToLower(gpuUUID) + fmt.Sprintf("/gi/%d", giID)
}

func dcgmDiagnostic(code, summary string, err error, status model.MetricStatus) model.Diagnostic {
	return model.Diagnostic{Code: code, Severity: "warning", Component: "DCGM", Summary: summary, Detail: err.Error(), Remedy: "check nv-hostengine and profiling ownership; use --provider nvml or --no-profile to disable profiling", Status: status}
}
