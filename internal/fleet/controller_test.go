package fleet

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/intellisys-stevens/miglens/internal/model"
)

const secretCanary = "SECRET-CANARY-MUST-NEVER-LEAK"

type inventoryResult struct {
	observation InventoryObservation
	err         error
}

type scriptedInventory struct {
	mu      sync.Mutex
	results []inventoryResult
	calls   int
}

func (source *scriptedInventory) List(context.Context) (InventoryObservation, error) {
	source.mu.Lock()
	defer source.mu.Unlock()
	index := source.calls
	source.calls++
	if index >= len(source.results) {
		index = len(source.results) - 1
	}
	observation := source.results[index].observation
	observation.Instances = append([]Instance(nil), observation.Instances...)
	for instanceIndex := range observation.Instances {
		if observation.Instances[instanceIndex].CreatorID == "" {
			// Controller tests use the synthetic display name as the synthetic
			// authoritative ID unless a test supplies a distinct ID explicitly.
			observation.Instances[instanceIndex].CreatorID = observation.Instances[instanceIndex].CreatorUsername
		}
	}
	return observation, source.results[index].err
}

type scriptedAgent struct {
	mu      sync.Mutex
	samples map[string]AgentSample
	errors  map[string]error
	calls   []string
}

func (source *scriptedAgent) Observe(_ context.Context, instance Instance) (AgentSample, error) {
	source.mu.Lock()
	defer source.mu.Unlock()
	source.calls = append(source.calls, instance.UUID)
	return source.samples[instance.UUID], source.errors[instance.UUID]
}

func (source *scriptedAgent) calledUUIDs() []string {
	source.mu.Lock()
	defer source.mu.Unlock()
	result := make([]string, len(source.calls))
	copy(result, source.calls)
	return result
}

func TestControllerOnlyContactsExactAllowedActiveInstances(t *testing.T) {
	now := time.Date(2026, time.August, 30, 18, 0, 0, 0, time.UTC)
	instances := []Instance{
		{UUID: instanceThree, Name: "Charlie", CreatorUsername: "owner-c@example.test", CloudState: CloudStateShelvedOffloaded},
		{UUID: instanceTwo, Name: "Bravo", CreatorUsername: "unexpected@example.test", CloudState: CloudStateActive},
		{UUID: instanceFour, Name: "Delta", CreatorUsername: "owner-d@example.test", CloudState: CloudStateActive},
		{UUID: instanceOne, Name: "Alpha", CreatorUsername: "owner-a@example.test", CloudState: CloudStateActive},
	}
	inventory := &scriptedInventory{results: []inventoryResult{{observation: InventoryObservation{ObservedAt: now, Instances: instances}}}}
	agents := &scriptedAgent{samples: map[string]AgentSample{
		instanceOne: sampleAt(now, "agent-host", instanceOne),
	}, errors: map[string]error{}}
	policy := mustPolicy(t, map[string]string{
		instanceOne:   "owner-a@example.test",
		instanceTwo:   "owner-b@example.test",
		instanceThree: "owner-c@example.test",
	})
	controller := mustController(t, inventory, agents, policy, now)

	state := controller.Refresh(context.Background())
	if got := agents.calledUUIDs(); len(got) != 1 || got[0] != instanceOne {
		t.Fatalf("agent calls = %v, want only %s", got, instanceOne)
	}
	if state.SchemaVersion != SchemaVersion || state.Sequence != 1 {
		t.Fatalf("state header = schema %q sequence %d", state.SchemaVersion, state.Sequence)
	}
	observations := state.Platforms[0].Instances
	if len(observations) != 4 {
		t.Fatalf("instances length = %d, want 4 instances", len(observations))
	}
	wantNames := []string{"Alpha", "Bravo", "Charlie", "Delta"}
	for index, want := range wantNames {
		if observations[index].Instance.Name != want {
			t.Fatalf("instances[%d].name = %q, want %q", index, observations[index].Instance.Name, want)
		}
	}
	assertObservation(t, observations[0], true, true, PolicyAllowed, AgentAvailable)
	assertObservation(t, observations[1], false, false, PolicyCreatorMismatch, AgentNotManaged)
	assertObservation(t, observations[2], true, false, PolicyCloudNotActive, AgentNotManaged)
	assertObservation(t, observations[3], false, false, PolicyNotAllowlisted, AgentNotManaged)
	if observations[0].Agent.Snapshot == nil || observations[0].Agent.Snapshot.SchemaVersion != "v1" {
		t.Fatalf("nested agent snapshot was changed: %+v", observations[0].Agent.Snapshot)
	}
}

func TestControllerDoesNotProbeUnconfiguredAgentAndUsesTrustedCreatorLabel(t *testing.T) {
	now := time.Date(2026, time.August, 30, 18, 2, 0, 0, time.UTC)
	inventory := &scriptedInventory{results: []inventoryResult{{observation: InventoryObservation{
		ObservedAt: now,
		Instances: []Instance{{
			UUID: instanceOne, Name: "Alpha", CreatorID: "nova-user-a", CreatorUsername: "spoofed-metadata@example.test", CloudState: CloudStateActive,
		}},
	}}}}
	agents := &scriptedAgent{samples: map[string]AgentSample{}, errors: map[string]error{}}
	policy, err := NewPolicy(map[string]AllowedIdentity{instanceOne: {
		CreatorID: "nova-user-a", CreatorUsername: "owner-a@example.test", AgentConfigured: false,
	}})
	if err != nil {
		t.Fatal(err)
	}
	state := mustController(t, inventory, agents, policy, now).Refresh(context.Background())
	if calls := agents.calledUUIDs(); len(calls) != 0 {
		t.Fatalf("agent calls = %v, want none", calls)
	}
	observation := state.Platforms[0].Instances[0]
	assertObservation(t, observation, true, false, PolicyAgentNotConfigured, AgentNotConfigured)
	if observation.Instance.CreatorUsername != "owner-a@example.test" {
		t.Fatalf("creator username = %q, want trusted configured label", observation.Instance.CreatorUsername)
	}
	encoded, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "nova-user-a") || strings.Contains(string(encoded), "spoofed-metadata") {
		t.Fatalf("fleet JSON leaked a private creator ID or advisory metadata: %s", encoded)
	}
}

func TestControllerIsolatesAgentFailureAndRedactsErrors(t *testing.T) {
	now := time.Date(2026, time.August, 30, 18, 5, 0, 0, time.UTC)
	inventory := &scriptedInventory{
		results: []inventoryResult{
			{observation: InventoryObservation{
				ObservedAt: now,
				Instances: []Instance{
					{UUID: instanceOne, Name: "Alpha", CreatorUsername: "owner-a@example.test", CloudState: CloudStateActive},
					{UUID: instanceTwo, Name: "Bravo", CreatorUsername: "owner-b@example.test", CloudState: CloudStateActive},
				},
			}},
		},
	}
	agents := &scriptedAgent{
		samples: map[string]AgentSample{instanceTwo: sampleAt(now, "healthy-host", instanceTwo)},
		errors:  map[string]error{instanceOne: errors.New("endpoint password=" + secretCanary)},
	}
	policy := mustPolicy(t, map[string]string{
		instanceOne: "owner-a@example.test",
		instanceTwo: "owner-b@example.test",
	})
	state := mustController(t, inventory, agents, policy, now).Refresh(context.Background())

	observations := state.Platforms[0].Instances
	assertObservation(t, observations[0], true, true, PolicyAllowed, AgentUnreachable)
	assertObservation(t, observations[1], true, true, PolicyAllowed, AgentAvailable)
	encoded, err := json.Marshal(state)
	if err != nil {
		t.Fatalf("json.Marshal() error = %v", err)
	}
	text := string(encoded)
	if strings.Contains(text, secretCanary) {
		t.Fatalf("fleet JSON leaked source error secret: %s", text)
	}
	for _, forbiddenKey := range []string{"metadata", "tags", "token", "password", "agentEndpoint", "adminPass"} {
		if strings.Contains(strings.ToLower(text), strings.ToLower(forbiddenKey)) {
			t.Fatalf("fleet JSON contains forbidden field %q: %s", forbiddenKey, text)
		}
	}
}

func TestControllerRetainsLastGoodStateWhenInventoryFails(t *testing.T) {
	first := time.Date(2026, time.August, 30, 18, 10, 0, 0, time.UTC)
	second := first.Add(time.Minute)
	clockNow := first
	inventory := &scriptedInventory{results: []inventoryResult{
		{observation: InventoryObservation{ObservedAt: first, Instances: []Instance{{
			UUID: instanceOne, Name: "Alpha", CreatorUsername: "owner-a@example.test", CloudState: CloudStateActive,
		}}}},
		{err: errors.New("application credential " + secretCanary)},
	}}
	agents := &scriptedAgent{samples: map[string]AgentSample{instanceOne: sampleAt(first, "agent-host", instanceOne)}, errors: map[string]error{}}
	policy := mustPolicy(t, map[string]string{instanceOne: "owner-a@example.test"})
	controller, err := NewController(testPlatform(), inventory, agents, policy, ControllerOptions{
		Clock: func() time.Time { return clockNow },
	})
	if err != nil {
		t.Fatalf("NewController() error = %v", err)
	}

	good := controller.Refresh(context.Background())
	clockNow = second
	stale := controller.Refresh(context.Background())
	if good.Platforms[0].Inventory.Status != InventoryAvailable {
		t.Fatalf("first inventory status = %q", good.Platforms[0].Inventory.Status)
	}
	platform := stale.Platforms[0]
	if stale.Sequence != 2 || platform.Inventory.Status != InventoryStale {
		t.Fatalf("stale state = sequence %d status %q", stale.Sequence, platform.Inventory.Status)
	}
	if len(platform.Instances) != 1 || platform.Instances[0].Agent.Snapshot == nil {
		t.Fatal("stale state did not preserve last good instance snapshot")
	}
	if platform.Instances[0].Agent.Status != AgentStale {
		t.Fatalf("preserved agent status = %q, want %q", platform.Instances[0].Agent.Status, AgentStale)
	}
	if got := len(agents.calledUUIDs()); got != 1 {
		t.Fatalf("agent calls = %d, want no call after inventory failure", got)
	}
	encoded, _ := json.Marshal(stale)
	if strings.Contains(string(encoded), secretCanary) {
		t.Fatalf("stale state leaked inventory error: %s", encoded)
	}
}

func TestControllerInitialInventoryFailureIsUnavailable(t *testing.T) {
	now := time.Date(2026, time.August, 30, 18, 20, 0, 0, time.UTC)
	inventory := &scriptedInventory{results: []inventoryResult{{err: errors.New("unavailable")}}}
	agents := &scriptedAgent{samples: map[string]AgentSample{}, errors: map[string]error{}}
	state := mustController(t, inventory, agents, Policy{}, now).Refresh(context.Background())
	platform := state.Platforms[0]
	if platform.Inventory.Status != InventoryUnavailable || len(platform.Instances) != 0 {
		t.Fatalf("initial failed inventory = status %q instances %d", platform.Inventory.Status, len(platform.Instances))
	}
}

func TestControllerRepeatedFailuresWithoutSuccessRemainUnavailable(t *testing.T) {
	now := time.Date(2026, time.August, 30, 18, 25, 0, 0, time.UTC)
	inventory := &scriptedInventory{results: []inventoryResult{{err: errors.New("unavailable")}}}
	agents := &scriptedAgent{samples: map[string]AgentSample{}, errors: map[string]error{}}
	controller := mustController(t, inventory, agents, Policy{}, now)
	controller.Refresh(context.Background())
	second := controller.Refresh(context.Background())
	platform := second.Platforms[0]
	if platform.Inventory.Status != InventoryUnavailable || platform.Inventory.LastSuccessAt != nil {
		t.Fatalf("repeated failed inventory = status %q lastSuccess %v", platform.Inventory.Status, platform.Inventory.LastSuccessAt)
	}
	if platform.Instances == nil || len(platform.Instances) != 0 {
		t.Fatalf("failed inventory instances = %#v, want stable empty array", platform.Instances)
	}
}

func TestControllerRejectsMalformedOrDuplicateInventoryWithoutAgentCalls(t *testing.T) {
	now := time.Date(2026, time.August, 30, 18, 27, 0, 0, time.UTC)
	tests := []struct {
		name      string
		instances []Instance
	}{
		{
			name:      "invalid UUID",
			instances: []Instance{{UUID: "not-a-uuid", Name: "Alpha", CreatorUsername: "owner-a@example.test", CloudState: CloudStateActive}},
		},
		{
			name: "duplicate UUID with conflicting creator",
			instances: []Instance{
				{UUID: instanceOne, Name: "Alpha", CreatorUsername: "owner-a@example.test", CloudState: CloudStateActive},
				{UUID: instanceOne, Name: "Alpha", CreatorUsername: "attacker@example.test", CloudState: CloudStateActive},
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			inventory := &scriptedInventory{results: []inventoryResult{{observation: InventoryObservation{ObservedAt: now, Instances: test.instances}}}}
			agents := &scriptedAgent{samples: map[string]AgentSample{instanceOne: sampleAt(now, "agent-host", instanceOne)}, errors: map[string]error{}}
			policy := mustPolicy(t, map[string]string{instanceOne: "owner-a@example.test"})
			state := mustController(t, inventory, agents, policy, now).Refresh(context.Background())
			if state.Platforms[0].Inventory.Status != InventoryUnavailable {
				t.Fatalf("invalid inventory status = %q", state.Platforms[0].Inventory.Status)
			}
			if got := agents.calledUUIDs(); len(got) != 0 {
				t.Fatalf("agent calls for invalid inventory = %v, want none", got)
			}
		})
	}
}

func TestControllerMarksOldAndIncompatibleAgentSnapshots(t *testing.T) {
	now := time.Date(2026, time.August, 30, 18, 30, 0, 0, time.UTC)
	inventory := &scriptedInventory{
		results: []inventoryResult{
			{observation: InventoryObservation{
				ObservedAt: now,
				Instances: []Instance{
					{UUID: instanceOne, Name: "Alpha", CreatorUsername: "owner-a@example.test", CloudState: CloudStateActive},
					{UUID: instanceTwo, Name: "Bravo", CreatorUsername: "owner-b@example.test", CloudState: CloudStateActive},
				},
			}},
		},
	}
	old := sampleAt(now.Add(-time.Minute), "old-host", instanceOne)
	incompatible := sampleAt(now, "future-host", instanceTwo)
	incompatible.Snapshot.SchemaVersion = "v2"
	agents := &scriptedAgent{samples: map[string]AgentSample{instanceOne: old, instanceTwo: incompatible}, errors: map[string]error{}}
	policy := mustPolicy(t, map[string]string{instanceOne: "owner-a@example.test", instanceTwo: "owner-b@example.test"})
	state := mustController(t, inventory, agents, policy, now).Refresh(context.Background())

	if state.Platforms[0].Instances[0].Agent.Status != AgentStale {
		t.Fatalf("old agent status = %q", state.Platforms[0].Instances[0].Agent.Status)
	}
	incompatibleObservation := state.Platforms[0].Instances[1].Agent
	if incompatibleObservation.Status != AgentIncompatible || incompatibleObservation.Snapshot != nil {
		t.Fatalf("incompatible observation = %+v", incompatibleObservation)
	}
}

func TestControllerRejectsAgentSampleBoundToAnotherInstance(t *testing.T) {
	now := time.Date(2026, time.August, 30, 18, 35, 0, 0, time.UTC)
	inventory := &scriptedInventory{results: []inventoryResult{{observation: InventoryObservation{
		ObservedAt: now,
		Instances:  []Instance{{UUID: instanceOne, Name: "Alpha", CreatorUsername: "owner-a@example.test", CloudState: CloudStateActive}},
	}}}}
	agents := &scriptedAgent{samples: map[string]AgentSample{instanceOne: sampleAt(now, "wrong-host", instanceTwo)}, errors: map[string]error{}}
	policy := mustPolicy(t, map[string]string{instanceOne: "owner-a@example.test"})
	state := mustController(t, inventory, agents, policy, now).Refresh(context.Background())
	agent := state.Platforms[0].Instances[0].Agent
	if agent.Status != AgentIncompatible || agent.Snapshot != nil {
		t.Fatalf("cross-instance sample was accepted: %+v", agent)
	}
}

func TestControllerAgentTimeoutBoundsNonCompliantSource(t *testing.T) {
	now := time.Date(2026, time.August, 30, 18, 37, 0, 0, time.UTC)
	inventory := &scriptedInventory{results: []inventoryResult{{observation: InventoryObservation{
		ObservedAt: now,
		Instances:  []Instance{{UUID: instanceOne, Name: "Alpha", CreatorUsername: "owner-a@example.test", CloudState: CloudStateActive}},
	}}}}
	agents := blockingAgent{release: make(chan struct{})}
	policy := mustPolicy(t, map[string]string{instanceOne: "owner-a@example.test"})
	controller, err := NewController(testPlatform(), inventory, agents, policy, ControllerOptions{
		Clock:        func() time.Time { return now },
		AgentTimeout: 20 * time.Millisecond,
	})
	if err != nil {
		t.Fatalf("NewController() error = %v", err)
	}
	started := time.Now()
	state := controller.Refresh(context.Background())
	close(agents.release)
	if elapsed := time.Since(started); elapsed > 500*time.Millisecond {
		t.Fatalf("Refresh() took %s despite agent timeout", elapsed)
	}
	if state.Platforms[0].Instances[0].Agent.Status != AgentUnreachable {
		t.Fatalf("timed out agent status = %q", state.Platforms[0].Instances[0].Agent.Status)
	}
}

func TestControllerKeepsTimedOutAgentCallsGloballyBounded(t *testing.T) {
	now := time.Date(2026, time.August, 30, 18, 38, 0, 0, time.UTC)
	instances := []Instance{
		{UUID: instanceOne, Name: "Alpha", CreatorUsername: "owner-a@example.test", CloudState: CloudStateActive},
		{UUID: instanceTwo, Name: "Bravo", CreatorUsername: "owner-b@example.test", CloudState: CloudStateActive},
		{UUID: instanceThree, Name: "Charlie", CreatorUsername: "owner-c@example.test", CloudState: CloudStateActive},
	}
	inventory := &scriptedInventory{results: []inventoryResult{{observation: InventoryObservation{ObservedAt: now, Instances: instances}}}}
	agents := &countingBlockingAgent{release: make(chan struct{})}
	policy := mustPolicy(t, map[string]string{
		instanceOne: "owner-a@example.test", instanceTwo: "owner-b@example.test", instanceThree: "owner-c@example.test",
	})
	controller, err := NewController(testPlatform(), inventory, agents, policy, ControllerOptions{
		Clock:               func() time.Time { return now },
		AgentTimeout:        20 * time.Millisecond,
		MaxConcurrentAgents: 2,
	})
	if err != nil {
		t.Fatalf("NewController() error = %v", err)
	}
	controller.Refresh(context.Background())
	controller.Refresh(context.Background())
	controller.Refresh(context.Background())
	if max := agents.maxActive.Load(); max > 2 {
		t.Fatalf("actual concurrent Observe calls = %d, want at most 2", max)
	}
	if calls := agents.calls.Load(); calls != 2 {
		t.Fatalf("non-compliant Observe calls = %d, want exactly the two retained slots", calls)
	}
	close(agents.release)
}

func TestControllerSerializesRefreshes(t *testing.T) {
	now := time.Date(2026, time.August, 30, 18, 40, 0, 0, time.UTC)
	inventory := &blockingInventory{entered: make(chan struct{}, 2), release: make(chan struct{})}
	agents := &scriptedAgent{samples: map[string]AgentSample{}, errors: map[string]error{}}
	controller := mustController(t, inventory, agents, Policy{}, now)
	done := make(chan struct{}, 2)
	go func() { controller.Refresh(context.Background()); done <- struct{}{} }()
	<-inventory.entered
	go func() { controller.Refresh(context.Background()); done <- struct{}{} }()

	select {
	case <-inventory.entered:
		t.Fatal("second inventory refresh overlapped the first")
	case <-time.After(50 * time.Millisecond):
	}
	inventory.release <- struct{}{}
	<-inventory.entered
	inventory.release <- struct{}{}
	<-done
	<-done
	if max := inventory.maxActive.Load(); max != 1 {
		t.Fatalf("max concurrent inventory calls = %d, want 1", max)
	}
}

func TestControllerSlowSubscriberReceivesLatestCompleteState(t *testing.T) {
	now := time.Date(2026, time.August, 30, 18, 50, 0, 0, time.UTC)
	inventory := &scriptedInventory{results: []inventoryResult{{observation: InventoryObservation{ObservedAt: now}}}}
	agents := &scriptedAgent{samples: map[string]AgentSample{}, errors: map[string]error{}}
	controller := mustController(t, inventory, agents, Policy{}, now)
	updates, unsubscribe := controller.Subscribe()
	defer unsubscribe()
	controller.Refresh(context.Background())
	controller.Refresh(context.Background())
	controller.Refresh(context.Background())

	select {
	case update := <-updates:
		if update.Sequence != 3 || len(update.Platforms) != 1 {
			t.Fatalf("subscriber update = sequence %d platforms %d", update.Sequence, len(update.Platforms))
		}
	case <-time.After(time.Second):
		t.Fatal("subscriber did not receive fleet state")
	}
}

func TestControllerSnapshotOwnershipIsIsolated(t *testing.T) {
	now := time.Date(2026, time.August, 30, 18, 55, 0, 0, time.UTC)
	sample := sampleAt(now, "agent-host", instanceOne)
	metricValue := 42.0
	sample.Snapshot.Processes = []model.Process{{PID: 7, User: "researcher", CommandLine: "--token=" + secretCanary, Message: secretCanary}}
	sample.Snapshot.Diagnostics = []model.Diagnostic{{Code: "test", Summary: "safe summary", Detail: secretCanary}}
	sample.Snapshot.Capabilities.DCGM.Message = secretCanary
	sample.Snapshot.GPUs = []model.GPU{{
		UUID: "GPU-test",
		Metrics: model.MetricSet{"utilization": {
			Value: &metricValue, Unit: "percent", Status: model.StatusAvailable, Message: secretCanary,
		}},
	}}
	inventory := &scriptedInventory{results: []inventoryResult{{observation: InventoryObservation{
		ObservedAt: now,
		Instances:  []Instance{{UUID: instanceOne, Name: "Alpha", CreatorUsername: "owner-a@example.test", CloudState: CloudStateActive}},
	}}}}
	agents := &scriptedAgent{samples: map[string]AgentSample{instanceOne: sample}, errors: map[string]error{}}
	policy := mustPolicy(t, map[string]string{instanceOne: "owner-a@example.test"})
	controller := mustController(t, inventory, agents, policy, now)
	returned := controller.Refresh(context.Background())
	encoded, err := json.Marshal(returned)
	if err != nil {
		t.Fatalf("json.Marshal() error = %v", err)
	}
	if strings.Contains(string(encoded), secretCanary) {
		t.Fatalf("fleet projection leaked agent free-form secret: %s", encoded)
	}

	*sample.Snapshot.GPUs[0].Metrics["utilization"].Value = 99
	returned.Platforms[0].Instances[0].Agent.Snapshot.Host.Hostname = "mutated-consumer"
	returned.Platforms[0].Instances[0].Agent.Snapshot.GPUs[0].Metrics["utilization"] = model.Metric{Value: model.Float(7)}
	current, ok := controller.Current()
	if !ok {
		t.Fatal("Current() reported no state")
	}
	nested := current.Platforms[0].Instances[0].Agent.Snapshot
	if nested.Host.Hostname != "agent-host" || *nested.GPUs[0].Metrics["utilization"].Value != 42 {
		t.Fatalf("controller state was mutated through an alias: %+v", nested)
	}
	current.Platforms[0].Instances[0].Agent.Snapshot.Host.Hostname = "mutated-current"
	again, _ := controller.Current()
	if again.Platforms[0].Instances[0].Agent.Snapshot.Host.Hostname != "agent-host" {
		t.Fatal("Current() returned a mutable alias")
	}
}

func TestControllerCancelledQueuedRefreshDoesNotPublish(t *testing.T) {
	now := time.Date(2026, time.August, 30, 19, 0, 0, 0, time.UTC)
	inventory := &blockingInventory{entered: make(chan struct{}, 1), release: make(chan struct{})}
	agents := &scriptedAgent{samples: map[string]AgentSample{}, errors: map[string]error{}}
	controller := mustController(t, inventory, agents, Policy{}, now)
	firstDone := make(chan struct{})
	go func() { controller.Refresh(context.Background()); close(firstDone) }()
	<-inventory.entered
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	queued := controller.Refresh(cancelled)
	if queued.Sequence != 0 {
		t.Fatalf("cancelled queued refresh returned sequence %d, want no published state", queued.Sequence)
	}
	inventory.release <- struct{}{}
	<-firstDone
	current, _ := controller.Current()
	if current.Sequence != 1 {
		t.Fatalf("cancelled refresh changed sequence to %d", current.Sequence)
	}
}

func TestNewControllerValidatesPlatformBoundary(t *testing.T) {
	inventory := &scriptedInventory{results: []inventoryResult{{observation: InventoryObservation{}}}}
	agents := &scriptedAgent{samples: map[string]AgentSample{}, errors: map[string]error{}}
	tests := []Platform{
		{ID: "Jetstream", DisplayName: "Jetstream", Kind: PlatformKindOpenStack},
		{ID: "jetstream", DisplayName: " Jetstream", Kind: PlatformKindOpenStack},
		{ID: "jetstream", DisplayName: "Jetstream", Kind: "cloud"},
		{ID: "nidhogg", DisplayName: "Nidhogg", Kind: PlatformKindHost},
		{ID: "jetstream", DisplayName: "Jetstream", Kind: PlatformKindOpenStack, DashboardURL: "http://example.test"},
		{ID: "jetstream", DisplayName: "Jetstream", Kind: PlatformKindOpenStack, DashboardURL: "https://example.test/?token=secret"},
		{ID: "jetstream", DisplayName: "Jetstream", Kind: PlatformKindOpenStack, DashboardURL: "//example.test/fleet"},
	}
	for _, platform := range tests {
		if _, err := NewController(platform, inventory, agents, Policy{}, ControllerOptions{}); err == nil {
			t.Errorf("NewController(%+v) error = nil, want rejection", platform)
		}
	}
	valid := testPlatform()
	valid.DashboardURL = "https://example.test/fleet"
	if _, err := NewController(valid, inventory, agents, Policy{}, ControllerOptions{}); err != nil {
		t.Fatalf("NewController(valid) error = %v", err)
	}
}

type blockingInventory struct {
	entered   chan struct{}
	release   chan struct{}
	active    atomic.Int32
	maxActive atomic.Int32
}

type blockingAgent struct {
	release chan struct{}
}

func (source blockingAgent) Observe(context.Context, Instance) (AgentSample, error) {
	<-source.release
	return AgentSample{}, errors.New("released")
}

type countingBlockingAgent struct {
	release   chan struct{}
	calls     atomic.Int32
	active    atomic.Int32
	maxActive atomic.Int32
}

func (source *countingBlockingAgent) Observe(context.Context, Instance) (AgentSample, error) {
	source.calls.Add(1)
	active := source.active.Add(1)
	for {
		max := source.maxActive.Load()
		if active <= max || source.maxActive.CompareAndSwap(max, active) {
			break
		}
	}
	<-source.release
	source.active.Add(-1)
	return AgentSample{}, errors.New("released")
}

func (source *blockingInventory) List(context.Context) (InventoryObservation, error) {
	active := source.active.Add(1)
	for {
		max := source.maxActive.Load()
		if active <= max || source.maxActive.CompareAndSwap(max, active) {
			break
		}
	}
	source.entered <- struct{}{}
	<-source.release
	source.active.Add(-1)
	return InventoryObservation{}, nil
}

func sampleAt(at time.Time, hostname, instanceUUID string) AgentSample {
	return AgentSample{
		InstanceUUID: instanceUUID,
		ObservedAt:   at,
		BuildInfo:    &model.BuildInfo{Version: "v0.2.0", Commit: "test", BuildDate: "2026-08-30"},
		Snapshot: model.Snapshot{
			SchemaVersion: "v1",
			Sequence:      7,
			SampledAt:     at,
			Host:          model.Host{Hostname: hostname, OS: "linux", Arch: "amd64"},
			GPUs:          []model.GPU{},
			Processes:     []model.Process{},
			Diagnostics:   []model.Diagnostic{},
		},
	}
}

func mustPolicy(t *testing.T, entries map[string]string) Policy {
	t.Helper()
	identities := make(map[string]AllowedIdentity, len(entries))
	for instanceUUID, creator := range entries {
		identities[instanceUUID] = AllowedIdentity{CreatorID: creator, CreatorUsername: creator, AgentConfigured: true}
	}
	policy, err := NewPolicy(identities)
	if err != nil {
		t.Fatalf("NewPolicy() error = %v", err)
	}
	return policy
}

func mustController(t *testing.T, inventory InventorySource, agents AgentSource, policy Policy, now time.Time) *Controller {
	t.Helper()
	controller, err := NewController(testPlatform(), inventory, agents, policy, ControllerOptions{Clock: func() time.Time { return now }})
	if err != nil {
		t.Fatalf("NewController() error = %v", err)
	}
	return controller
}

func testPlatform() Platform {
	return Platform{ID: "jetstream", DisplayName: "Jetstream", Kind: PlatformKindOpenStack}
}

func assertObservation(t *testing.T, observation InstanceObservation, managed, eligible bool, reason PolicyReason, status AgentStatus) {
	t.Helper()
	if observation.Managed != managed || observation.AgentProbeEligible != eligible || observation.PolicyReason != reason || observation.Agent.Status != status {
		t.Fatalf("observation = managed %v eligible %v reason %q status %q; want %v %v %q %q", observation.Managed, observation.AgentProbeEligible, observation.PolicyReason, observation.Agent.Status, managed, eligible, reason, status)
	}
}
