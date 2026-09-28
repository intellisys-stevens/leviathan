package v1

import (
	"context"
	"encoding/json"
	"errors"
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
