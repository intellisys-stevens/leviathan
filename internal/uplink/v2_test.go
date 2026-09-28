package uplink

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/intellisys-stevens/leviathan/model"
)

func TestV2ProjectionGoldenAndHardwareIndependentFixture(t *testing.T) {
	body, err := os.ReadFile("testdata/uplink-v1.golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var v1 Envelope
	if err = json.Unmarshal(body, &v1); err != nil {
		t.Fatal(err)
	}
	wantBody, err := os.ReadFile("testdata/uplink-v2.golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var want EnvelopeV2
	if err = json.Unmarshal(wantBody, &want); err != nil {
		t.Fatal(err)
	}
	got := ToV2(v1)
	if !reflect.DeepEqual(got, want) {
		t.Fatal("v2 wire projection drifted from golden")
	}
	amdBody, _ := os.ReadFile("testdata/uplink-v2-amd.golden.json")
	var amd EnvelopeV2
	if err = json.Unmarshal(amdBody, &amd); err != nil {
		t.Fatal(err)
	}
	if amd.Accelerators[0].Vendor != "amd" || amd.Accelerators[0].Memory.Source != "rocm" {
		t.Fatal("non-NVIDIA source not representable")
	}
	v1.GPUs = []GPU{}
	cpuOnly := ToV2(v1)
	if len(cpuOnly.Accelerators) != 0 || len(cpuOnly.Capabilities) != 2 {
		t.Fatal("CPU-only projection invented GPU capabilities")
	}
	v1.Health.GPU.Status = HealthUnavailable
	unknown := ToV2(v1)
	if unknown.Capabilities[1].Status != "unavailable" {
		t.Fatal("missing GPU telemetry claimed a complete empty inventory")
	}
}

func TestV2ClientSendsPortableEnvelopeAndChecksReceipt(t *testing.T) {
	envelope := testEnvelope(t)
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != EndpointPathV2 || r.Header.Get("Authorization") != "Bearer "+testMachineToken() {
			t.Error("wrong transport contract")
			w.WriteHeader(400)
			return
		}
		var raw map[string]json.RawMessage
		if err := json.NewDecoder(r.Body).Decode(&raw); err != nil {
			t.Error(err)
			w.WriteHeader(400)
			return
		}
		if _, exists := raw["gpus"]; exists {
			t.Error("v1 GPU field leaked into v2")
		}
		if _, exists := raw["accelerators"]; !exists {
			t.Error("missing accelerators")
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(Receipt{Status: "accepted", StreamID: envelope.StreamID, Sequence: envelope.Sequence})
	}))
	defer server.Close()
	client, err := NewClient(server.URL, TokenSourceFunc(func(context.Context) (string, error) { return testMachineToken(), nil }), ClientOptions{Schema: SchemaV2, HTTPClient: server.Client()})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = client.Send(context.Background(), envelope); err != nil {
		t.Fatal(err)
	}
}

func portableProjectionSnapshot() model.Snapshot {
	snapshot := projectionSnapshot()
	const custom model.MetricSource = "example_fixture"
	snapshot.System.CPU.Source = custom
	snapshot.System.Memory.Source = custom
	snapshot.System.Storage.Source = custom
	for _, metric := range []*model.Metric{&snapshot.System.CPU.Utilization, &snapshot.System.CPU.Load1, &snapshot.System.CPU.Load5, &snapshot.System.CPU.Load15, &snapshot.System.Memory.Utilization, &snapshot.System.Storage.ReadBytesPerSecond, &snapshot.System.Storage.WriteBytesPerSecond} {
		metric.Source = custom
	}
	snapshot.System.Storage.Filesystems[0].Source = custom
	gpu := &snapshot.GPUs[0]
	gpu.UUID = "example/GPU-a"
	gpu.Memory.Source = custom
	gpu.Metrics = model.MetricSet{"custom_counter": model.AvailableMetric(17, "widgets", custom, model.ScopePhysicalGPU, snapshot.SampledAt)}
	gi := &gpu.GPUInstances[0]
	gi.UUID = "example/GI-a"
	gi.Memory.Source = custom
	gi.Metrics = model.MetricSet{"custom_usage": model.AvailableMetric(3, "cores", custom, model.ScopeGPUInstance, snapshot.SampledAt)}
	ci := &gi.ComputeInstances[0]
	ci.UUID = "example/CI-a"
	ci.Memory.Source = custom
	ci.Metrics = model.MetricSet{"custom_usage": model.AvailableMetric(2, "cores", custom, model.ScopeComputeInstance, snapshot.SampledAt)}
	return snapshot
}

func TestConfiguredV2RunnerPreservesPortablePluginObservations(t *testing.T) {
	snapshot := portableProjectionSnapshot()
	if _, err := Project(snapshot, model.BuildInfo{}, testStreamID, 1); !errors.Is(err, ErrUnsupportedObservation) {
		t.Fatalf("v1 must retain its locked host provenance: %v", err)
	}
	received := make(chan EnvelopeV2, 1)
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != EndpointPathV2 {
			t.Error("runner used wrong wire version")
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		var envelope EnvelopeV2
		if err := json.NewDecoder(r.Body).Decode(&envelope); err != nil {
			t.Error(err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		received <- envelope
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(Receipt{Status: "accepted", StreamID: envelope.StreamID, Sequence: envelope.Sequence})
	}))
	defer server.Close()
	source := &fakeSnapshotSource{snapshots: make(chan model.Snapshot, 1)}
	source.snapshots <- snapshot
	attempts := make(chan AttemptResult, 1)
	runner, err := NewConfiguredRunner(Configuration{Enabled: true, Schema: SchemaV2, BaseURL: server.URL, TokenFile: writeTestToken(t, 0600), Interval: time.Second}, source, model.BuildInfo{}, func(result AttemptResult) { attempts <- result })
	if err != nil {
		t.Fatal(err)
	}
	// Trust only this test server's certificate; production client construction
	// and schema selection still pass through NewConfiguredRunner.
	runner.sender.(*Client).httpClient.Transport = server.Client().Transport
	created := make(chan *fakeRunnerTimer, 1)
	runner.newTimer = func(delay time.Duration) runnerTimer {
		timer := &fakeRunnerTimer{channel: make(chan time.Time, 1), resets: make(chan time.Duration, 1), initial: delay}
		created <- timer
		return timer
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- runner.Run(ctx) }()
	receive(t, created).Fire()
	result := receive(t, attempts)
	if !result.Succeeded {
		t.Fatalf("configured v2 runner rejected portable snapshot: %v", result.Err)
	}
	got := receive(t, received)
	if got.System.CPU.Source != "example_fixture" || got.System.CPU.Utilization.Source != "example_fixture" || got.System.Storage.Filesystems[0].Source != "example_fixture" {
		t.Fatal("custom host provenance was changed")
	}
	if len(got.Accelerators) != 1 || got.Accelerators[0].Vendor != "unknown" || got.Accelerators[0].ID != "example/GPU-a" || len(got.Accelerators[0].Partitions) != 2 {
		t.Fatalf("portable hierarchy changed: %+v", got.Accelerators)
	}
	device := got.Accelerators[0]
	if device.Memory.Source != "example_fixture" || device.Metrics["custom_counter"].Source != "example_fixture" || device.Metrics["custom_counter"].Unit != "widgets" || *device.Metrics["custom_counter"].Value != 17 {
		t.Fatalf("portable metric changed: %+v", device.Metrics)
	}
	for index, scope := range []model.MetricScope{model.ScopeGPUInstance, model.ScopeComputeInstance} {
		partition := device.Partitions[index]
		if partition.Memory.Scope != string(scope) || partition.Metrics["custom_usage"].Scope != string(scope) || !partition.Memory.SampledAt.Equal(snapshot.SampledAt) {
			t.Fatalf("partition provenance changed: %+v", partition)
		}
	}
	body, _ := json.Marshal(got)
	for _, private := range []string{"process-user-canary", "command-line-canary", "attribution-canary", "pci-bus-canary", "diagnostic-detail-canary", "metric-message-canary", "generation-canary"} {
		if strings.Contains(string(body), private) {
			t.Fatalf("private field crossed v2 boundary: %s", private)
		}
	}
	cancel()
	if err = receive(t, done); err != nil {
		t.Fatal(err)
	}
}

func TestPortableProjectionBoundsAndUnsetMetrics(t *testing.T) {
	snapshot := portableProjectionSnapshot()
	gpu := snapshot.GPUs[0]
	snapshot.GPUs = nil
	for index := 0; index < 65; index++ {
		copy := gpu
		copy.UUID = fmt.Sprintf("GPU-%d", index)
		copy.GPUInstances = nil
		snapshot.GPUs = append(snapshot.GPUs, copy)
	}
	// The v2 receiver bounds the combined partition and GPU metric counts.
	for index := 0; index < 4097; index++ {
		gi := gpu.GPUInstances[0]
		gi.UUID = fmt.Sprintf("GI-%d", index)
		gi.ComputeInstances = nil
		gi.Metrics = model.MetricSet{}
		for metric := 0; metric < 9; metric++ {
			gi.Metrics[fmt.Sprintf("counter_%d", metric)] = gpu.Metrics["custom_counter"]
		}
		snapshot.GPUs[0].GPUInstances = append(snapshot.GPUs[0].GPUInstances, gi)
	}
	envelope, err := project(snapshot, model.BuildInfo{}, testStreamID, 1, projectionPolicy{portable: true})
	if err != nil {
		t.Fatal(err)
	}
	wire := ToV2(envelope)
	count := 0
	for _, device := range wire.Accelerators {
		if metric, ok := device.Metrics["custom_counter"]; !ok || metric.Value == nil || *metric.Value != 17 {
			t.Fatalf("partition budget discarded physical-device evidence for %s", device.ID)
		}
		count += len(device.Metrics)
		for _, partition := range device.Partitions {
			count += len(partition.Metrics)
		}
	}
	if len(wire.Accelerators) != 64 || len(wire.Accelerators[0].Partitions) != 4096 || count != 32768 {
		t.Fatalf("v2 bounds: devices=%d partitions=%d metrics=%d", len(wire.Accelerators), len(wire.Accelerators[0].Partitions), count)
	}
	encoded, err := json.Marshal(wire)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("64 GPUs, 4096 partitions and 32768 metrics encode to %d bytes (transport maximum %d)", len(encoded), MaxRequestBytes)
	policy := projectionPolicy{portable: true}
	metrics := model.MetricSet{"valid": gpu.Metrics["custom_counter"]}
	for _, test := range []struct{ field, value string }{{"source", ""}, {"source", strings.Repeat("s", 129)}, {"scope", "bad\nidentifier"}, {"unit", strings.Repeat("u", 65)}} {
		metric := gpu.Metrics["custom_counter"]
		switch test.field {
		case "source":
			metric.Source = model.MetricSource(test.value)
		case "scope":
			metric.Scope = model.MetricScope(test.value)
		case "unit":
			metric.Unit = test.value
		}
		metrics[test.field+test.value] = metric
	}
	metrics[strings.Repeat("n", 129)] = gpu.Metrics["custom_counter"]
	if got := policy.projectMetricSet(metrics); len(got) != 1 || got["valid"].Source != "example_fixture" {
		t.Fatal("invalid provenance was retained or valid custom provenance was discarded")
	}
	unset := model.NormalizeSnapshot(model.Snapshot{}).System.CPU.Utilization
	projected := policy.projectMetric(unset)
	if projected.Value != nil || projected.Status != MetricStatus(model.StatusUnsupported) || projected.Source != "unknown" || !projected.SampledAt.IsZero() {
		t.Fatalf("unset metric became a measurement: %+v", projected)
	}
}

func TestPortableProjectionOmitsEmptyResourceIdentities(t *testing.T) {
	for _, kind := range []string{"gpu", "instance", "compute"} {
		t.Run(kind, func(t *testing.T) {
			snapshot := portableProjectionSnapshot()
			switch kind {
			case "gpu":
				snapshot.GPUs[0].UUID = ""
			case "instance":
				snapshot.GPUs[0].GPUInstances[0].UUID = ""
			case "compute":
				snapshot.GPUs[0].GPUInstances[0].ComputeInstances[0].UUID = ""
			}
			envelope, err := project(snapshot, model.BuildInfo{}, testStreamID, 1, projectionPolicy{portable: true})
			if err != nil {
				t.Fatal(err)
			}
			wire := ToV2(envelope)
			if kind == "gpu" {
				if len(wire.Accelerators) != 0 {
					t.Fatal("empty GPU identity retained")
				}
				return
			}
			want := map[string]int{"instance": 0, "compute": 1}[kind]
			if len(wire.Accelerators[0].Partitions) != want {
				t.Fatal("empty partition or orphan child retained")
			}
		})
	}
}

func TestV2ClientEnforcesEncodedRequestLimitBeforeNetwork(t *testing.T) {
	envelope, err := project(portableProjectionSnapshot(), model.BuildInfo{}, testStreamID, 1, projectionPolicy{portable: true})
	if err != nil {
		t.Fatal(err)
	}
	body, err := json.Marshal(ToV2(envelope))
	if err != nil {
		t.Fatal(err)
	}
	calls := 0
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(Receipt{Status: "accepted", StreamID: envelope.StreamID, Sequence: envelope.Sequence})
	}))
	defer server.Close()
	for _, delta := range []int{0, -1} {
		client, err := NewClient(server.URL, staticTokenSource(testMachineToken()), ClientOptions{Schema: SchemaV2, HTTPClient: server.Client(), RequestLimit: int64(len(body) + delta)})
		if err != nil {
			t.Fatal(err)
		}
		_, err = client.Send(context.Background(), envelope)
		if (delta == 0 && err != nil) || (delta == -1 && !errors.Is(err, ErrRequestTooLarge)) {
			t.Fatalf("encoded v2 request boundary %d: %v", delta, err)
		}
	}
	if calls != 1 {
		t.Fatalf("oversized request reached network: %d calls", calls)
	}
}
