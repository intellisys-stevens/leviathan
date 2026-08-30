package fleetapi

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

	"github.com/intellisys-stevens/miglens/internal/fleet"
	"github.com/intellisys-stevens/miglens/internal/model"
)

type stubSource struct {
	mu     sync.Mutex
	state  fleet.Snapshot
	ready  bool
	nextID uint64
	subs   map[uint64]chan fleet.Snapshot
}

func newStubSource() *stubSource {
	return &stubSource{subs: make(map[uint64]chan fleet.Snapshot)}
}

func (source *stubSource) Current() (fleet.Snapshot, bool) {
	source.mu.Lock()
	defer source.mu.Unlock()
	return source.state, source.ready
}

func (source *stubSource) Subscribe() (<-chan fleet.Snapshot, func()) {
	source.mu.Lock()
	id := source.nextID
	source.nextID++
	updates := make(chan fleet.Snapshot, 1)
	source.subs[id] = updates
	if source.ready {
		updates <- source.state
	}
	source.mu.Unlock()
	return updates, func() {
		source.mu.Lock()
		if active, ok := source.subs[id]; ok {
			delete(source.subs, id)
			close(active)
		}
		source.mu.Unlock()
	}
}

func (source *stubSource) publish(state fleet.Snapshot) {
	source.mu.Lock()
	source.state = state
	source.ready = true
	for _, updates := range source.subs {
		select {
		case updates <- state:
		default:
			<-updates
			updates <- state
		}
	}
	source.mu.Unlock()
}

func TestStateUnavailableAndSecurityHeaders(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/api/fleet/v1/state", nil)
	response := httptest.NewRecorder()
	NewServer(newStubSource(), nil, model.BuildInfo{}).ServeHTTP(response, request)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusServiceUnavailable)
	}
	if got := response.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q", got)
	}
	if got := response.Header().Get("X-Frame-Options"); got != "DENY" {
		t.Fatalf("X-Frame-Options = %q", got)
	}
	if strings.Contains(response.Body.String(), "token") || strings.Contains(response.Body.String(), "password") {
		t.Fatalf("error response leaked a credential-shaped field: %s", response.Body.String())
	}
}

func TestStateVersionHealthAndUnknownAPI(t *testing.T) {
	state := testState(9, fleet.InventoryAvailable)
	source := newStubSource()
	source.publish(state)
	buildInfo := model.BuildInfo{Version: "v0.2.0", Commit: "test", BuildDate: "2026-08-30"}
	server := NewServer(source, nil, buildInfo)

	tests := []struct {
		path       string
		status     int
		bodyNeedle string
	}{
		{path: "/api/fleet/v1/state", status: http.StatusOK, bodyNeedle: `"schemaVersion":"fleet-v1"`},
		{path: "/api/fleet/v1/version", status: http.StatusOK, bodyNeedle: `"version":"v0.2.0"`},
		{path: "/healthz", status: http.StatusOK, bodyNeedle: `"sequence":9`},
		{path: "/api/fleet/v1/missing", status: http.StatusNotFound, bodyNeedle: "API endpoint not found"},
	}
	for _, test := range tests {
		t.Run(test.path, func(t *testing.T) {
			response := httptest.NewRecorder()
			server.ServeHTTP(response, httptest.NewRequest(http.MethodGet, test.path, nil))
			if response.Code != test.status || !strings.Contains(response.Body.String(), test.bodyNeedle) {
				t.Fatalf("response = status %d body %s", response.Code, response.Body.String())
			}
		})
	}
}

func TestHealthReportsDegradedCachedInventory(t *testing.T) {
	source := newStubSource()
	source.publish(testState(2, fleet.InventoryStale))
	response := httptest.NewRecorder()
	NewServer(source, nil, model.BuildInfo{}).ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"status":"degraded"`) {
		t.Fatalf("response = status %d body %s", response.Code, response.Body.String())
	}
}

func TestEventsStreamsCurrentFleetState(t *testing.T) {
	source := newStubSource()
	source.publish(testState(4, fleet.InventoryAvailable))
	server := httptest.NewServer(NewServer(source, nil, model.BuildInfo{}))
	defer server.Close()

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, server.URL+"/api/fleet/v1/events", nil)
	if err != nil {
		t.Fatalf("NewRequestWithContext() error = %v", err)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("events request error = %v", err)
	}
	defer response.Body.Close()
	reader := bufio.NewReader(response.Body)
	var lines []string
	for len(lines) < 3 {
		line, readErr := reader.ReadString('\n')
		if readErr != nil {
			t.Fatalf("ReadString() error = %v", readErr)
		}
		if strings.TrimSpace(line) != "" {
			lines = append(lines, strings.TrimSpace(line))
		}
	}
	joined := strings.Join(lines, "\n")
	if !strings.Contains(joined, "id: 4") || !strings.Contains(joined, "event: fleet") || !strings.Contains(joined, `"sequence":4`) {
		t.Fatalf("unexpected SSE event:\n%s", joined)
	}
}

func TestStaticServesAssetsAndFleetDeepLinkFallback(t *testing.T) {
	assets := fstest.MapFS{
		"index.html":    &fstest.MapFile{Data: []byte("<main>fleet app</main>")},
		"assets/app.js": &fstest.MapFile{Data: []byte("console.log('fleet')")},
	}
	server := NewServer(newStubSource(), fs.FS(assets), model.BuildInfo{})
	root := httptest.NewRecorder()
	server.ServeHTTP(root, httptest.NewRequest(http.MethodGet, "/", nil))
	if root.Code != http.StatusTemporaryRedirect || root.Header().Get("Location") != "/fleet" {
		t.Fatalf("GET / = status %d location %q", root.Code, root.Header().Get("Location"))
	}

	for _, path := range []string{"/fleet", "/fleet/jetstream"} {
		response := httptest.NewRecorder()
		server.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusOK || response.Body.String() != "<main>fleet app</main>" {
			t.Fatalf("GET %s = status %d body %q", path, response.Code, response.Body.String())
		}
		if response.Header().Get("Cache-Control") != "no-cache" {
			t.Fatalf("GET %s Cache-Control = %q", path, response.Header().Get("Cache-Control"))
		}
	}
	response := httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/assets/app.js", nil))
	if response.Code != http.StatusOK || response.Header().Get("Cache-Control") != "public, max-age=31536000, immutable" {
		t.Fatalf("asset response = status %d cache %q", response.Code, response.Header().Get("Cache-Control"))
	}
}

func TestFleetStateJSONContainsNoCredentialFields(t *testing.T) {
	state := testState(1, fleet.InventoryAvailable)
	encoded, err := json.Marshal(state)
	if err != nil {
		t.Fatalf("json.Marshal() error = %v", err)
	}
	for _, forbidden := range []string{"metadata", "tags", "adminPass", "password", "token", "agentEndpoint", "creatorId", "user_id"} {
		if strings.Contains(strings.ToLower(string(encoded)), strings.ToLower(forbidden)) {
			t.Fatalf("fleet state contains forbidden field %q: %s", forbidden, encoded)
		}
	}
}

func testState(sequence uint64, status fleet.InventoryStatus) fleet.Snapshot {
	now := time.Date(2026, time.August, 30, 19, 0, 0, 0, time.UTC)
	return fleet.Snapshot{
		SchemaVersion: fleet.SchemaVersion,
		Sequence:      sequence,
		ObservedAt:    now,
		Platforms: []fleet.PlatformObservation{{
			Platform: fleet.Platform{ID: "jetstream", DisplayName: "Jetstream", Kind: fleet.PlatformKindOpenStack},
			Inventory: fleet.InventoryHealth{
				Status: status, ObservedAt: &now, LastAttemptAt: now, LastSuccessAt: &now,
			},
			Instances: []fleet.InstanceObservation{},
		}},
	}
}
