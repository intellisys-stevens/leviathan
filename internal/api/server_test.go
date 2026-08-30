package api

import (
	"bufio"
	"context"
	"encoding/json"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"github.com/intellisys-stevens/miglens/internal/history"
	"github.com/intellisys-stevens/miglens/internal/model"
)

type stubSource struct {
	mu       sync.Mutex
	snapshot model.Snapshot
	events   chan model.Snapshot
	settings model.RuntimeSettings
}

func newStubSource() *stubSource {
	at := time.Date(2026, 8, 29, 12, 0, 0, 0, time.UTC)
	return &stubSource{
		snapshot: model.Snapshot{SchemaVersion: "v1", Sequence: 9, SampledAt: at, GPUs: []model.GPU{}, Processes: []model.Process{}, Diagnostics: []model.Diagnostic{}},
		events:   make(chan model.Snapshot, 1),
		settings: model.RuntimeSettings{SamplingIntervalMs: 1000, HistoryWindowMs: 3600000, AllowedSamplingIntervalsMs: []int64{500, 1000, 2000}},
	}
}

func newTestServer(source DataSource, assets fs.FS) *Server {
	return NewServer(source, assets, model.BuildInfo{
		Version:   "0.1.0",
		Commit:    "abc1234",
		BuildDate: "2026-08-30T12:00:00Z",
	})
}

func (s *stubSource) Current() (model.Snapshot, bool) { return s.snapshot, true }
func (s *stubSource) History(entity string, metrics []string, window time.Duration, now time.Time) history.Series {
	return history.Series{Entity: entity, Metrics: metrics, Window: window.String(), Points: []history.Point{}}
}
func (s *stubSource) Subscribe() (<-chan model.Snapshot, func()) {
	s.mu.Lock()
	defer s.mu.Unlock()
	channel := make(chan model.Snapshot, 1)
	channel <- s.snapshot
	return channel, func() { close(channel) }
}
func (s *stubSource) Capabilities() model.Capabilities { return model.Capabilities{} }
func (s *stubSource) LastError() error                 { return nil }
func (s *stubSource) RuntimeSettings() model.RuntimeSettings {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.settings
}
func (s *stubSource) SetSamplingInterval(interval time.Duration) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.settings.SamplingIntervalMs = interval.Milliseconds()
	return nil
}

func TestSnapshotAndSecurityHeaders(t *testing.T) {
	server := newTestServer(newStubSource(), fstest.MapFS{"index.html": {Data: []byte("dashboard")}})
	request := httptest.NewRequest(http.MethodGet, "/api/v1/snapshot", nil)
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d", response.Code)
	}
	if response.Header().Get("Content-Security-Policy") == "" {
		t.Fatal("missing content security policy")
	}
	var snapshot model.Snapshot
	if err := json.NewDecoder(response.Body).Decode(&snapshot); err != nil || snapshot.Sequence != 9 {
		t.Fatalf("invalid snapshot response: %+v, %v", snapshot, err)
	}
}

func TestHistoryValidation(t *testing.T) {
	server := newTestServer(newStubSource(), nil)
	for _, target := range []string{"/api/v1/history", "/api/v1/history?entity=MIG-a&window=forever"} {
		response := httptest.NewRecorder()
		server.ServeHTTP(response, httptest.NewRequest(http.MethodGet, target, nil))
		if response.Code != http.StatusBadRequest {
			t.Errorf("%s status = %d", target, response.Code)
		}
	}
}

func TestSSEProvidesSnapshotOnReconnect(t *testing.T) {
	server := httptest.NewServer(newTestServer(newStubSource(), nil))
	defer server.Close()
	request, _ := http.NewRequestWithContext(context.Background(), http.MethodGet, server.URL+"/api/v1/events", nil)
	request.Header.Set("Last-Event-ID", "8")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	scanner := bufio.NewScanner(response.Body)
	found := false
	for scanner.Scan() {
		if strings.HasPrefix(scanner.Text(), "event: snapshot") {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("snapshot SSE event not received")
	}
}

func TestRuntimeSettingsGetAndPatch(t *testing.T) {
	source := newStubSource()
	source.settings.SamplingIntervalMs = 250
	server := newTestServer(source, nil)

	get := httptest.NewRecorder()
	server.ServeHTTP(get, httptest.NewRequest(http.MethodGet, "/api/v1/settings", nil))
	if get.Code != http.StatusOK {
		t.Fatalf("GET status = %d", get.Code)
	}
	var settings model.RuntimeSettings
	if err := json.NewDecoder(get.Body).Decode(&settings); err != nil || settings.HistoryWindowMs != 3_600_000 || settings.SamplingIntervalMs != 250 {
		t.Fatalf("GET settings = %+v, %v", settings, err)
	}

	patchRequest := httptest.NewRequest(http.MethodPatch, "/api/v1/settings", strings.NewReader(`{"samplingIntervalMs":500}`))
	patchRequest.Header.Set("Content-Type", "application/json; charset=utf-8")
	patch := httptest.NewRecorder()
	server.ServeHTTP(patch, patchRequest)
	if patch.Code != http.StatusOK {
		t.Fatalf("PATCH status = %d body=%s", patch.Code, patch.Body.String())
	}
	if err := json.NewDecoder(patch.Body).Decode(&settings); err != nil || settings.SamplingIntervalMs != 500 {
		t.Fatalf("PATCH settings = %+v, %v", settings, err)
	}
	if patch.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("settings mutation unexpectedly enabled CORS")
	}
}

func TestBuildInfoEndpoint(t *testing.T) {
	server := newTestServer(newStubSource(), nil)
	response := httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v1/version", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d", response.Code)
	}
	var info model.BuildInfo
	if err := json.NewDecoder(response.Body).Decode(&info); err != nil {
		t.Fatal(err)
	}
	if info.Version != "0.1.0" || info.Commit != "abc1234" || info.BuildDate != "2026-08-30T12:00:00Z" {
		t.Fatalf("build info = %+v", info)
	}
}

func TestRuntimeSettingsPatchValidation(t *testing.T) {
	server := newTestServer(newStubSource(), nil)
	tests := []struct {
		name        string
		contentType string
		body        string
		status      int
	}{
		{name: "requires json", body: `{"samplingIntervalMs":500}`, status: http.StatusUnsupportedMediaType},
		{name: "invalid choice", contentType: "application/json", body: `{"samplingIntervalMs":750}`, status: http.StatusBadRequest},
		{name: "unknown field", contentType: "application/json", body: `{"samplingIntervalMs":500,"persist":true}`, status: http.StatusBadRequest},
		{name: "missing field", contentType: "application/json", body: `{}`, status: http.StatusBadRequest},
		{name: "trailing json", contentType: "application/json", body: `{"samplingIntervalMs":500}{}`, status: http.StatusBadRequest},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPatch, "/api/v1/settings", strings.NewReader(test.body))
			if test.contentType != "" {
				request.Header.Set("Content-Type", test.contentType)
			}
			response := httptest.NewRecorder()
			server.ServeHTTP(response, request)
			if response.Code != test.status {
				t.Fatalf("status = %d body=%s", response.Code, response.Body.String())
			}
		})
	}
}

func TestSSEProvidesSettingsOnConnectAndChange(t *testing.T) {
	source := newStubSource()
	server := httptest.NewServer(newTestServer(source, nil))
	defer server.Close()

	response, err := http.Get(server.URL + "/api/v1/events")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	scanner := bufio.NewScanner(response.Body)
	seenInitial := false
	for scanner.Scan() {
		if scanner.Text() == "event: settings" {
			seenInitial = true
			break
		}
	}
	if !seenInitial {
		t.Fatal("initial settings event not received")
	}

	request, _ := http.NewRequest(http.MethodPatch, server.URL+"/api/v1/settings", strings.NewReader(`{"samplingIntervalMs":2000}`))
	request.Header.Set("Content-Type", "application/json")
	patchResponse, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	patchResponse.Body.Close()

	seenUpdate := false
	for scanner.Scan() {
		if strings.Contains(scanner.Text(), `"samplingIntervalMs":2000`) {
			seenUpdate = true
			break
		}
	}
	if !seenUpdate {
		t.Fatal("updated settings event not received")
	}
}

func TestStaticFallbackDoesNotCaptureUnknownAPI(t *testing.T) {
	server := newTestServer(newStubSource(), fstest.MapFS{"index.html": {Data: []byte("dashboard")}})
	response := httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v1/missing", nil))
	if response.Code != http.StatusNotFound || strings.Contains(response.Body.String(), "dashboard") {
		t.Fatalf("unknown API was served by SPA: %d %q", response.Code, response.Body.String())
	}
}

func TestSnapshotContractKeepsProcessesTopLevel(t *testing.T) {
	source := newStubSource()
	source.snapshot.Processes = []model.Process{{PID: 42, User: "coder", Executable: "/usr/bin/python3", Status: model.StatusAvailable}}
	at := source.snapshot.SampledAt
	source.snapshot.GPUs = []model.GPU{{
		UUID: "GPU-a", GPUInstances: []model.GPUInstance{{
			UUID: "GPU-a/gi/1", Metrics: model.MetricSet{"gpu_activity": model.AvailableMetric(37, "percent", model.SourceNVMLGPM, model.ScopeGPUInstance, at)}, ComputeInstances: []model.ComputeInstance{{UUID: "MIG-a"}},
		}},
	}}
	server := newTestServer(source, nil)
	response := httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v1/snapshot", nil))
	var payload map[string]any
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	processes, ok := payload["processes"].([]any)
	if !ok || len(processes) != 1 {
		t.Fatalf("top-level processes = %#v", payload["processes"])
	}
	process := processes[0].(map[string]any)
	for key := range process {
		switch key {
		case "pid", "user", "executable", "commandLine", "startTime", "status", "message":
		default:
			t.Fatalf("unexpected GPU-process field %q: %#v", key, process)
		}
	}
	gpus := payload["gpus"].([]any)
	gpu := gpus[0].(map[string]any)
	if _, exists := gpu["processes"]; exists {
		t.Fatalf("GPU process attribution leaked into contract: %#v", gpu)
	}
	gi := gpu["gpuInstances"].([]any)[0].(map[string]any)
	metrics := gi["metrics"].(map[string]any)
	if _, exists := metrics["gpu_activity"]; !exists {
		t.Fatalf("canonical gpu_activity metric is missing: %#v", metrics)
	}
	if _, exists := gi["placement"]; exists {
		t.Fatalf("MIG placement leaked into contract: %#v", gi)
	}
	ci := gi["computeInstances"].([]any)[0].(map[string]any)
	for _, removed := range []string{"placement", "processes", "workloads"} {
		if _, exists := ci[removed]; exists {
			t.Fatalf("removed CI field %q leaked into contract: %#v", removed, ci)
		}
	}
}
