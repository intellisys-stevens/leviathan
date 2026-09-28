package plugins

import (
	"context"
	"errors"
	"math"
	"reflect"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/intellisys-stevens/leviathan/internal/config"
	"github.com/intellisys-stevens/leviathan/model"
	v1 "github.com/intellisys-stevens/leviathan/plugin/v1"
)

type runtimeSource struct {
	capabilities map[v1.Capability]string
	open         func(context.Context) error
	read         func(context.Context, v1.Capability, time.Time) (v1.Observation, error)
	close        func() error
}

func (s *runtimeSource) Manifest() v1.Manifest {
	return v1.Manifest{ProtocolVersion: "1", ID: "test", Version: "1", Capabilities: s.capabilities}
}
func (s *runtimeSource) Open(ctx context.Context) error {
	if s.open != nil {
		return s.open(ctx)
	}
	return nil
}
func (s *runtimeSource) Read(ctx context.Context, cap v1.Capability, at time.Time) (v1.Observation, error) {
	return s.read(ctx, cap, at)
}
func (s *runtimeSource) Close() error {
	if s.close != nil {
		return s.close()
	}
	return nil
}
func runtimeGPU(id string, at time.Time) v1.Observation {
	return v1.Observation{InstanceID: id, SessionID: "first", Capability: v1.GPU, Revision: 1, ObservedAt: at, Status: "available", GPU: &v1.GPUData{GPUs: []model.GPU{{UUID: "GPU-one", Metrics: model.MetricSet{"gpu_activity": model.AvailableMetric(25, "percent", "test_sensor", model.ScopePhysicalGPU, at)}}}}}
}
func runtimeInstance(id string, s v1.Source) Instance {
	return Instance{Config: config.PluginConfig{ID: id, Builtin: "test"}, Source: s, Native: true, Interval: 20 * time.Millisecond}
}

func TestCapabilityTimeoutDoesNotBlockOtherCapability(t *testing.T) {
	var sequence atomic.Uint64
	s := &runtimeSource{capabilities: map[v1.Capability]string{v1.GPU: "1", v1.Host: "1"}}
	s.read = func(ctx context.Context, capability v1.Capability, at time.Time) (v1.Observation, error) {
		if capability == v1.Host {
			<-ctx.Done()
			return v1.Observation{}, ctx.Err()
		}
		observation := runtimeGPU("source", at)
		observation.Revision = sequence.Add(1)
		return observation, nil
	}
	runtime, err := New([]Instance{runtimeInstance("source", s)})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	events := make(chan Event, 256)
	done := make(chan struct{})
	go func() { defer close(done); runtime.Run(ctx, func(e Event) { events <- e }) }()
	deadline := time.After(RequestTimeout + time.Second)
	successes := 0
	for {
		select {
		case event := <-events:
			if event.Capability == v1.GPU && event.Err == nil {
				successes++
			}
			if event.Capability == v1.Host {
				if !errors.Is(event.Err, context.DeadlineExceeded) {
					t.Fatalf("host error: %v", event.Err)
				}
				if successes < 3 {
					t.Fatalf("GPU stalled behind host: %d successes", successes)
				}
				cancel()
				select {
				case <-done:
				case <-time.After(time.Second):
					t.Fatal("runtime did not stop")
				}
				return
			}
		case <-deadline:
			t.Fatal("host read did not honor request deadline")
		}
	}
}

func TestDependenciesOpenBeforeConsumersAndCloseInReverse(t *testing.T) {
	var mu sync.Mutex
	var events []string
	source := func(id string) *runtimeSource {
		return &runtimeSource{capabilities: map[v1.Capability]string{v1.GPU: "1"}, open: func(context.Context) error { mu.Lock(); events = append(events, "open "+id); mu.Unlock(); return nil }, read: func(_ context.Context, _ v1.Capability, at time.Time) (v1.Observation, error) {
			return runtimeGPU(id, at), nil
		}, close: func() error { mu.Lock(); events = append(events, "close "+id); mu.Unlock(); return nil }}
	}
	base, leaf := runtimeInstance("base", source("base")), runtimeInstance("leaf", source("leaf"))
	leaf.Config.Dependencies = []string{"base"}
	runtime, err := New([]Instance{leaf, base})
	if err != nil {
		t.Fatal(err)
	}
	if err = runtime.Check(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	want := []string{"open base", "open leaf", "close leaf", "close base"}
	if !reflect.DeepEqual(events, want) {
		t.Fatalf("lifecycle %v, want %v", events, want)
	}
}

func TestFailedOpenIsClosedAndDoesNotOpenDependent(t *testing.T) {
	closed, dependentOpened := 0, false
	broken := &runtimeSource{capabilities: map[v1.Capability]string{v1.GPU: "1"}, open: func(context.Context) error { return errors.New("init failed") }, close: func() error { closed++; return nil }}
	dependent := &runtimeSource{capabilities: map[v1.Capability]string{v1.GPU: "1"}, open: func(context.Context) error { dependentOpened = true; return nil }}
	a, b := runtimeInstance("broken", broken), runtimeInstance("dependent", dependent)
	b.Config.Dependencies = []string{"broken"}
	runtime, err := New([]Instance{a, b})
	if err != nil {
		t.Fatal(err)
	}
	if err = runtime.Check(context.Background(), nil); err == nil {
		t.Fatal("missing initialization error")
	}
	if closed != 1 || dependentOpened {
		t.Fatalf("closed=%d dependent opened=%v", closed, dependentOpened)
	}
}

func TestRuntimeRejectsMalformedAndRegressedObservations(t *testing.T) {
	at := time.Now().UTC().Add(-time.Second)
	observation := runtimeGPU("source", at)
	observation.Revision = 5
	source := &runtimeSource{capabilities: map[v1.Capability]string{v1.GPU: "1"}, read: func(context.Context, v1.Capability, time.Time) (v1.Observation, error) { return observation, nil }}
	instance := runtimeInstance("source", source)
	runtime, err := New([]Instance{instance})
	if err != nil {
		t.Fatal(err)
	}
	poll := func() error { return runtime.poll(context.Background(), instance, v1.GPU, nil) }
	if err = poll(); err != nil {
		t.Fatal(err)
	}
	observation.Revision = 4
	if poll() == nil {
		t.Fatal("accepted backwards revision")
	}
	observation.Revision = 6
	observation.ObservedAt = at.Add(-time.Second)
	if poll() == nil {
		t.Fatal("accepted backwards timestamp")
	}
	observation = runtimeGPU("source", at)
	observation.SessionID = "restarted"
	if err = poll(); err != nil {
		t.Fatalf("restart: %v", err)
	}
	for name, change := range map[string]func(*v1.Observation){
		"future nested timestamp": func(o *v1.Observation) {
			m := o.GPU.GPUs[0].Metrics["gpu_activity"]
			m.SampledAt = time.Now().Add(time.Minute)
			o.GPU.GPUs[0].Metrics["gpu_activity"] = m
		},
		"nonfinite value": func(o *v1.Observation) {
			m := o.GPU.GPUs[0].Metrics["gpu_activity"]
			m.Value = model.Float(math.NaN())
			o.GPU.GPUs[0].Metrics["gpu_activity"] = m
		},
		"invalid unit": func(o *v1.Observation) {
			m := o.GPU.GPUs[0].Metrics["gpu_activity"]
			m.Unit = "unknown"
			o.GPU.GPUs[0].Metrics["gpu_activity"] = m
		},
		"duplicate resource": func(o *v1.Observation) { o.GPU.GPUs = append(o.GPU.GPUs, o.GPU.GPUs[0]) },
	} {
		t.Run(name, func(t *testing.T) {
			observation = runtimeGPU("source", at)
			observation.SessionID = "restarted"
			observation.Revision = 2
			change(&observation)
			if poll() == nil {
				t.Fatal("accepted malformed payload")
			}
		})
	}
}

func TestCachedObservationStaysStaleWithoutTimestampRefresh(t *testing.T) {
	at := time.Now().UTC().Add(-time.Minute)
	source := &runtimeSource{capabilities: map[v1.Capability]string{v1.GPU: "1"}, read: func(context.Context, v1.Capability, time.Time) (v1.Observation, error) {
		return runtimeGPU("source", at), nil
	}}
	instance := runtimeInstance("source", source)
	runtime, err := New([]Instance{instance})
	if err != nil {
		t.Fatal(err)
	}
	if err = runtime.poll(context.Background(), instance, v1.GPU, nil); err != nil {
		t.Fatal(err)
	}
	state := runtime.List()[0].Capabilities[0]
	if state.Status != "stale" || state.ObservedAt == nil || !state.ObservedAt.Equal(at) || state.LastSuccess == nil || !state.LastSuccess.After(at) {
		t.Fatalf("freshness was refreshed: %+v", state)
	}
}

func TestSamplingSettingsWakeInheritedCadenceAndKeepExplicitCadence(t *testing.T) {
	source := func(id string) *runtimeSource {
		var sequence atomic.Uint64
		return &runtimeSource{capabilities: map[v1.Capability]string{v1.GPU: "1", v1.Processes: "1"}, read: func(_ context.Context, cap v1.Capability, at time.Time) (v1.Observation, error) {
			o := runtimeGPU(id, at)
			o.Revision = sequence.Add(1)
			if cap != v1.GPU {
				t.Error("disabled capability was polled")
			}
			return o, nil
		}}
	}
	inherited, explicit := runtimeInstance("inherited", source("inherited")), runtimeInstance("explicit", source("explicit"))
	inherited.Interval, explicit.Interval = time.Hour, time.Hour
	inherited.Config.Capabilities = []string{"gpu"}
	explicit.Config.Capabilities = []string{"gpu"}
	explicit.Config.Interval = "1h"
	disabled := Instance{Config: config.PluginConfig{ID: "disabled", Builtin: "test", Disabled: true}}
	runtime, err := New([]Instance{inherited, explicit, disabled})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	events := make(chan Event, 32)
	done := make(chan struct{})
	go func() { defer close(done); runtime.Run(ctx, func(e Event) { events <- e }) }()
	seen := map[string]bool{}
	for len(seen) < 2 {
		select {
		case e := <-events:
			if e.Err != nil {
				t.Fatal(e.Err)
			}
			seen[e.InstanceID] = true
		case <-time.After(time.Second):
			t.Fatal("missing first observations")
		}
	}
	runtime.SetSamplingInterval(10 * time.Millisecond)
	select {
	case e := <-events:
		if e.InstanceID != "inherited" || e.Interval != 10*time.Millisecond {
			t.Fatalf("incorrect settings wakeup: %+v", e)
		}
	case <-time.After(time.Second):
		t.Fatal("inherited cadence did not wake")
	}
	states := runtime.List()
	if len(states) != 3 || states[0].IntervalMs != 10 || states[1].IntervalMs != time.Hour.Milliseconds() || states[2].Status != "disabled" {
		t.Fatalf("settings/list states: %+v", states)
	}
	for _, capability := range states[0].Capabilities {
		if capability.Capability == v1.Processes && (capability.Enabled || capability.Status != "disabled") {
			t.Fatalf("unselected capability not disabled: %+v", capability)
		}
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("runtime did not stop")
	}
}
