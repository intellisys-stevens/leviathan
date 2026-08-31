package api

import (
	"bufio"
	"compress/gzip"
	"context"
	"encoding/json"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strconv"
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
	series   history.Series
	aligned  history.AlignedSeries

	alignedCalls     int
	alignedRequest   []history.SeriesDescriptor
	alignedWindow    time.Duration
	alignedMaxPoints int
}

func newStubSource() *stubSource {
	at := time.Date(2026, 8, 29, 12, 0, 0, 0, time.UTC)
	return &stubSource{
		snapshot: model.Snapshot{SchemaVersion: "v1", Sequence: 9, SampledAt: at, GPUs: []model.GPU{}, Processes: []model.Process{}, Diagnostics: []model.Diagnostic{}},
		events:   make(chan model.Snapshot, 1),
		settings: model.RuntimeSettings{SamplingIntervalMs: 1000, ProfileIntervalMs: 2000, ProcessIntervalMs: 2000, HistoryWindowMs: 3600000, AllowedSamplingIntervalsMs: []int64{500, 1000, 2000}},
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
	series := s.series
	series.Entity, series.Metrics, series.Window = entity, metrics, window.String()
	if series.Points == nil {
		series.Points = []history.Point{}
	}
	return series
}
func (s *stubSource) AlignedHistory(series []history.SeriesDescriptor, window time.Duration, maxPoints int, now time.Time) history.AlignedSeries {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.alignedCalls++
	s.alignedRequest = append([]history.SeriesDescriptor(nil), series...)
	s.alignedWindow = window
	s.alignedMaxPoints = maxPoints
	result := s.aligned
	result.Window = window.String()
	result.Series = append([]history.SeriesDescriptor(nil), series...)
	if result.Points == nil {
		result.Points = []history.AlignedPoint{}
	}
	return history.LimitAligned(result, maxPoints)
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
	body := response.Body.String()
	for _, expected := range []string{`"gpus":[]`, `"processes":[]`, `"diagnostics":[]`} {
		if !strings.Contains(body, expected) {
			t.Fatalf("snapshot response does not preserve empty wire container %s: %s", expected, body)
		}
	}
	var snapshot model.Snapshot
	if err := json.NewDecoder(strings.NewReader(body)).Decode(&snapshot); err != nil || snapshot.Sequence != 9 {
		t.Fatalf("invalid snapshot response: %+v, %v", snapshot, err)
	}
}

func TestSnapshotEncodesNilCollectionsAsArrays(t *testing.T) {
	source := newStubSource()
	source.snapshot.GPUs = nil
	source.snapshot.Processes = nil
	source.snapshot.Diagnostics = nil
	source.snapshot.Attribution = &model.Attribution{}
	server := newTestServer(source, nil)
	response := httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v1/snapshot", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d", response.Code)
	}

	var payload map[string]json.RawMessage
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if string(payload["gpus"]) != "[]" || string(payload["processes"]) != "[]" || string(payload["diagnostics"]) != "[]" {
		t.Fatalf("empty snapshot collections encoded as gpus=%s processes=%s diagnostics=%s", payload["gpus"], payload["processes"], payload["diagnostics"])
	}
	var attribution map[string]json.RawMessage
	if err := json.Unmarshal(payload["attribution"], &attribution); err != nil {
		t.Fatal(err)
	}
	if string(attribution["workloads"]) != "[]" || string(attribution["assignments"]) != "[]" {
		t.Fatalf("empty attribution collections encoded as workloads=%s assignments=%s", attribution["workloads"], attribution["assignments"])
	}
}

func TestHistoryValidation(t *testing.T) {
	server := newTestServer(newStubSource(), nil)
	for _, target := range []string{
		"/api/v1/history",
		"/api/v1/history?entity=MIG-a&window=forever",
		"/api/v1/history?entity=MIG-a&maxPoints=49",
		"/api/v1/history?entity=MIG-a&maxPoints=5001",
		"/api/v1/history?entity=MIG-a&maxPoints=many",
	} {
		response := httptest.NewRecorder()
		server.ServeHTTP(response, httptest.NewRequest(http.MethodGet, target, nil))
		if response.Code != http.StatusBadRequest {
			t.Errorf("%s status = %d", target, response.Code)
		}
	}
}

func TestHistoryMaxPointsIsStrict(t *testing.T) {
	source := newStubSource()
	for index := 0; index < 200; index++ {
		source.series.Points = append(source.series.Points, history.Point{
			SampledAt: time.Unix(int64(index), 0),
			Values:    map[string]float64{"sm_activity": float64(index % 17)},
		})
	}
	server := newTestServer(source, nil)
	response := httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v1/history?entity=MIG-a&metrics=sm_activity&maxPoints=50", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", response.Code, response.Body.String())
	}
	var series history.Series
	if err := json.NewDecoder(response.Body).Decode(&series); err != nil {
		t.Fatal(err)
	}
	if len(series.Points) > 50 {
		t.Fatalf("history points = %d, want <= 50", len(series.Points))
	}
}

func TestAlignedHistoryContractAndStrictCap(t *testing.T) {
	source := newStubSource()
	for index := 0; index < 200; index++ {
		source.aligned.Points = append(source.aligned.Points, history.AlignedPoint{
			SampledAt: time.Unix(int64(index), 0).UTC(),
			Values: map[string]map[string]float64{
				"gpu": {"sm_activity": float64(index % 19)},
				"gi":  {"sm_activity": float64(index % 23)},
			},
		})
	}
	server := newTestServer(source, nil)
	body := `{"window":"30m","maxPoints":50,"series":[{"key":"gpu","entity":"GPU-a","metrics":["sm_activity"]},{"key":"gi","entity":"GI-a","metrics":["sm_activity"]}]}`
	request := httptest.NewRequest(http.MethodPost, "/api/v1/history/aligned", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json; charset=utf-8")
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", response.Code, response.Body.String())
	}
	var got history.AlignedSeries
	if err := json.NewDecoder(response.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if len(got.Points) != 50 {
		t.Fatalf("aligned points = %d, want strict cap of 50", len(got.Points))
	}
	if len(got.Series) != 2 || got.Series[0].Key != "gpu" || got.Series[1].Key != "gi" {
		t.Fatalf("response descriptors = %+v", got.Series)
	}
	if source.alignedCalls != 1 || source.alignedWindow != 30*time.Minute || source.alignedMaxPoints != 50 {
		t.Fatalf("aligned source call = calls:%d window:%s cap:%d", source.alignedCalls, source.alignedWindow, source.alignedMaxPoints)
	}
}

func TestAlignedHistoryValidation(t *testing.T) {
	valid := `{"window":"30m","maxPoints":720,"series":[{"key":"gpu","entity":"GPU-a","metrics":["sm_activity"]}]}`
	tests := []struct {
		name        string
		contentType string
		body        string
		status      int
	}{
		{name: "requires json", body: valid, status: http.StatusUnsupportedMediaType},
		{name: "malformed", contentType: "application/json", body: `{`, status: http.StatusBadRequest},
		{name: "unknown field", contentType: "application/json", body: `{"window":"30m","maxPoints":720,"series":[],"extra":true}`, status: http.StatusBadRequest},
		{name: "trailing object", contentType: "application/json", body: valid + `{}`, status: http.StatusBadRequest},
		{name: "missing window", contentType: "application/json", body: `{"maxPoints":720,"series":[{"key":"a","entity":"GPU-a","metrics":["sm_activity"]}]}`, status: http.StatusBadRequest},
		{name: "invalid window", contentType: "application/json", body: `{"window":"forever","maxPoints":720,"series":[{"key":"a","entity":"GPU-a","metrics":["sm_activity"]}]}`, status: http.StatusBadRequest},
		{name: "nonpositive window", contentType: "application/json", body: `{"window":"0s","maxPoints":720,"series":[{"key":"a","entity":"GPU-a","metrics":["sm_activity"]}]}`, status: http.StatusBadRequest},
		{name: "window exceeds retention", contentType: "application/json", body: `{"window":"2h","maxPoints":720,"series":[{"key":"a","entity":"GPU-a","metrics":["sm_activity"]}]}`, status: http.StatusBadRequest},
		{name: "cap too small", contentType: "application/json", body: `{"window":"30m","maxPoints":49,"series":[{"key":"a","entity":"GPU-a","metrics":["sm_activity"]}]}`, status: http.StatusBadRequest},
		{name: "cap too large", contentType: "application/json", body: `{"window":"30m","maxPoints":5001,"series":[{"key":"a","entity":"GPU-a","metrics":["sm_activity"]}]}`, status: http.StatusBadRequest},
		{name: "series required", contentType: "application/json", body: `{"window":"30m","maxPoints":720,"series":[]}`, status: http.StatusBadRequest},
		{name: "duplicate keys", contentType: "application/json", body: `{"window":"30m","maxPoints":720,"series":[{"key":"a","entity":"GPU-a","metrics":["sm_activity"]},{"key":"a","entity":"GPU-b","metrics":["sm_activity"]}]}`, status: http.StatusBadRequest},
		{name: "blank key", contentType: "application/json", body: `{"window":"30m","maxPoints":720,"series":[{"key":" ","entity":"GPU-a","metrics":["sm_activity"]}]}`, status: http.StatusBadRequest},
		{name: "blank entity", contentType: "application/json", body: `{"window":"30m","maxPoints":720,"series":[{"key":"a","entity":"","metrics":["sm_activity"]}]}`, status: http.StatusBadRequest},
		{name: "metrics required", contentType: "application/json", body: `{"window":"30m","maxPoints":720,"series":[{"key":"a","entity":"GPU-a","metrics":[]}]}`, status: http.StatusBadRequest},
		{name: "duplicate metrics", contentType: "application/json", body: `{"window":"30m","maxPoints":720,"series":[{"key":"a","entity":"GPU-a","metrics":["sm_activity","sm_activity"]}]}`, status: http.StatusBadRequest},
		{name: "descriptor unknown field", contentType: "application/json", body: `{"window":"30m","maxPoints":720,"series":[{"key":"a","entity":"GPU-a","metrics":["sm_activity"],"label":"GPU 0"}]}`, status: http.StatusBadRequest},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			source := newStubSource()
			server := newTestServer(source, nil)
			request := httptest.NewRequest(http.MethodPost, "/api/v1/history/aligned", strings.NewReader(test.body))
			if test.contentType != "" {
				request.Header.Set("Content-Type", test.contentType)
			}
			response := httptest.NewRecorder()
			server.ServeHTTP(response, request)
			if response.Code != test.status {
				t.Fatalf("status = %d body=%s", response.Code, response.Body.String())
			}
			if source.alignedCalls != 0 {
				t.Fatalf("invalid request reached data source %d times", source.alignedCalls)
			}
		})
	}
}

func TestAlignedHistoryBoundsDescriptorCount(t *testing.T) {
	descriptors := make([]history.SeriesDescriptor, maxAlignedHistorySeries+1)
	for index := range descriptors {
		descriptors[index] = history.SeriesDescriptor{Key: strconv.Itoa(index), Entity: "GPU-a", Metrics: []string{"sm_activity"}}
	}
	body, err := json.Marshal(history.AlignedRequest{Window: "30m", MaxPoints: 720, Series: descriptors})
	if err != nil {
		t.Fatal(err)
	}
	server := newTestServer(newStubSource(), nil)
	request := httptest.NewRequest(http.MethodPost, "/api/v1/history/aligned", strings.NewReader(string(body)))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d body=%s", response.Code, response.Body.String())
	}
}

func TestAlignedHistoryBoundsRequestBody(t *testing.T) {
	source := newStubSource()
	server := newTestServer(source, nil)
	body := `{"window":"` + strings.Repeat("x", maxAlignedHistoryBodyBytes) + `","maxPoints":720,"series":[{"key":"a","entity":"GPU-a","metrics":["sm_activity"]}]}`
	request := httptest.NewRequest(http.MethodPost, "/api/v1/history/aligned", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d body=%s", response.Code, response.Body.String())
	}
	if source.alignedCalls != 0 {
		t.Fatalf("oversized request reached data source %d times", source.alignedCalls)
	}
}

func TestGzipJSONAndSSEFlush(t *testing.T) {
	t.Run("json", func(t *testing.T) {
		server := newTestServer(newStubSource(), nil)
		request := httptest.NewRequest(http.MethodGet, "/api/v1/snapshot", nil)
		request.Header.Set("Accept-Encoding", "gzip")
		response := httptest.NewRecorder()
		server.ServeHTTP(response, request)
		if response.Header().Get("Content-Encoding") != "gzip" || !strings.Contains(response.Header().Get("Vary"), "Accept-Encoding") {
			t.Fatalf("compression headers = %#v", response.Header())
		}
		reader, err := gzip.NewReader(response.Body)
		if err != nil {
			t.Fatal(err)
		}
		defer reader.Close()
		var snapshot model.Snapshot
		if err := json.NewDecoder(reader).Decode(&snapshot); err != nil || snapshot.Sequence != 9 {
			t.Fatalf("compressed snapshot = %+v, %v", snapshot, err)
		}
	})

	t.Run("sse", func(t *testing.T) {
		server := httptest.NewServer(newTestServer(newStubSource(), nil))
		defer server.Close()
		request, _ := http.NewRequest(http.MethodGet, server.URL+"/api/v1/events", nil)
		request.Header.Set("Accept-Encoding", "gzip")
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		if response.Header.Get("Content-Encoding") != "gzip" {
			t.Fatalf("SSE content encoding = %q", response.Header.Get("Content-Encoding"))
		}
		reader, err := gzip.NewReader(response.Body)
		if err != nil {
			t.Fatal(err)
		}
		defer reader.Close()
		scanner := bufio.NewScanner(reader)
		found := false
		for scanner.Scan() {
			if scanner.Text() == "event: snapshot" {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("compressed SSE did not flush a snapshot: %v", scanner.Err())
		}
	})
}

func TestGzipRespectsZeroQuality(t *testing.T) {
	server := newTestServer(newStubSource(), nil)
	request := httptest.NewRequest(http.MethodGet, "/api/v1/snapshot", nil)
	request.Header.Set("Accept-Encoding", "br, gzip;q=0")
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if got := response.Header().Get("Content-Encoding"); got != "" {
		t.Fatalf("content encoding = %q, want identity", got)
	}
}

func TestSSEProvidesSnapshotOnReconnect(t *testing.T) {
	source := newStubSource()
	source.snapshot.GPUs = nil
	source.snapshot.Processes = nil
	source.snapshot.Diagnostics = nil
	source.snapshot.Attribution = &model.Attribution{}
	server := httptest.NewServer(newTestServer(source, nil))
	defer server.Close()
	request, _ := http.NewRequestWithContext(context.Background(), http.MethodGet, server.URL+"/api/v1/events", nil)
	request.Header.Set("Last-Event-ID", "8")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	scanner := bufio.NewScanner(response.Body)
	foundEvent := false
	var payload map[string]json.RawMessage
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "event: snapshot") {
			foundEvent = true
			continue
		}
		if foundEvent && strings.HasPrefix(line, "data: ") {
			if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &payload); err != nil {
				t.Fatal(err)
			}
			break
		}
	}
	if payload == nil {
		t.Fatal("snapshot SSE event not received")
	}
	if string(payload["gpus"]) != "[]" || string(payload["processes"]) != "[]" || string(payload["diagnostics"]) != "[]" {
		t.Fatalf("empty SSE collections encoded as gpus=%s processes=%s diagnostics=%s", payload["gpus"], payload["processes"], payload["diagnostics"])
	}
	var attribution map[string]json.RawMessage
	if err := json.Unmarshal(payload["attribution"], &attribution); err != nil {
		t.Fatal(err)
	}
	if string(attribution["workloads"]) != "[]" || string(attribution["assignments"]) != "[]" {
		t.Fatalf("empty SSE attribution encoded as workloads=%s assignments=%s", attribution["workloads"], attribution["assignments"])
	}
}

func TestSSEPublishesProcessWorkloadReferenceWithoutScope(t *testing.T) {
	source := newStubSource()
	const workloadRef = "workspace_11111111111111111111111111111111"
	const scopeRef = "scope_22222222222222222222222222222222"
	source.snapshot.Processes = []model.Process{{
		PID: 42, WorkloadRef: workloadRef, ScopeRef: scopeRef, Status: model.StatusAvailable,
	}}
	source.snapshot.Attribution = &model.Attribution{
		Provider: model.AttributionProviderKubernetesDRA, Status: model.AttributionAvailable,
		Workloads: []model.WorkloadAttribution{{
			Ref: workloadRef, Platform: model.WorkloadPlatformCoder, Kind: model.WorkloadKindWorkspace,
			Name: "workspace", OwnerName: "owner",
		}}, Assignments: []model.ResourceAssignment{},
	}
	server := httptest.NewServer(newTestServer(source, nil))
	defer server.Close()
	response, err := http.Get(server.URL + "/api/v1/events")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	scanner := bufio.NewScanner(response.Body)
	foundEvent := false
	for scanner.Scan() {
		line := scanner.Text()
		if line == "event: snapshot" {
			foundEvent = true
			continue
		}
		if !foundEvent || !strings.HasPrefix(line, "data: ") {
			continue
		}
		payload := strings.TrimPrefix(line, "data: ")
		if !strings.Contains(payload, `"workloadRef":"`+workloadRef+`"`) {
			t.Fatalf("SSE process workload reference is absent: %s", payload)
		}
		if strings.Contains(payload, "scopeRef") || strings.Contains(payload, scopeRef) {
			t.Fatalf("internal process scope leaked into SSE: %s", payload)
		}
		return
	}
	t.Fatalf("snapshot SSE event not received: %v", scanner.Err())
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
	source.snapshot.Processes = []model.Process{{
		PID: 42, User: "coder", Executable: "/usr/bin/python3", Status: model.StatusAvailable,
		WorkloadRef: "workspace_11111111111111111111111111111111", ScopeRef: "scope_22222222222222222222222222222222",
	}}
	source.snapshot.Attribution = &model.Attribution{
		Provider: model.AttributionProviderKubernetesDRA, Status: model.AttributionAvailable,
		Workloads: []model.WorkloadAttribution{{
			Ref: "workspace_11111111111111111111111111111111", Platform: model.WorkloadPlatformCoder,
			Kind: model.WorkloadKindWorkspace, Name: "workspace", OwnerName: "owner",
		}}, Assignments: []model.ResourceAssignment{},
	}
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
		case "pid", "user", "executable", "commandLine", "startTime", "workloadRef", "status", "message":
		default:
			t.Fatalf("unexpected GPU-process field %q: %#v", key, process)
		}
	}
	if process["workloadRef"] != "workspace_11111111111111111111111111111111" {
		t.Fatalf("process workload reference = %#v", process["workloadRef"])
	}
	encodedPayload, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	if _, exists := process["scopeRef"]; exists || strings.Contains(string(encodedPayload), "scope_22222222222222222222222222222222") {
		t.Fatalf("internal process scope leaked into response: %s", encodedPayload)
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

func TestSnapshotOmitsOrphanedProcessWorkloadReferenceWithoutMutatingSource(t *testing.T) {
	source := newStubSource()
	source.snapshot.Processes = []model.Process{{
		PID: 42, WorkloadRef: "workspace_11111111111111111111111111111111", Status: model.StatusAvailable,
	}}
	server := newTestServer(source, nil)
	response := httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v1/snapshot", nil))
	if response.Code != http.StatusOK || strings.Contains(response.Body.String(), "workloadRef") {
		t.Fatalf("orphaned workload reference reached API: %d %s", response.Code, response.Body.String())
	}
	if source.snapshot.Processes[0].WorkloadRef == "" {
		t.Fatal("wire normalization mutated the source snapshot")
	}
}
