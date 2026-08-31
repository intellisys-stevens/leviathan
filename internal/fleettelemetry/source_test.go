package fleettelemetry

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/intellisys-stevens/leviathan/internal/fleet"
	"github.com/intellisys-stevens/leviathan/internal/model"
)

const (
	testProject = "project-a"
	testUUID    = "11111111-1111-4111-8111-111111111111"
	testOther   = "22222222-2222-4222-8222-222222222222"
)

type stubAgent struct {
	source fleet.TelemetrySource
	err    error
	calls  int
}

func (agent *stubAgent) Observe(_ context.Context, instance fleet.Instance) (fleet.AgentSample, error) {
	agent.calls++
	return fleet.AgentSample{InstanceUUID: instance.UUID, Source: agent.source, Snapshot: model.Snapshot{SchemaVersion: "v1"}}, agent.err
}

type stubRegistry struct {
	sample fleet.AgentSample
	ok     bool
	calls  int
}

func (registry *stubRegistry) Get(projectID, instanceUUID string, _ time.Time) (fleet.AgentSample, bool) {
	registry.calls++
	if projectID != testProject || instanceUUID == "" {
		return fleet.AgentSample{}, false
	}
	return registry.sample, registry.ok
}

func TestExactBindingIsAuthoritative(t *testing.T) {
	exactErr := errors.New("exact failed")
	exact := &stubAgent{source: fleet.TelemetrySourceLeviathanAgent, err: exactErr}
	console := &stubAgent{source: fleet.TelemetrySourceExosphereConsole}
	registry := &stubRegistry{ok: true, sample: fleet.AgentSample{Source: fleet.TelemetrySourceLeviathanUplink}}
	source, err := New(Options{
		ProjectID:          testProject,
		Uplink:             registry,
		Exact:              exact,
		Console:            console,
		ExactInstanceUUIDs: []string{testUUID},
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = source.Observe(context.Background(), fleet.Instance{UUID: testUUID})
	if !errors.Is(err, exactErr) || exact.calls != 1 || registry.calls != 0 || console.calls != 0 {
		t.Fatalf("exact precedence: err=%v exact=%d uplink=%d console=%d", err, exact.calls, registry.calls, console.calls)
	}
}

func TestDynamicInstanceUsesFreshUplinkThenConsole(t *testing.T) {
	console := &stubAgent{source: fleet.TelemetrySourceExosphereConsole}
	registry := &stubRegistry{ok: true, sample: fleet.AgentSample{InstanceUUID: testOther, Source: fleet.TelemetrySourceLeviathanUplink}}
	source, err := New(Options{ProjectID: testProject, Uplink: registry, Console: console})
	if err != nil {
		t.Fatal(err)
	}
	sample, err := source.Observe(context.Background(), fleet.Instance{UUID: testOther})
	if err != nil || sample.Source != fleet.TelemetrySourceLeviathanUplink || console.calls != 0 {
		t.Fatalf("uplink result=%+v err=%v console calls=%d", sample, err, console.calls)
	}

	registry.ok = false
	sample, err = source.Observe(context.Background(), fleet.Instance{UUID: testOther})
	if err != nil || sample.Source != fleet.TelemetrySourceExosphereConsole || console.calls != 1 {
		t.Fatalf("console result=%+v err=%v console calls=%d", sample, err, console.calls)
	}
}

func TestSourceRejectsInvalidConfigurationAndHonorsCancellation(t *testing.T) {
	for _, options := range []Options{
		{},
		{Uplink: &stubRegistry{}},
		{ExactInstanceUUIDs: []string{testUUID}, Console: &stubAgent{}},
		{Exact: &stubAgent{}, ExactInstanceUUIDs: []string{"not-a-uuid"}},
		{Exact: &stubAgent{}, ExactInstanceUUIDs: []string{testUUID, testUUID}},
	} {
		if _, err := New(options); !errors.Is(err, ErrInvalidConfiguration) {
			t.Fatalf("New(%+v) error=%v", options, err)
		}
	}
	source, err := New(Options{Console: &stubAgent{}})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := source.Observe(ctx, fleet.Instance{UUID: testUUID}); !errors.Is(err, context.Canceled) {
		t.Fatalf("Observe canceled error=%v", err)
	}
}
