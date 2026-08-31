package collector

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/intellisys-stevens/leviathan/internal/history"
	"github.com/intellisys-stevens/leviathan/internal/model"
	"github.com/intellisys-stevens/leviathan/internal/provider"
)

type Engine struct {
	provider        provider.Provider
	history         *history.Buffer
	window          time.Duration
	profileInterval time.Duration
	processInterval time.Duration

	current    atomic.Pointer[model.Snapshot]
	seq        atomic.Uint64
	interval   atomic.Int64
	reschedule chan struct{}

	mu          sync.Mutex
	subscribers map[uint64]chan model.Snapshot
	nextSubID   uint64
	generations map[string]*generationState
	cancel      context.CancelFunc
	done        chan struct{}
	lastErr     error
}

type Options struct {
	SamplingInterval time.Duration
	HistoryWindow    time.Duration
	ProfileInterval  time.Duration
	ProcessInterval  time.Duration
}

type generationState struct {
	value     uint64
	active    bool
	signature string
	lastSeen  time.Time
}

func New(source provider.Provider, interval, window time.Duration) *Engine {
	return NewWithOptions(source, Options{
		SamplingInterval: interval,
		HistoryWindow:    window,
		ProfileInterval:  2 * time.Second,
		ProcessInterval:  2 * time.Second,
	})
}

func NewWithOptions(source provider.Provider, options Options) *Engine {
	if options.ProfileInterval <= 0 {
		options.ProfileInterval = 2 * time.Second
	}
	if options.ProcessInterval <= 0 {
		options.ProcessInterval = 2 * time.Second
	}
	engine := &Engine{
		provider:        source,
		history:         history.New(options.HistoryWindow, options.SamplingInterval),
		window:          options.HistoryWindow,
		profileInterval: options.ProfileInterval,
		processInterval: options.ProcessInterval,
		reschedule:      make(chan struct{}, 1),
		subscribers:     make(map[uint64]chan model.Snapshot),
		generations:     make(map[string]*generationState),
		done:            make(chan struct{}),
	}
	engine.interval.Store(int64(options.SamplingInterval))
	return engine
}

func (e *Engine) Start(parent context.Context) error {
	if err := e.provider.Open(parent); err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(parent)
	e.mu.Lock()
	e.cancel = cancel
	e.mu.Unlock()
	if err := e.poll(ctx, time.Now().UTC()); err != nil {
		_ = e.provider.Close()
		cancel()
		return err
	}
	go e.loop(ctx)
	return nil
}

func (e *Engine) loop(ctx context.Context) {
	defer close(e.done)
	defer e.provider.Close()
	next := time.Now().Add(e.SamplingInterval())
	timer := time.NewTimer(time.Until(next))
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-e.reschedule:
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			next = time.Now().Add(e.SamplingInterval())
			timer.Reset(time.Until(next))
		case tick := <-timer.C:
			if err := e.poll(ctx, tick.UTC()); err != nil && !errors.Is(err, context.Canceled) {
				e.recordPollError(tick.UTC(), err)
			}
			now := time.Now()
			interval := e.SamplingInterval()
			for !next.After(now) {
				next = next.Add(interval)
			}
			timer.Reset(time.Until(next))
		}
	}
}

var allowedSamplingIntervalsMs = []int64{500, 1000, 2000}

func (e *Engine) SamplingInterval() time.Duration {
	return time.Duration(e.interval.Load())
}

func (e *Engine) RuntimeSettings() model.RuntimeSettings {
	allowed := append([]int64(nil), allowedSamplingIntervalsMs...)
	return model.RuntimeSettings{
		SamplingIntervalMs:         e.SamplingInterval().Milliseconds(),
		ProfileIntervalMs:          e.profileInterval.Milliseconds(),
		ProcessIntervalMs:          e.processInterval.Milliseconds(),
		HistoryWindowMs:            e.window.Milliseconds(),
		AllowedSamplingIntervalsMs: allowed,
	}
}

// SetSamplingInterval applies a process-local cadence change. The buffered
// signal coalesces rapid changes; the loop always reads the latest value.
func (e *Engine) SetSamplingInterval(interval time.Duration) error {
	if interval < 250*time.Millisecond || interval > 60*time.Second {
		return fmt.Errorf("sampling interval must be between 250ms and 60s")
	}
	e.history.EnsureCapacity(interval)
	e.interval.Store(int64(interval))
	select {
	case e.reschedule <- struct{}{}:
	default:
	}
	return nil
}

func (e *Engine) poll(ctx context.Context, at time.Time) error {
	snapshot, err := e.provider.Sample(ctx, at)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		// A second full provider sample is an immediate topology rescan. It handles
		// transient device loss without queuing overlapping poll goroutines.
		snapshot, err = e.provider.Sample(ctx, at)
		if err != nil {
			return err
		}
	}
	snapshot.Sequence = e.seq.Add(1)
	snapshot.SchemaVersion = "v1"
	e.applyGenerations(&snapshot)
	e.history.Add(snapshot)
	immutable := snapshot
	e.current.Store(&immutable)
	e.mu.Lock()
	e.lastErr = nil
	e.mu.Unlock()
	e.publish(snapshot)
	return nil
}

func (e *Engine) recordPollError(at time.Time, err error) {
	e.mu.Lock()
	e.lastErr = err
	e.mu.Unlock()
	if e.history != nil {
		e.history.AddGap(at)
	}
	current, ok := e.Current()
	if !ok {
		return
	}
	stale := staleSnapshot(current, at, err.Error())
	stale.Sequence = e.seq.Add(1)
	e.current.Store(&stale)
	e.publish(stale)
}

func staleSnapshot(snapshot model.Snapshot, at time.Time, detail string) model.Snapshot {
	stale := snapshot
	stale.SampledAt = at
	stale.Diagnostics = append(append([]model.Diagnostic(nil), snapshot.Diagnostics...), model.Diagnostic{
		Code: "collector_sample", Severity: "error", Component: "collector", Summary: "GPU sampling failed; last topology retained", Detail: detail,
		Remedy: "run `leviathan doctor`; collection retries automatically without accumulating a polling backlog", Status: model.StatusStale,
	})
	stale.Capabilities = staleCapabilities(snapshot.Capabilities, detail)
	stale.Processes = staleProcesses(snapshot.Processes, detail)
	stale.GPUs = make([]model.GPU, len(snapshot.GPUs))
	for gpuIndex, gpu := range snapshot.GPUs {
		gpu.Metrics = staleMetrics(gpu.Metrics, detail)
		gpu.Memory = staleMemory(gpu.Memory, detail)
		gpu.GPUInstances = make([]model.GPUInstance, len(snapshot.GPUs[gpuIndex].GPUInstances))
		for giIndex, gi := range snapshot.GPUs[gpuIndex].GPUInstances {
			gi.Metrics = staleMetrics(gi.Metrics, detail)
			gi.Memory = staleMemory(gi.Memory, detail)
			gi.ComputeInstances = make([]model.ComputeInstance, len(snapshot.GPUs[gpuIndex].GPUInstances[giIndex].ComputeInstances))
			for ciIndex, ci := range snapshot.GPUs[gpuIndex].GPUInstances[giIndex].ComputeInstances {
				ci.Metrics = staleMetrics(ci.Metrics, detail)
				ci.Memory = staleMemory(ci.Memory, detail)
				ci.Diagnostics = append([]model.Diagnostic(nil), ci.Diagnostics...)
				gi.ComputeInstances[ciIndex] = ci
			}
			gpu.GPUInstances[giIndex] = gi
		}
		stale.GPUs[gpuIndex] = gpu
	}
	return stale
}

func staleMetrics(metrics model.MetricSet, detail string) model.MetricSet {
	result := make(model.MetricSet, len(metrics))
	for name, metric := range metrics {
		if metric.Status == model.StatusAvailable {
			metric.Value = nil
			metric.Status = model.StatusStale
			metric.Message = detail
		}
		result[name] = metric
	}
	return result
}

func staleMemory(memory model.Memory, detail string) model.Memory {
	if memory.Status == model.StatusAvailable {
		memory.UsedBytes, memory.FreeBytes = nil, nil
		memory.Status, memory.Message = model.StatusStale, detail
	}
	return memory
}

func staleProcesses(processes []model.Process, detail string) []model.Process {
	result := append([]model.Process{}, processes...)
	for index := range result {
		if result[index].Status == model.StatusAvailable {
			result[index].Status, result[index].Message = model.StatusStale, detail
		}
	}
	return result
}

func staleCapabilities(capabilities model.Capabilities, detail string) model.Capabilities {
	states := []*model.ProviderState{&capabilities.NVML, &capabilities.GPM, &capabilities.DCGM, &capabilities.Proc}
	for _, state := range states {
		if state.Available {
			state.Available, state.Status, state.Message = false, model.StatusStale, detail
		}
	}
	capabilities.ProfileMetrics = false
	return capabilities
}

func (e *Engine) applyGenerations(snapshot *model.Snapshot) {
	e.mu.Lock()
	defer e.mu.Unlock()
	active := make(map[string]bool)
	for gpuIndex := range snapshot.GPUs {
		for giIndex := range snapshot.GPUs[gpuIndex].GPUInstances {
			gi := &snapshot.GPUs[gpuIndex].GPUInstances[giIndex]
			giKey := "gi:" + gi.UUID
			active[giKey] = true
			gi.Generation = generationValue(gi.UUID, e.generations, giKey, gpuInstanceSignature(*gi), snapshot.SampledAt)
			for ciIndex := range snapshot.GPUs[gpuIndex].GPUInstances[giIndex].ComputeInstances {
				ci := &snapshot.GPUs[gpuIndex].GPUInstances[giIndex].ComputeInstances[ciIndex]
				ciKey := "ci:" + ci.UUID
				active[ciKey] = true
				ci.Generation = generationValue(ci.UUID, e.generations, ciKey, computeInstanceSignature(*ci), snapshot.SampledAt)
			}
		}
	}
	for uuid, state := range e.generations {
		if !active[uuid] {
			state.active = false
			if e.window > 0 && !state.lastSeen.IsZero() && snapshot.SampledAt.Sub(state.lastSeen) > e.window {
				delete(e.generations, uuid)
			}
		}
	}
}

func generationValue(uuid string, generations map[string]*generationState, key, signature string, sampledAt time.Time) string {
	state := generations[key]
	if state == nil {
		state = &generationState{value: 1, signature: signature}
		generations[key] = state
	} else if !state.active || state.signature != signature {
		state.value++
	}
	state.active, state.signature, state.lastSeen = true, signature, sampledAt
	return fmt.Sprintf("%s@g%d", uuid, state.value)
}

func gpuInstanceSignature(instance model.GPUInstance) string {
	children := make([]string, 0, len(instance.ComputeInstances))
	for _, child := range instance.ComputeInstances {
		children = append(children, fmt.Sprintf("%s:%d:%s", child.UUID, child.ID, child.Profile))
	}
	sort.Strings(children)
	return fmt.Sprintf("%d:%s:%s", instance.ID, instance.Profile, strings.Join(children, ","))
}

func computeInstanceSignature(instance model.ComputeInstance) string {
	return fmt.Sprintf("%d:%s", instance.ID, instance.Profile)
}

func (e *Engine) publish(snapshot model.Snapshot) {
	e.mu.Lock()
	defer e.mu.Unlock()
	for _, channel := range e.subscribers {
		select {
		case channel <- snapshot:
		default:
			select {
			case <-channel:
			default:
			}
			select {
			case channel <- snapshot:
			default:
			}
		}
	}
}

func (e *Engine) Current() (model.Snapshot, bool) {
	value := e.current.Load()
	if value == nil {
		return model.Snapshot{}, false
	}
	return *value, true
}

func (e *Engine) History(entity string, metrics []string, window time.Duration, now time.Time) history.Series {
	if snapshot, ok := e.Current(); ok {
		entity = resolveHistoryEntity(snapshot, entity)
	}
	result := e.history.Query(entity, metrics, window, now)
	if at := len(result.Entity); at > 0 {
		// Keep the requested stable UUID in the response, not the internal generation key.
		if index := lastGenerationSeparator(result.Entity); index > 0 {
			result.Entity = result.Entity[:index]
		}
	}
	return result
}

// AlignedHistory resolves every stable UUID against one immutable topology
// snapshot, then reads and limits all series together on the buffer's shared
// timestamp set. Response descriptors retain the caller's stable UUIDs.
func (e *Engine) AlignedHistory(descriptors []history.SeriesDescriptor, window time.Duration, maxPoints int, now time.Time) history.AlignedSeries {
	requested := make([]history.SeriesDescriptor, len(descriptors))
	resolved := make([]history.SeriesDescriptor, len(descriptors))
	copy(requested, descriptors)
	copy(resolved, descriptors)
	for index := range descriptors {
		requested[index].Metrics = append([]string(nil), descriptors[index].Metrics...)
		resolved[index].Metrics = append([]string(nil), descriptors[index].Metrics...)
	}
	queryAt := now
	if snapshot, ok := e.Current(); ok {
		for index := range resolved {
			resolved[index].Entity = resolveHistoryEntity(snapshot, resolved[index].Entity)
		}
		if !snapshot.SampledAt.IsZero() {
			queryAt = snapshot.SampledAt
		}
	}
	result := e.history.QueryAligned(resolved, window, maxPoints, queryAt)
	result.Series = requested
	return result
}

func resolveHistoryEntity(snapshot model.Snapshot, entity string) string {
	for _, gpu := range snapshot.GPUs {
		for _, gi := range gpu.GPUInstances {
			if entity == gi.UUID && gi.Generation != "" {
				return gi.Generation
			}
			for _, ci := range gi.ComputeInstances {
				if entity == ci.UUID && ci.Generation != "" {
					return ci.Generation
				}
			}
		}
	}
	return entity
}

func lastGenerationSeparator(value string) int {
	for i := len(value) - 1; i >= 0; i-- {
		if value[i] == '@' && i+2 < len(value) && value[i+1] == 'g' {
			return i
		}
	}
	return -1
}

func (e *Engine) Subscribe() (<-chan model.Snapshot, func()) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.nextSubID++
	id := e.nextSubID
	channel := make(chan model.Snapshot, 1)
	e.subscribers[id] = channel
	if snapshot, ok := e.Current(); ok {
		channel <- snapshot
	}
	return channel, func() {
		e.mu.Lock()
		defer e.mu.Unlock()
		if existing, ok := e.subscribers[id]; ok {
			delete(e.subscribers, id)
			close(existing)
		}
	}
}

func (e *Engine) Capabilities() model.Capabilities {
	if snapshot, ok := e.Current(); ok {
		return snapshot.Capabilities
	}
	return e.provider.Capabilities()
}

func (e *Engine) LastError() error {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.lastErr
}

func (e *Engine) Stop() error {
	e.mu.Lock()
	cancel := e.cancel
	e.mu.Unlock()
	if cancel == nil {
		return nil
	}
	cancel()
	<-e.done
	return nil
}
