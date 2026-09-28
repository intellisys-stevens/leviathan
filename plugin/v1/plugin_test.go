package v1

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/intellisys-stevens/leviathan/model"
)

func gpuObservation(at time.Time) Observation {
	return Observation{Capability: GPU, InstanceID: "external", SessionID: "first", Revision: 1, ObservedAt: at, Status: "available", GPU: &GPUData{GPUs: []model.GPU{{UUID: "GPU-1", Metrics: model.MetricSet{"gpu_activity": model.AvailableMetric(25, "percent", "example.sensor", model.ScopePhysicalGPU, at)}}}}}
}

func TestObservationRejectsMalformedDataAndKeepsCustomSource(t *testing.T) {
	now := time.Now().UTC()
	if err := gpuObservation(now).ValidateAt(now); err != nil {
		t.Fatal(err)
	}
	cases := map[string]func(*Observation){
		"two payloads":       func(o *Observation) { o.Host = &HostData{} },
		"wrong capability":   func(o *Observation) { o.Capability = Host },
		"empty resource":     func(o *Observation) { o.GPU.GPUs[0].UUID = "" },
		"duplicate resource": func(o *Observation) { o.GPU.GPUs = append(o.GPU.GPUs, o.GPU.GPUs[0]) },
		"future metric": func(o *Observation) {
			m := o.GPU.GPUs[0].Metrics["gpu_activity"]
			m.SampledAt = now.Add(time.Hour)
			o.GPU.GPUs[0].Metrics["gpu_activity"] = m
		},
		"nonfinite metric": func(o *Observation) {
			m := o.GPU.GPUs[0].Metrics["gpu_activity"]
			m.Value = model.Float(math.NaN())
			o.GPU.GPUs[0].Metrics["gpu_activity"] = m
		},
		"invalid unit": func(o *Observation) {
			m := o.GPU.GPUs[0].Metrics["gpu_activity"]
			m.Unit = "mystery"
			o.GPU.GPUs[0].Metrics["gpu_activity"] = m
		},
		"invalid status": func(o *Observation) {
			m := o.GPU.GPUs[0].Metrics["gpu_activity"]
			m.Status = "invented"
			o.GPU.GPUs[0].Metrics["gpu_activity"] = m
		},
		"control character": func(o *Observation) { o.GPU.GPUs[0].Name = "bad\x00name" },
		"future envelope":   func(o *Observation) { o.ObservedAt = now.Add(time.Hour) },
		"incomplete unset metric": func(o *Observation) {
			o.GPU.GPUs[0].Metrics["gpu_activity"] = model.Metric{SampledAt: now.Add(time.Hour)}
		},
		"incomplete unset memory":   func(o *Observation) { o.GPU.GPUs[0].Memory.Source = "custom" },
		"incomplete unset provider": func(o *Observation) { o.GPU.Capabilities.NVML.Available = true },
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			o := gpuObservation(now)
			change(&o)
			if o.ValidateAt(now) == nil {
				t.Fatal("accepted malformed observation")
			}
		})
	}
}

func TestPrivateScopesAndNonCoderIdentityRoundTrip(t *testing.T) {
	now := time.Now().UTC()
	o := Observation{Capability: Processes, InstanceID: "external", SessionID: "first", Revision: 1, ObservedAt: now, Status: "available", Processes: &ProcessData{Processes: []ProcessRecord{{Process: model.Process{PID: 12, ScopeRef: "hidden", Status: model.StatusAvailable}, ScopeRef: "opaque-scope"}}}}
	data, err := json.Marshal(o)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "hidden") || !strings.Contains(string(data), "opaque-scope") {
		t.Fatalf("private join contract: %s", data)
	}
	o.Capability = WorkloadInventory
	o.Processes = nil
	o.WorkloadInventory = &InventoryData{Workloads: []model.WorkloadAttribution{{Ref: "batch/job", Platform: "batch", Kind: "task", Name: "Job"}}, Owners: []Owner{{Ref: "batch/owner", Name: "Owner", Platform: "batch", WorkloadRefs: []string{"batch/job"}}}}
	if err = o.ValidateAt(now); err != nil {
		t.Fatal(err)
	}
}

type testSource struct {
	mu          sync.Mutex
	observation Observation
	err         error
}

func (s *testSource) Manifest() Manifest {
	return Manifest{ProtocolVersion: "1", ID: "test", Version: "1", Capabilities: map[Capability]string{GPU: "1"}}
}
func (s *testSource) Open(context.Context) error { return nil }
func (s *testSource) Close() error               { return nil }
func (s *testSource) Read(context.Context, Capability, time.Time) (Observation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.observation, s.err
}

func serveTest(t *testing.T, handler http.Handler) *Client {
	t.Helper()
	dir, err := os.MkdirTemp("", "plugin-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	path := filepath.Join(dir, "p.sock")
	listener, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: handler}
	go server.Serve(listener)
	t.Cleanup(func() { server.Close() })
	client, err := NewUnixClient(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { client.Close() })
	return client
}

func TestUnixTransportPreservesFreshnessAndRejectsRegression(t *testing.T) {
	now := time.Now().UTC()
	source := &testSource{observation: gpuObservation(now.Add(-time.Second))}
	handler, err := NewHandler(source, HandlerOptions{InstanceID: "configured"})
	if err != nil {
		t.Fatal(err)
	}
	client := serveTest(t, handler)
	if err = client.Open(context.Background()); err != nil {
		t.Fatal(err)
	}
	first, err := client.Read(context.Background(), GPU, now)
	if err != nil {
		t.Fatal(err)
	}
	if first.InstanceID != "configured" || first.SessionID == "first" || !first.ObservedAt.Equal(source.observation.ObservedAt) {
		t.Fatalf("identity/freshness changed: %+v", first)
	}
	source.mu.Lock()
	source.observation.Revision = 2
	source.observation.ObservedAt = now
	source.mu.Unlock()
	if _, err = client.Read(context.Background(), GPU, now); err != nil {
		t.Fatal(err)
	}
	source.mu.Lock()
	source.observation.Revision = 1
	source.mu.Unlock()
	if _, err = client.Read(context.Background(), GPU, now); err == nil {
		t.Fatal("accepted revision regression")
	}
	source.mu.Lock()
	source.err = errors.New("private credentials in implementation error")
	source.mu.Unlock()
	_, err = client.Read(context.Background(), GPU, now)
	if err == nil || strings.Contains(err.Error(), "credentials") {
		t.Fatalf("error boundary: %v", err)
	}
}

func TestClientAllowsNewSessionAndRejectsWrongCapability(t *testing.T) {
	now := time.Now().UTC()
	o := gpuObservation(now)
	mu := sync.Mutex{}
	client := serveTest(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if r.URL.Path == ManifestPath {
			writeJSON(w, 200, (&testSource{}).Manifest())
			return
		}
		writeJSON(w, 200, o)
	}))
	if err := client.Open(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := client.Read(context.Background(), GPU, now); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	o.SessionID = "second"
	mu.Unlock()
	if _, err := client.Read(context.Background(), GPU, now); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	o.SessionID = "first"
	mu.Unlock()
	if _, err := client.Read(context.Background(), GPU, now); err == nil {
		t.Fatal("accepted delayed response from retired session")
	}
	mu.Lock()
	o.SessionID = "second"
	o.Capability = Host
	o.GPU = nil
	o.Host = &HostData{}
	mu.Unlock()
	if _, err := client.Read(context.Background(), GPU, now); err == nil {
		t.Fatal("accepted capability substitution")
	}
}

func TestRestartRevalidatesManifestAndRejectsInvalidContentType(t *testing.T) {
	now := time.Now().UTC()
	mu := sync.Mutex{}
	observation := gpuObservation(now)
	manifest := (&testSource{}).Manifest()
	invalidContentType := false
	client := serveTest(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if invalidContentType {
			w.Header().Set("Content-Type", "text/plain")
			_ = json.NewEncoder(w).Encode(observation)
			return
		}
		if r.URL.Path == ManifestPath {
			writeJSON(w, 200, manifest)
			return
		}
		writeJSON(w, 200, observation)
	}))
	if err := client.Open(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := client.Read(context.Background(), GPU, now); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	observation.SessionID = "restarted"
	manifest.ProtocolVersion = "2"
	mu.Unlock()
	if _, err := client.Read(context.Background(), GPU, now); err == nil {
		t.Fatal("accepted incompatible restarted protocol")
	}
	mu.Lock()
	manifest.ProtocolVersion = "1"
	mu.Unlock()
	if _, err := client.Read(context.Background(), GPU, now); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	invalidContentType = true
	mu.Unlock()
	if _, err := client.Read(context.Background(), GPU, now); err == nil {
		t.Fatal("accepted non-JSON media type")
	}
}

func TestValidationAcceptsBoundedLargeHostObservations(t *testing.T) {
	now := time.Now().UTC()
	processes := Observation{InstanceID: "processes", SessionID: "session", Capability: Processes, Revision: 1, ObservedAt: now, Status: "available", Processes: &ProcessData{Capability: model.ProviderState{Name: "proc", Status: model.StatusAvailable, Available: true}}}
	for index := 0; index < 4096; index++ {
		processes.Processes.Processes = append(processes.Processes.Processes, ProcessRecord{Process: model.Process{PID: uint32(index + 1), User: "user", Executable: "worker", StartTime: &now, Status: model.StatusAvailable}, ScopeRef: fmt.Sprintf("scope-%d", index)})
	}
	if err := processes.ValidateAt(now); err != nil {
		t.Fatalf("4096 bounded process records rejected: %v", err)
	}
	data, err := json.Marshal(processes)
	if err != nil || len(data) > MaxDocumentBytes {
		t.Fatalf("process fixture exceeds wire contract: bytes=%d err=%v", len(data), err)
	}
	processes.Processes.Processes = append(processes.Processes.Processes, ProcessRecord{Process: model.Process{PID: 5000, Status: model.StatusAvailable}})
	if processes.ValidateAt(now) == nil {
		t.Fatal("process cardinality bound lost")
	}
	topology := gpuObservation(now)
	topology.GPU.GPUs = nil
	metrics := func(scope model.MetricScope) model.MetricSet {
		values := model.MetricSet{}
		for _, name := range []string{"gpu_activity", "sm_activity", "sm_occupancy", "tensor_activity", "dram_activity", "memory_activity"} {
			values[name] = model.AvailableMetric(25, "percent", model.SourceNVMLGPM, scope, now)
		}
		return values
	}
	for device := 0; device < 8; device++ {
		gpu := model.GPU{UUID: fmt.Sprintf("GPU-%d", device), MIGEnabled: true, Metrics: metrics(model.ScopePhysicalGPU)}
		for instance := 0; instance < 7; instance++ {
			gi := model.GPUInstance{UUID: fmt.Sprintf("GI-%d-%d", device, instance), ID: uint32(instance), Metrics: metrics(model.ScopeGPUInstance)}
			for compute := 0; compute < 7; compute++ {
				gi.ComputeInstances = append(gi.ComputeInstances, model.ComputeInstance{UUID: fmt.Sprintf("CI-%d-%d-%d", device, instance, compute), ID: uint32(compute), Metrics: metrics(model.ScopeComputeInstance)})
			}
			gpu.GPUInstances = append(gpu.GPUInstances, gi)
		}
		topology.GPU.GPUs = append(topology.GPU.GPUs, gpu)
	}
	if err = topology.ValidateAt(now); err != nil {
		t.Fatalf("8-GPU bounded MIG topology rejected: %v", err)
	}
	data, err = json.Marshal(topology)
	if err != nil || len(data) > MaxDocumentBytes {
		t.Fatalf("topology fixture exceeds wire contract: bytes=%d err=%v", len(data), err)
	}
}

func TestHistoryEntityIdentitiesRejectSurroundingWhitespace(t *testing.T) {
	now := time.Now().UTC()
	envelope := func(capability Capability) Observation {
		return Observation{Capability: capability, InstanceID: "external", SessionID: "first", Revision: 1, ObservedAt: now, Status: "available"}
	}
	gpu := gpuObservation(now)
	gpu.GPU.GPUs[0].Name = " Display label "
	gpu.GPU.GPUs[0].GPUInstances = []model.GPUInstance{{UUID: "GI-1", ComputeInstances: []model.ComputeInstance{{UUID: "CI-1"}}}}
	inventory := envelope(WorkloadInventory)
	inventory.WorkloadInventory = &InventoryData{
		Workloads: []model.WorkloadAttribution{{Ref: "ns/job", Platform: "batch", Kind: "job", Name: " Job label "}},
		Owners:    []Owner{{Ref: "owner", Name: " Owner label ", Platform: "batch", WorkloadRefs: []string{"ns/job"}}},
		Scopes:    []ScopeAssignment{{ScopeRef: " opaque scope ", WorkloadRef: "ns/job", OwnerRef: "owner"}},
	}
	allocations := envelope(Allocations)
	allocations.Allocations = &AllocationData{
		Assignments: []Assignment{{WorkloadRef: "ns/job", Resource: ResourceRef{InstanceID: "external", ID: "GPU-1"}, EntityType: model.AllocationEntityPhysicalGPU, State: model.AllocationStateAllocated}},
		Resolution:  &model.AttributionResolution{Status: "incomplete", Workloads: []model.WorkloadAssignmentResolution{{WorkloadRef: "ns/job"}}},
	}
	processes := envelope(Processes)
	processes.Processes = &ProcessData{Processes: []ProcessRecord{{Process: model.Process{PID: 1, WorkloadRef: "ns/job", Status: model.StatusAvailable}, ScopeRef: " opaque scope "}}}
	measurements := envelope(WorkloadMeasurements)
	measurements.WorkloadMeasurements = &model.WorkloadTelemetry{Status: model.WorkloadTelemetryAvailable, Owners: []model.WorkloadOwnerTelemetry{{Ref: "owner", Status: model.WorkloadTelemetryAvailable}}}
	cases := []struct {
		name        string
		observation Observation
		identity    *string
	}{
		{"gpu", gpu, &gpu.GPU.GPUs[0].UUID},
		{"gpu instance", gpu, &gpu.GPU.GPUs[0].GPUInstances[0].UUID},
		{"compute instance", gpu, &gpu.GPU.GPUs[0].GPUInstances[0].ComputeInstances[0].UUID},
		{"workload", inventory, &inventory.WorkloadInventory.Workloads[0].Ref},
		{"owner", inventory, &inventory.WorkloadInventory.Owners[0].Ref},
		{"owner workload reference", inventory, &inventory.WorkloadInventory.Owners[0].WorkloadRefs[0]},
		{"scope workload reference", inventory, &inventory.WorkloadInventory.Scopes[0].WorkloadRef},
		{"scope owner reference", inventory, &inventory.WorkloadInventory.Scopes[0].OwnerRef},
		{"resource reference", allocations, &allocations.Allocations.Assignments[0].Resource.ID},
		{"assignment workload reference", allocations, &allocations.Allocations.Assignments[0].WorkloadRef},
		{"resolution workload reference", allocations, &allocations.Allocations.Resolution.Workloads[0].WorkloadRef},
		{"process workload reference", processes, &processes.Processes.Processes[0].Process.WorkloadRef},
		{"measured owner", measurements, &measurements.WorkloadMeasurements.Owners[0].Ref},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			original := *test.identity
			defer func() { *test.identity = original }()
			for _, id := range []string{" ns/job", "ns/job ", "\u00a0ns/job", "ns/job\u0085", "\u3000ns/job"} {
				*test.identity = id
				if err := test.observation.ValidateAt(now); err == nil {
					t.Fatalf("accepted identity with surrounding whitespace %q", id)
				}
			}
			for _, id := range []string{original, "ns/job name", "ns/job\u00a0name"} {
				*test.identity = id
				if err := test.observation.ValidateAt(now); err != nil {
					t.Fatalf("rejected addressable identity %q or unchanged label/scope: %v", id, err)
				}
			}
		})
	}
	processes.Processes.Processes[0].Process.WorkloadRef = ""
	inventory.WorkloadInventory.Scopes[0].OwnerRef = ""
	for _, observation := range []Observation{processes, inventory} {
		if err := observation.ValidateAt(now); err != nil {
			t.Fatalf("empty optional reference rejected: %v", err)
		}
	}
}
