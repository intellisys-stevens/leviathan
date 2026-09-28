// Package plugins schedules installed sources. Each capability has one bounded
// in-flight read, independent cadence, and independent failure state.
package plugins

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/intellisys-stevens/leviathan/internal/config"
	v1 "github.com/intellisys-stevens/leviathan/plugin/v1"
)

const RequestTimeout = 2 * time.Second

type Instance struct {
	Config config.PluginConfig
	Source v1.Source
	// Native keeps established IDs in the default composition. External IDs are
	// qualified by instance in the local snapshot, never by measurement source.
	Native   bool
	Interval time.Duration
}

type CapabilityHealth struct {
	Capability  v1.Capability `json:"capability"`
	Revision    string        `json:"revision"`
	Enabled     bool          `json:"enabled"`
	Status      string        `json:"status"`
	ObservedAt  *time.Time    `json:"observedAt,omitempty"`
	LastSuccess *time.Time    `json:"lastSuccess,omitempty"`
	Message     string        `json:"message,omitempty"`
}

type Health struct {
	ID             string             `json:"id"`
	Implementation string             `json:"implementation"`
	Transport      string             `json:"transport"`
	Capabilities   []CapabilityHealth `json:"capabilities"`
	Status         string             `json:"status"`
	Message        string             `json:"message,omitempty"`
	Dependencies   []string           `json:"dependencies"`
	IntervalMs     int64              `json:"intervalMs"`
}

type Event struct {
	InstanceID  string
	Native      bool
	Capability  v1.Capability
	Observation *v1.Observation
	Err         error
	At          time.Time
	Interval    time.Duration
}

type Runtime struct {
	instances []Instance // dependency order
	order     []string
	mu        sync.RWMutex
	health    map[string]Health
	previous  map[string]v1.Observation
	intervals map[string]time.Duration
	wakeups   map[string]chan struct{}
}

func New(instances []Instance) (*Runtime, error) {
	byID := make(map[string]Instance, len(instances))
	for _, instance := range instances {
		if instance.Config.Disabled {
			continue
		}
		if instance.Source == nil || instance.Interval <= 0 {
			return nil, fmt.Errorf("invalid plugin %s", instance.Config.ID)
		}
		if _, exists := byID[instance.Config.ID]; exists {
			return nil, fmt.Errorf("duplicate plugin %s", instance.Config.ID)
		}
		byID[instance.Config.ID] = instance
	}
	runtime := &Runtime{health: map[string]Health{}, previous: map[string]v1.Observation{}, intervals: map[string]time.Duration{}, wakeups: map[string]chan struct{}{}}
	visiting, done := map[string]bool{}, map[string]bool{}
	var visit func(string) error
	visit = func(id string) error {
		if done[id] {
			return nil
		}
		if visiting[id] {
			return fmt.Errorf("plugin dependency cycle at %s", id)
		}
		entry, ok := byID[id]
		if !ok {
			return fmt.Errorf("missing plugin dependency %s", id)
		}
		visiting[id] = true
		for _, dependency := range entry.Config.Dependencies {
			if err := visit(dependency); err != nil {
				return err
			}
		}
		done[id], visiting[id] = true, false
		runtime.instances = append(runtime.instances, entry)
		return nil
	}
	for _, instance := range instances {
		if !instance.Config.Disabled {
			if err := visit(instance.Config.ID); err != nil {
				return nil, err
			}
		}
	}
	for _, instance := range instances {
		runtime.order = append(runtime.order, instance.Config.ID)
		runtime.intervals[instance.Config.ID] = instance.Interval
		transport := "unix"
		if instance.Native {
			transport = "builtin"
		}
		runtime.health[instance.Config.ID] = Health{ID: instance.Config.ID, Implementation: instance.Config.Builtin, Transport: transport, Status: "pending", Dependencies: append([]string{}, instance.Config.Dependencies...), IntervalMs: instance.Interval.Milliseconds(), Capabilities: []CapabilityHealth{}}
		if instance.Config.Disabled {
			state := runtime.health[instance.Config.ID]
			state.Status = "disabled"
			runtime.health[instance.Config.ID] = state
		}
	}
	for _, instance := range runtime.instances {
		if instance.Native {
			if _, err := runtime.manifest(instance); err != nil {
				return nil, err
			}
		}
	}
	return runtime, nil
}

func (r *Runtime) List() []Health {
	r.mu.RLock()
	defer r.mu.RUnlock()
	result := make([]Health, 0, len(r.order))
	for _, id := range r.order {
		health := r.health[id]
		health.Capabilities = append([]CapabilityHealth{}, health.Capabilities...)
		health.Dependencies = append([]string{}, health.Dependencies...)
		result = append(result, health)
	}
	return result
}

func (r *Runtime) manifest(instance Instance) ([]v1.Capability, error) {
	manifest := instance.Source.Manifest()
	if err := manifest.Validate(); err != nil {
		return nil, err
	}
	enabled := map[v1.Capability]bool{}
	for _, capability := range instance.Config.Capabilities {
		name := v1.Capability(capability)
		if _, exists := manifest.Capabilities[name]; !exists {
			return nil, fmt.Errorf("plugin does not advertise %s", name)
		}
		enabled[name] = true
	}
	capabilities := make([]v1.Capability, 0, len(manifest.Capabilities))
	for capability := range manifest.Capabilities {
		capabilities = append(capabilities, capability)
	}
	sort.Slice(capabilities, func(i, j int) bool { return capabilities[i] < capabilities[j] })
	states := make([]CapabilityHealth, 0, len(capabilities))
	selected := make([]v1.Capability, 0, len(capabilities))
	for _, capability := range capabilities {
		active := len(instance.Config.Capabilities) == 0 || enabled[capability]
		status := "disabled"
		if active {
			status = "pending"
			selected = append(selected, capability)
		}
		states = append(states, CapabilityHealth{Capability: capability, Revision: manifest.Capabilities[capability], Enabled: active, Status: status})
	}
	r.mu.Lock()
	health := r.health[instance.Config.ID]
	health.Implementation = manifest.ID
	health.Capabilities = states
	health.Status = "pending"
	health.Message = ""
	r.health[instance.Config.ID] = health
	r.mu.Unlock()
	return selected, nil
}

// Run initializes dependencies in order, retries failed opens independently, and
// closes successfully opened sources in reverse dependency order after reads end.
// An unavailable optional source never prevents another source from publishing.
func (r *Runtime) Run(ctx context.Context, emit func(Event)) {
	ready := map[string]chan struct{}{}
	for _, instance := range r.instances {
		ready[instance.Config.ID] = make(chan struct{})
	}
	opened := make([]bool, len(r.instances))
	var workers sync.WaitGroup
	for index, instance := range r.instances {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for _, dependency := range instance.Config.Dependencies {
				select {
				case <-ctx.Done():
					return
				case <-ready[dependency]:
				}
			}
			var capabilities []v1.Capability
			for ctx.Err() == nil {
				request, cancel := context.WithTimeout(ctx, RequestTimeout)
				err := instance.Source.Open(request)
				cancel()
				if err == nil {
					capabilities, err = r.manifest(instance)
				}
				if err == nil {
					opened[index] = true
					close(ready[instance.Config.ID])
					break
				}
				_ = instance.Source.Close()
				r.setError(instance.Config.ID, err)
				emit(Event{InstanceID: instance.Config.ID, Native: instance.Native, Err: err, At: time.Now().UTC(), Interval: instance.Interval})
				if !wait(ctx, instance.Interval) {
					return
				}
			}
			if !opened[index] {
				return
			}
			var polls sync.WaitGroup
			for _, capability := range capabilities {
				polls.Add(1)
				go func() { defer polls.Done(); r.runCapability(ctx, instance, capability, emit) }()
			}
			polls.Wait()
		}()
	}
	workers.Wait()
	for index := len(r.instances) - 1; index >= 0; index-- {
		if opened[index] {
			if err := r.instances[index].Source.Close(); err != nil {
				r.setError(r.instances[index].Config.ID, err)
			}
		}
	}
}

// Check opens each instance once, reads each enabled capability once, and closes
// in reverse order. It validates endpoints, unlike offline config-check.
func (r *Runtime) Check(ctx context.Context, emit func(Event)) error {
	return r.Collect(ctx, 0, emit)
}

// Collect shares construction with continuous monitoring and optionally warms
// delta counters before returning a one-shot snapshot.
func (r *Runtime) Collect(ctx context.Context, warmup time.Duration, emit func(Event)) error {
	var failures []error
	var opened []Instance
	selected := map[string][]v1.Capability{}
	ready := map[string]bool{}
	defer func() {
		for i := len(opened) - 1; i >= 0; i-- {
			_ = opened[i].Source.Close()
		}
	}()
	for _, instance := range r.instances {
		var err error
		for _, dependency := range instance.Config.Dependencies {
			if !ready[dependency] {
				err = fmt.Errorf("dependency %s unavailable", dependency)
			}
		}
		if err == nil {
			request, cancel := context.WithTimeout(ctx, RequestTimeout)
			err = instance.Source.Open(request)
			cancel()
		}
		if err != nil {
			_ = instance.Source.Close()
			r.setError(instance.Config.ID, err)
			failures = append(failures, err)
			if emit != nil {
				emit(Event{InstanceID: instance.Config.ID, Native: instance.Native, Err: err, At: time.Now().UTC(), Interval: instance.Interval})
			}
			continue
		}
		opened = append(opened, instance)
		capabilities, err := r.manifest(instance)
		if err != nil {
			r.setError(instance.Config.ID, err)
			failures = append(failures, err)
			continue
		}
		ready[instance.Config.ID] = true
		selected[instance.Config.ID] = capabilities
		var reads sync.WaitGroup
		var failureMu sync.Mutex
		for _, capability := range capabilities {
			reads.Add(1)
			go func() {
				defer reads.Done()
				if err := r.poll(ctx, instance, capability, emit); err != nil {
					failureMu.Lock()
					failures = append(failures, err)
					failureMu.Unlock()
				}
			}()
		}
		reads.Wait()
	}
	if warmup > 0 {
		if !wait(ctx, warmup) {
			return ctx.Err()
		}
		var reads sync.WaitGroup
		for _, instance := range opened {
			for _, capability := range selected[instance.Config.ID] {
				reads.Add(1)
				go func() { defer reads.Done(); _ = r.poll(ctx, instance, capability, emit) }()
			}
		}
		reads.Wait()
	}
	return errors.Join(failures...)
}

func (r *Runtime) poll(ctx context.Context, instance Instance, capability v1.Capability, emit func(Event)) error {
	requestedAt := time.Now().UTC()
	instance.Interval = r.intervalFor(instance.Config.ID)
	request, cancel := context.WithTimeout(ctx, RequestTimeout)
	observation, err := instance.Source.Read(request, capability, requestedAt)
	cancel()
	completedAt := time.Now().UTC()
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if err == nil {
		err = observation.ValidateAt(completedAt)
	}
	if err == nil && (observation.InstanceID != instance.Config.ID || observation.Capability != capability) {
		err = errors.New("observation identity or capability does not match request")
	}
	key := instance.Config.ID + "/" + string(capability)
	r.mu.Lock()
	previous, exists := r.previous[key]
	if err == nil && exists && previous.SessionID == observation.SessionID && (observation.Revision < previous.Revision || observation.ObservedAt.Before(previous.ObservedAt)) {
		err = errors.New("observation revision or timestamp moved backwards")
	}
	if err == nil {
		r.previous[key] = observation
	}
	health := r.health[instance.Config.ID]
	for i := range health.Capabilities {
		state := &health.Capabilities[i]
		if state.Capability != capability {
			continue
		}
		if err != nil {
			state.Status = "error"
			state.Message = err.Error()
		} else {
			state.Status = observation.Status
			state.Message = observation.Message
			observedAt := observation.ObservedAt
			state.ObservedAt = &observedAt
			state.LastSuccess = &completedAt
			if completedAt.Sub(observation.ObservedAt) > 3*instance.Interval {
				state.Status = "stale"
				state.Message = "source observation is stale"
			}
		}
	}
	health.Status = "available"
	health.Message = ""
	for _, state := range health.Capabilities {
		if state.Enabled && state.Status != "available" {
			health.Status = "degraded"
		}
	}
	r.health[instance.Config.ID] = health
	r.mu.Unlock()
	event := Event{InstanceID: instance.Config.ID, Native: instance.Native, Capability: capability, Err: err, At: completedAt, Interval: instance.Interval}
	if err == nil {
		event.Observation = &observation
	}
	if emit != nil {
		emit(event)
	}
	return err
}

func (r *Runtime) setError(id string, err error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	health := r.health[id]
	health.Status = "error"
	health.Message = err.Error()
	r.health[id] = health
}
func wait(ctx context.Context, interval time.Duration) bool {
	timer := time.NewTimer(interval)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func (r *Runtime) intervalFor(id string) time.Duration {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.intervals[id]
}

func (r *Runtime) SetSamplingInterval(interval time.Duration) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, instance := range r.instances {
		if instance.Config.Interval != "" {
			continue
		}
		r.intervals[instance.Config.ID] = interval
		state := r.health[instance.Config.ID]
		state.IntervalMs = interval.Milliseconds()
		r.health[instance.Config.ID] = state
		for key, wake := range r.wakeups {
			if strings.HasPrefix(key, instance.Config.ID+"/") {
				select {
				case wake <- struct{}{}:
				default:
				}
			}
		}
	}
}

func (r *Runtime) runCapability(ctx context.Context, instance Instance, capability v1.Capability, emit func(Event)) {
	key := instance.Config.ID + "/" + string(capability)
	wake := make(chan struct{}, 1)
	r.mu.Lock()
	r.wakeups[key] = wake
	r.mu.Unlock()
	defer func() { r.mu.Lock(); delete(r.wakeups, key); r.mu.Unlock() }()
	for ctx.Err() == nil {
		_ = r.poll(ctx, instance, capability, emit)
		timer := time.NewTimer(r.intervalFor(instance.Config.ID))
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-wake:
			timer.Stop()
		case <-timer.C:
		}
	}
}
