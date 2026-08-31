package fleetapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/intellisys-stevens/leviathan/internal/fleet"
	"github.com/intellisys-stevens/leviathan/internal/fleetuplink"
	"github.com/intellisys-stevens/leviathan/internal/model"
)

const (
	uplinkProjectID = "c7480d55ef5940079959950eeaee8187"
	uplinkCreatorA  = "nova-user-a"
	uplinkCreatorB  = "nova-user-b"
	uplinkTokenA    = "owner-a-test-token-0123456789abcdef-AAAA"
	uplinkTokenB    = "owner-b-test-token-0123456789abcdef-BBBB"
	uplinkUUIDA     = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	uplinkUUIDB     = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
)

type uplinkPutCall struct {
	projectID    string
	instanceUUID string
	bodyBytes    int64
	sample       fleet.AgentSample
	now          time.Time
}

type stubUplinkRegistry struct {
	mu    sync.Mutex
	calls []uplinkPutCall
	err   error
}

func (registry *stubUplinkRegistry) Put(projectID, instanceUUID string, bodyBytes int64, sample fleet.AgentSample, now time.Time) error {
	registry.mu.Lock()
	defer registry.mu.Unlock()
	registry.calls = append(registry.calls, uplinkPutCall{
		projectID: projectID, instanceUUID: instanceUUID, bodyBytes: bodyBytes, sample: sample, now: now,
	})
	return registry.err
}

func (registry *stubUplinkRegistry) callCount() int {
	registry.mu.Lock()
	defer registry.mu.Unlock()
	return len(registry.calls)
}

func (registry *stubUplinkRegistry) lastCall() uplinkPutCall {
	registry.mu.Lock()
	defer registry.mu.Unlock()
	return registry.calls[len(registry.calls)-1]
}

func TestUplinkAcceptsAuthorizedActiveJetstreamInstance(t *testing.T) {
	now := time.Date(2026, time.August, 30, 22, 0, 0, 0, time.UTC)
	registry := &stubUplinkRegistry{}
	server := newUplinkTestServer(t, uplinkAuthorizedState(), registry, now, 0)
	body := validUplinkBody(t, now)
	request := newUplinkRequest(uplinkUUIDA, uplinkTokenA, body)
	response := httptest.NewRecorder()

	server.ServeHTTP(response, request)

	if response.Code != http.StatusAccepted || !strings.Contains(response.Body.String(), `"status":"accepted"`) {
		t.Fatalf("response = status %d body %s", response.Code, response.Body.String())
	}
	if got := response.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q", got)
	}
	if got := response.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("unexpected CORS header %q", got)
	}
	for name, want := range map[string]string{
		"X-Content-Type-Options": "nosniff",
		"Referrer-Policy":        "no-referrer",
		"X-Frame-Options":        "DENY",
	} {
		if got := response.Header().Get(name); got != want {
			t.Fatalf("%s = %q, want %q", name, got, want)
		}
	}
	if registry.callCount() != 1 {
		t.Fatalf("Put call count = %d, want 1", registry.callCount())
	}
	call := registry.lastCall()
	if call.projectID != uplinkProjectID || call.instanceUUID != uplinkUUIDA || call.bodyBytes != int64(len(body)) || !call.now.Equal(now) {
		t.Fatalf("Put identity/receipt = %+v", call)
	}
	if call.sample.InstanceUUID != uplinkUUIDA || call.sample.CreatorID != uplinkCreatorA || call.sample.Source != fleet.TelemetrySourceLeviathanUplink || !call.sample.ObservedAt.Equal(now) || call.sample.Snapshot.Host.Hostname != "agent-host" {
		t.Fatalf("sample = %+v", call.sample)
	}
	if call.sample.BuildInfo == nil || call.sample.BuildInfo.Version != "v0.3.0" {
		t.Fatalf("buildInfo = %+v", call.sample.BuildInfo)
	}
}

func TestUplinkRejectsAuthenticationAndAuthorizationFailuresWithoutDisclosure(t *testing.T) {
	now := time.Date(2026, time.August, 30, 22, 0, 0, 0, time.UTC)
	body := validUplinkBody(t, now)
	tests := []struct {
		name      string
		state     fleet.Snapshot
		uuid      string
		token     string
		status    int
		configure func(*http.Request)
	}{
		{name: "missing token", state: uplinkAuthorizedState(), uuid: uplinkUUIDA, status: http.StatusUnauthorized},
		{name: "unknown token", state: uplinkAuthorizedState(), uuid: uplinkUUIDA, token: "unknown-test-token-0123456789abcdef-XX", status: http.StatusUnauthorized},
		{name: "overlong token", state: uplinkAuthorizedState(), uuid: uplinkUUIDA, token: strings.Repeat("x", maximumUplinkTokenBytes+1), status: http.StatusUnauthorized},
		{name: "duplicate auth header", state: uplinkAuthorizedState(), uuid: uplinkUUIDA, token: uplinkTokenA, status: http.StatusUnauthorized, configure: func(request *http.Request) {
			request.Header.Add("Authorization", "Bearer "+uplinkTokenA)
		}},
		{name: "cross creator", state: uplinkAuthorizedState(), uuid: uplinkUUIDA, token: uplinkTokenB, status: http.StatusUnauthorized},
		{name: "unknown instance", state: uplinkAuthorizedState(), uuid: uplinkUUIDB, token: uplinkTokenA, status: http.StatusUnauthorized},
		{name: "unmanaged", state: uplinkStateWith(fleet.CloudStateActive, false, true, fleet.InventoryAvailable), uuid: uplinkUUIDA, token: uplinkTokenA, status: http.StatusUnauthorized},
		{name: "probe ineligible", state: uplinkStateWith(fleet.CloudStateActive, true, false, fleet.InventoryAvailable), uuid: uplinkUUIDA, token: uplinkTokenA, status: http.StatusUnauthorized},
		{name: "inactive", state: uplinkStateWith(fleet.CloudStateShelved, true, true, fleet.InventoryAvailable), uuid: uplinkUUIDA, token: uplinkTokenA, status: http.StatusUnauthorized},
		{name: "stale inventory", state: uplinkStateWith(fleet.CloudStateActive, true, true, fleet.InventoryStale), uuid: uplinkUUIDA, token: uplinkTokenA, status: http.StatusUnauthorized},
	}

	var unauthorizedBody string
	var unauthorizedChallenge string
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			registry := &stubUplinkRegistry{}
			server := newUplinkTestServer(t, test.state, registry, now, 0)
			request := newUplinkRequest(test.uuid, test.token, body)
			if test.configure != nil {
				test.configure(request)
			}
			response := httptest.NewRecorder()
			server.ServeHTTP(response, request)
			if response.Code != test.status {
				t.Fatalf("status = %d body %s, want %d", response.Code, response.Body.String(), test.status)
			}
			if registry.callCount() != 0 {
				t.Fatalf("unauthorized request reached registry")
			}
			for _, forbidden := range []string{test.token, uplinkCreatorA, uplinkCreatorB, test.uuid, "unknown-test-token"} {
				if forbidden != "" && strings.Contains(response.Body.String(), forbidden) {
					t.Fatalf("response disclosed protected value %q: %s", forbidden, response.Body.String())
				}
			}
			if test.status == http.StatusUnauthorized {
				challenge := response.Header().Get("WWW-Authenticate")
				if challenge == "" {
					t.Fatal("401 response omitted WWW-Authenticate")
				}
				if unauthorizedBody == "" {
					unauthorizedBody = response.Body.String()
					unauthorizedChallenge = challenge
				} else if response.Body.String() != unauthorizedBody || challenge != unauthorizedChallenge {
					t.Fatalf("authentication and authorization failures had distinguishable shapes: body %q challenge %q", response.Body.String(), challenge)
				}
			}
		})
	}
}

func TestUplinkCreatorCredentialCanClaimAnyEligibleSameCreatorInstance(t *testing.T) {
	now := time.Date(2026, time.August, 30, 22, 0, 0, 0, time.UTC)
	state := uplinkAuthorizedState()
	state.Platforms[0].Instances = append(state.Platforms[0].Instances, fleet.InstanceObservation{
		Instance: fleet.Instance{
			UUID: uplinkUUIDB, Name: "owner-a-second-gpu", CreatorID: uplinkCreatorA,
			CreatorUsername: "owner-a@example.test", CloudState: fleet.CloudStateActive,
		},
		Managed: true, AgentProbeEligible: true, PolicyReason: fleet.PolicyAllowed,
	})
	registry := &stubUplinkRegistry{}
	server := newUplinkTestServer(t, state, registry, now, 0)
	response := httptest.NewRecorder()

	server.ServeHTTP(response, newUplinkRequest(uplinkUUIDB, uplinkTokenA, validUplinkBody(t, now)))

	if response.Code != http.StatusAccepted {
		t.Fatalf("same-creator claim status = %d body=%s", response.Code, response.Body.String())
	}
	call := registry.lastCall()
	if call.instanceUUID != uplinkUUIDB || call.sample.CreatorID != uplinkCreatorA {
		t.Fatalf("same-creator claim identity = %+v", call)
	}
}

func TestUplinkRequiresCanonicalPathAndExactJSONContentType(t *testing.T) {
	now := time.Date(2026, time.August, 30, 22, 0, 0, 0, time.UTC)
	body := validUplinkBody(t, now)
	registry := &stubUplinkRegistry{}
	server := newUplinkTestServer(t, uplinkAuthorizedState(), registry, now, 0)

	for _, instanceUUID := range []string{
		strings.ToUpper(uplinkUUIDA),
		"not-a-uuid",
		uplinkUUIDA + "/extra",
	} {
		request := newUplinkRequest(instanceUUID, uplinkTokenA, body)
		response := httptest.NewRecorder()
		server.ServeHTTP(response, request)
		if response.Code != http.StatusNotFound || response.Header().Get("Location") != "" {
			t.Fatalf("UUID %q response = status %d location %q", instanceUUID, response.Code, response.Header().Get("Location"))
		}
	}

	for _, contentType := range []string{"", "application/json; charset=utf-8", "Application/JSON", "text/plain"} {
		request := newUplinkRequest(uplinkUUIDA, uplinkTokenA, body)
		request.Header.Set("Content-Type", contentType)
		response := httptest.NewRecorder()
		server.ServeHTTP(response, request)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("Content-Type %q status = %d body %s", contentType, response.Code, response.Body.String())
		}
	}

	request := newUplinkRequest(uplinkUUIDA, uplinkTokenA, body)
	request.Header.Set("Content-Encoding", "gzip")
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("encoded body status = %d", response.Code)
	}
	if registry.callCount() != 0 {
		t.Fatalf("invalid transport request reached registry")
	}
}

func TestUplinkStrictEnvelopeRejectsMalformedAndSecretBearingBodies(t *testing.T) {
	now := time.Date(2026, time.August, 30, 22, 0, 0, 0, time.UTC)
	valid := validUplinkBody(t, now)
	duplicate := append([]byte(`{"snapshot":`), mustSnapshotJSON(t, now)...)
	duplicate = append(duplicate, []byte(`,"snapshot":`)...)
	duplicate = append(duplicate, mustSnapshotJSON(t, now)...)
	duplicate = append(duplicate, '}')

	tests := map[string][]byte{
		"empty":            nil,
		"not json":         []byte("raw-body-password-do-not-echo"),
		"array":            []byte(`[]`),
		"missing snapshot": []byte(`{"buildInfo":{}}`),
		"null snapshot":    []byte(`{"snapshot":null}`),
		"unknown field":    []byte(`{"snapshot":{},"credential":"raw-body-password-do-not-echo"}`),
		"nested unknown":   []byte(`{"snapshot":{"schemaVersion":"v1","unexpected":"secret"}}`),
		"duplicate field":  duplicate,
		"trailing json":    append(append([]byte(nil), valid...), []byte(` {}`)...),
	}
	for name, body := range tests {
		t.Run(name, func(t *testing.T) {
			registry := &stubUplinkRegistry{}
			server := newUplinkTestServer(t, uplinkAuthorizedState(), registry, now, 0)
			response := httptest.NewRecorder()
			server.ServeHTTP(response, newUplinkRequest(uplinkUUIDA, uplinkTokenA, body))
			if response.Code != http.StatusBadRequest {
				t.Fatalf("status = %d body %s", response.Code, response.Body.String())
			}
			if registry.callCount() != 0 {
				t.Fatal("malformed envelope reached registry")
			}
			if strings.Contains(response.Body.String(), "password") || strings.Contains(response.Body.String(), "credential") {
				t.Fatalf("response echoed raw body: %s", response.Body.String())
			}
		})
	}
}

func TestUplinkEnforcesBodyLimitForKnownAndUnknownLengths(t *testing.T) {
	now := time.Date(2026, time.August, 30, 22, 0, 0, 0, time.UTC)
	registry := &stubUplinkRegistry{}
	server := newUplinkTestServer(t, uplinkAuthorizedState(), registry, now, 64)
	body := bytes.Repeat([]byte("x"), 65)

	for _, unknownLength := range []bool{false, true} {
		request := newUplinkRequest(uplinkUUIDA, uplinkTokenA, body)
		if unknownLength {
			request.ContentLength = -1
		}
		response := httptest.NewRecorder()
		server.ServeHTTP(response, request)
		if response.Code != http.StatusRequestEntityTooLarge {
			t.Fatalf("unknownLength=%v status = %d body %s", unknownLength, response.Code, response.Body.String())
		}
	}
	if registry.callCount() != 0 {
		t.Fatal("oversize request reached registry")
	}
}

func TestUplinkMapsRegistryErrorsToGenericResponses(t *testing.T) {
	now := time.Date(2026, time.August, 30, 22, 0, 0, 0, time.UTC)
	tests := []struct {
		name   string
		err    error
		status int
	}{
		{name: "replay", err: fleetuplink.ErrReplay, status: http.StatusConflict},
		{name: "capacity", err: fleetuplink.ErrCapacity, status: http.StatusConflict},
		{name: "too large", err: fleetuplink.ErrBodyTooLarge, status: http.StatusRequestEntityTooLarge},
		{name: "old", err: fleetuplink.ErrSampleTooOld, status: http.StatusBadRequest},
		{name: "invalid", err: fleetuplink.ErrInvalidSample, status: http.StatusBadRequest},
		{name: "internal", err: errors.New("database secret failure"), status: http.StatusInternalServerError},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			registry := &stubUplinkRegistry{err: test.err}
			server := newUplinkTestServer(t, uplinkAuthorizedState(), registry, now, 0)
			response := httptest.NewRecorder()
			server.ServeHTTP(response, newUplinkRequest(uplinkUUIDA, uplinkTokenA, validUplinkBody(t, now)))
			if response.Code != test.status {
				t.Fatalf("status = %d body %s, want %d", response.Code, response.Body.String(), test.status)
			}
			if strings.Contains(response.Body.String(), test.err.Error()) || strings.Contains(response.Body.String(), "secret") {
				t.Fatalf("response disclosed registry error: %s", response.Body.String())
			}
		})
	}
}

func TestDashboardNeverExposesUplinkAndUplinkRejectsPreflightAndSlashRedirects(t *testing.T) {
	plain := NewServer(newStubSource(), nil, model.BuildInfo{})
	request := newUplinkRequest(uplinkUUIDA, uplinkTokenA, []byte(`{}`))
	response := httptest.NewRecorder()
	plain.ServeHTTP(response, request)
	if response.Code != http.StatusNotFound || response.Header().Get("Location") != "" {
		t.Fatalf("NewServer unexpectedly enabled uplink: status %d location %q", response.Code, response.Header().Get("Location"))
	}

	now := time.Date(2026, time.August, 30, 22, 0, 0, 0, time.UTC)
	enabled := newUplinkTestServer(t, uplinkAuthorizedState(), &stubUplinkRegistry{}, now, 0)
	for _, target := range []string{
		"/api/fleet/v1/uplink/" + uplinkUUIDA + "/",
		"/api/fleet/v1/uplink",
		"/api/fleet/v1/uplink//" + uplinkUUIDA,
		"/api/fleet/v1/uplink/./" + uplinkUUIDA,
		"/./api/fleet/v1/uplink/" + uplinkUUIDA,
		"/api/fleet/v1/uplink/" + uplinkUUIDA + "?source=agent",
		"/api/fleet/v1/uplink/" + uplinkUUIDA + "?",
		"/api/fleet/v1/uplink/%61aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		"/%61pi/fleet/v1/uplink/" + uplinkUUIDA,
	} {
		request := httptest.NewRequest(http.MethodPost, target, strings.NewReader(`{}`))
		response := httptest.NewRecorder()
		enabled.ServeHTTP(response, request)
		if response.Code != http.StatusNotFound || response.Header().Get("Location") != "" {
			t.Fatalf("POST %s = status %d location %q", target, response.Code, response.Header().Get("Location"))
		}
		assertUplinkResponseHeaders(t, response)
	}
	preflight := httptest.NewRequest(http.MethodOptions, "/api/fleet/v1/uplink/"+uplinkUUIDA, nil)
	preflight.Header.Set("Origin", "https://untrusted.example")
	response = httptest.NewRecorder()
	enabled.ServeHTTP(response, preflight)
	if response.Code != http.StatusMethodNotAllowed || response.Header().Get("Allow") != http.MethodPost || response.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatalf("preflight = status %d CORS %q", response.Code, response.Header().Get("Access-Control-Allow-Origin"))
	}
	assertUplinkResponseHeaders(t, response)
}

func TestUplinkServerExposesOnlyPostIngress(t *testing.T) {
	now := time.Date(2026, time.August, 30, 22, 30, 0, 0, time.UTC)
	server := newUplinkTestServer(t, uplinkAuthorizedState(), &stubUplinkRegistry{}, now, 0)

	accepted := httptest.NewRecorder()
	server.ServeHTTP(accepted, newUplinkRequest(uplinkUUIDA, uplinkTokenA, validUplinkBody(t, now)))
	if accepted.Code != http.StatusAccepted {
		t.Fatalf("valid POST status = %d body %s", accepted.Code, accepted.Body.String())
	}
	assertUplinkResponseHeaders(t, accepted)

	for _, target := range []string{
		"/",
		"/healthz",
		"/platforms",
		"/platforms/jetstream",
		"/fleet",
		"/fleet/jetstream",
		"/assets/app.js",
		"/api/fleet/v1/state",
		"/api/fleet/v1/events",
		"/api/fleet/v1/version",
		"/api/fleet/v1/missing",
		"/api/v1/snapshot",
	} {
		t.Run("hidden_"+strings.ReplaceAll(strings.TrimPrefix(target, "/"), "/", "_"), func(t *testing.T) {
			response := httptest.NewRecorder()
			server.ServeHTTP(response, httptest.NewRequest(http.MethodGet, target, nil))
			if response.Code != http.StatusNotFound || response.Header().Get("Location") != "" {
				t.Fatalf("GET %s = status %d location %q", target, response.Code, response.Header().Get("Location"))
			}
			for _, forbidden := range []string{"schemaVersion", "fleet-v1", "agent-host", "<html", "<main"} {
				if strings.Contains(response.Body.String(), forbidden) {
					t.Fatalf("GET %s disclosed %q: %s", target, forbidden, response.Body.String())
				}
			}
			assertUplinkResponseHeaders(t, response)
		})
	}

	target := "/api/fleet/v1/uplink/" + uplinkUUIDA
	for _, method := range []string{http.MethodGet, http.MethodHead, http.MethodPut, http.MethodPatch, http.MethodDelete, http.MethodOptions, http.MethodTrace} {
		t.Run("method_"+method, func(t *testing.T) {
			request := httptest.NewRequest(method, target, nil)
			request.Header.Set("Origin", "https://untrusted.example")
			response := httptest.NewRecorder()
			server.ServeHTTP(response, request)
			if response.Code != http.StatusMethodNotAllowed || response.Header().Get("Allow") != http.MethodPost {
				t.Fatalf("%s %s = status %d Allow %q", method, target, response.Code, response.Header().Get("Allow"))
			}
			assertUplinkResponseHeaders(t, response)
		})
	}
}

func assertUplinkResponseHeaders(t *testing.T, response *httptest.ResponseRecorder) {
	t.Helper()
	for name, want := range map[string]string{
		"Cache-Control":          "no-store",
		"X-Content-Type-Options": "nosniff",
		"Referrer-Policy":        "no-referrer",
		"X-Frame-Options":        "DENY",
	} {
		if got := response.Header().Get(name); got != want {
			t.Fatalf("%s = %q, want %q", name, got, want)
		}
	}
	if response.Header().Get("Content-Security-Policy") == "" {
		t.Fatal("Content-Security-Policy is empty")
	}
	if response.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatalf("unexpected CORS origin %q", response.Header().Get("Access-Control-Allow-Origin"))
	}
	if response.Header().Get("Location") != "" {
		t.Fatalf("unexpected redirect location %q", response.Header().Get("Location"))
	}
}

func TestUplinkConfigurationRejectsWeakAmbiguousCredentials(t *testing.T) {
	source := newStubSource()
	registry := &stubUplinkRegistry{}
	authorizer := newTestUplinkAuthorizer(t, fleet.Snapshot{})
	tests := []UplinkConfig{
		{},
		{Registry: registry, ProjectID: uplinkProjectID, CreatorTokens: map[string]string{}},
		{Registry: registry, Authorizer: authorizer, ProjectID: "*", CreatorTokens: map[string]string{uplinkCreatorA: uplinkTokenA}},
		{Registry: registry, Authorizer: authorizer, ProjectID: uplinkProjectID, CreatorTokens: map[string]string{"nova-user-*": uplinkTokenA}},
		{Registry: registry, Authorizer: authorizer, ProjectID: uplinkProjectID, CreatorTokens: map[string]string{uplinkCreatorA: "short"}},
		{Registry: registry, Authorizer: authorizer, ProjectID: uplinkProjectID, CreatorTokens: map[string]string{uplinkCreatorA: strings.Repeat("a", maximumUplinkTokenBytes+1)}},
		{Registry: registry, Authorizer: authorizer, ProjectID: uplinkProjectID, CreatorTokens: map[string]string{uplinkCreatorA: uplinkTokenA, uplinkCreatorB: uplinkTokenA}},
		{Registry: registry, Authorizer: authorizer, ProjectID: uplinkProjectID, CreatorTokens: map[string]string{uplinkCreatorA: uplinkTokenA}, MaxBodyBytes: -1},
		{Registry: registry, Authorizer: authorizer, ProjectID: uplinkProjectID, CreatorTokens: map[string]string{uplinkCreatorA: uplinkTokenA}, MaxConcurrentRequests: MaximumUplinkConcurrentRequests + 1},
		{Registry: registry, Authorizer: authorizer, ProjectID: uplinkProjectID, CreatorTokens: map[string]string{uplinkCreatorA: uplinkTokenA}, MaxBodyBytes: MaximumUplinkInflightBytes/MaximumUplinkConcurrentRequests + 1, MaxConcurrentRequests: MaximumUplinkConcurrentRequests},
	}
	for index, config := range tests {
		if _, err := NewUplinkServer(source, config); !errors.Is(err, ErrInvalidUplinkConfig) {
			t.Fatalf("config %d error = %v, want ErrInvalidUplinkConfig", index, err)
		}
	}

	credentials := map[string]string{uplinkCreatorA: uplinkTokenA}
	server, err := NewUplinkServer(source, UplinkConfig{
		Registry: registry, Authorizer: authorizer, ProjectID: uplinkProjectID, CreatorTokens: credentials,
	})
	if err != nil {
		t.Fatalf("NewUplinkServer() error = %v", err)
	}
	credentials[uplinkCreatorA] = uplinkTokenB
	if _, found := server.uplink.tokenDigests[uplinkTokenDigest(uplinkTokenA)]; !found {
		t.Fatal("handler did not retain the original credential digest")
	}
	if _, found := server.uplink.tokenDigests[uplinkTokenDigest(uplinkTokenB)]; found {
		t.Fatal("handler credential changed after caller mutated config map")
	}

	if _, err := NewUplinkServer(source, UplinkConfig{
		Registry: registry, Authorizer: authorizer, ProjectID: uplinkProjectID,
		CreatorTokens:         map[string]string{uplinkCreatorA: uplinkTokenA},
		MaxBodyBytes:          MaximumUplinkInflightBytes / MaximumUplinkConcurrentRequests,
		MaxConcurrentRequests: MaximumUplinkConcurrentRequests,
	}); err != nil {
		t.Fatalf("exact in-flight budget boundary error = %v", err)
	}
}

func TestProjectUplinkAuthorizerBindsExactProjectAndCurrentEligibility(t *testing.T) {
	source := newTestUplinkEligibility(uplinkAuthorizedState())
	authorizer, err := NewProjectUplinkAuthorizer(uplinkProjectID, source)
	if err != nil {
		t.Fatal(err)
	}
	if !authorizer.Authorized(uplinkProjectID, uplinkCreatorA, uplinkUUIDA) {
		t.Fatal("eligible instance was not indexed")
	}
	for _, identity := range []struct{ projectID, creatorID, instanceUUID string }{
		{projectID: "other-project", creatorID: uplinkCreatorA, instanceUUID: uplinkUUIDA},
		{projectID: uplinkProjectID, creatorID: uplinkCreatorB, instanceUUID: uplinkUUIDA},
		{projectID: uplinkProjectID, creatorID: uplinkCreatorA, instanceUUID: uplinkUUIDB},
	} {
		if authorizer.Authorized(identity.projectID, identity.creatorID, identity.instanceUUID) {
			t.Fatalf("unexpected authorization for %+v", identity)
		}
	}
	source.replace(uplinkStateWith(fleet.CloudStateActive, true, true, fleet.InventoryStale))
	if authorizer.Authorized(uplinkProjectID, uplinkCreatorA, uplinkUUIDA) {
		t.Fatal("stale inventory retained an authorization decision")
	}
}

type blockingUplinkRegistry struct {
	started chan struct{}
	release chan struct{}
	calls   atomic.Int32
}

func (registry *blockingUplinkRegistry) Put(string, string, int64, fleet.AgentSample, time.Time) error {
	if registry.calls.Add(1) == 1 {
		close(registry.started)
	}
	<-registry.release
	return nil
}

func TestUplinkConcurrentRequestGateBoundsIngress(t *testing.T) {
	now := time.Date(2026, time.August, 30, 22, 0, 0, 0, time.UTC)
	registry := &blockingUplinkRegistry{started: make(chan struct{}), release: make(chan struct{})}
	source := newStubSource()
	authorizer := newTestUplinkAuthorizer(t, uplinkAuthorizedState())
	server, err := NewUplinkServer(source, UplinkConfig{
		Registry: registry, Authorizer: authorizer, ProjectID: uplinkProjectID,
		CreatorTokens:         map[string]string{uplinkCreatorA: uplinkTokenA},
		MaxConcurrentRequests: 1, Now: func() time.Time { return now },
	})
	if err != nil {
		t.Fatal(err)
	}
	body := validUplinkBody(t, now)
	firstDone := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		response := httptest.NewRecorder()
		server.ServeHTTP(response, newUplinkRequest(uplinkUUIDA, uplinkTokenA, body))
		firstDone <- response
	}()
	<-registry.started
	second := httptest.NewRecorder()
	server.ServeHTTP(second, newUplinkRequest(uplinkUUIDA, uplinkTokenA, body))
	if second.Code != http.StatusTooManyRequests || second.Header().Get("Retry-After") != "1" {
		t.Fatalf("second response = %d headers=%v body=%s", second.Code, second.Header(), second.Body.String())
	}
	close(registry.release)
	if first := <-firstDone; first.Code != http.StatusAccepted {
		t.Fatalf("first response = %d body=%s", first.Code, first.Body.String())
	}
	if registry.calls.Load() != 1 {
		t.Fatalf("registry calls = %d", registry.calls.Load())
	}
}

func newUplinkTestServer(t *testing.T, state fleet.Snapshot, registry UplinkRegistry, now time.Time, maxBodyBytes int64) *Server {
	t.Helper()
	source := newStubSource()
	source.publish(state)
	authorizer := newTestUplinkAuthorizer(t, state)
	server, err := NewUplinkServer(source, UplinkConfig{
		Registry:   registry,
		Authorizer: authorizer,
		ProjectID:  uplinkProjectID,
		CreatorTokens: map[string]string{
			uplinkCreatorA: uplinkTokenA,
			uplinkCreatorB: uplinkTokenB,
		},
		MaxBodyBytes: maxBodyBytes,
		Now:          func() time.Time { return now },
	})
	if err != nil {
		t.Fatalf("NewUplinkServer() error = %v", err)
	}
	return server
}

func newTestUplinkAuthorizer(t *testing.T, state fleet.Snapshot) *ProjectUplinkAuthorizer {
	t.Helper()
	authorizer, err := NewProjectUplinkAuthorizer(uplinkProjectID, newTestUplinkEligibility(state))
	if err != nil {
		t.Fatal(err)
	}
	return authorizer
}

type testUplinkEligibility struct {
	mu       sync.Mutex
	creators map[string]string
}

func newTestUplinkEligibility(state fleet.Snapshot) *testUplinkEligibility {
	source := &testUplinkEligibility{}
	source.replace(state)
	return source
}

func (source *testUplinkEligibility) replace(state fleet.Snapshot) {
	creators := make(map[string]string)
	for _, platform := range state.Platforms {
		if platform.Platform.Kind != fleet.PlatformKindOpenStack || platform.Platform.ID != "jetstream" || platform.Inventory.Status != fleet.InventoryAvailable {
			continue
		}
		for _, observation := range platform.Instances {
			if observation.Instance.CloudState == fleet.CloudStateActive && observation.Managed && observation.AgentProbeEligible {
				creators[observation.Instance.UUID] = observation.Instance.CreatorID
			}
		}
	}
	source.mu.Lock()
	source.creators = creators
	source.mu.Unlock()
}

func (source *testUplinkEligibility) UplinkAuthorized(creatorID, instanceUUID string) bool {
	source.mu.Lock()
	expected, found := source.creators[instanceUUID]
	source.mu.Unlock()
	return found && expected == creatorID
}

func newUplinkRequest(instanceUUID, token string, body []byte) *http.Request {
	request := httptest.NewRequest(http.MethodPost, "/api/fleet/v1/uplink/"+instanceUUID, bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	return request
}

func uplinkAuthorizedState() fleet.Snapshot {
	return uplinkStateWith(fleet.CloudStateActive, true, true, fleet.InventoryAvailable)
}

func uplinkStateWith(cloudState fleet.CloudState, managed, eligible bool, inventory fleet.InventoryStatus) fleet.Snapshot {
	state := testState(7, inventory)
	state.Platforms[0].Instances = []fleet.InstanceObservation{{
		Instance: fleet.Instance{
			UUID: uplinkUUIDA, Name: "owner-a-gpu", CreatorID: uplinkCreatorA,
			CreatorUsername: "owner-a@example.test", CloudState: cloudState,
		},
		Managed: managed, AgentProbeEligible: eligible, PolicyReason: fleet.PolicyAllowed,
	}}
	return state
}

func validUplinkBody(t *testing.T, sampledAt time.Time) []byte {
	t.Helper()
	body, err := json.Marshal(map[string]any{
		"snapshot":  validUplinkSnapshot(sampledAt),
		"buildInfo": model.BuildInfo{Version: "v0.3.0", Commit: "test", BuildDate: "2026-08-30"},
	})
	if err != nil {
		t.Fatalf("json.Marshal() error = %v", err)
	}
	return body
}

func mustSnapshotJSON(t *testing.T, sampledAt time.Time) []byte {
	t.Helper()
	data, err := json.Marshal(validUplinkSnapshot(sampledAt))
	if err != nil {
		t.Fatalf("json.Marshal() error = %v", err)
	}
	return data
}

func validUplinkSnapshot(sampledAt time.Time) model.Snapshot {
	provider := func(name string) model.ProviderState {
		return model.ProviderState{Name: name, Status: model.StatusUnsupported, Message: "not available"}
	}
	return model.Snapshot{
		SchemaVersion: "v1",
		SampledAt:     sampledAt,
		Host:          model.Host{Hostname: "agent-host", OS: "linux", Arch: "amd64"},
		GPUs:          []model.GPU{},
		Processes:     []model.Process{},
		Capabilities: model.Capabilities{
			NVML: provider("nvml"), GPM: provider("gpm"), DCGM: provider("dcgm"), Proc: provider("proc"),
		},
		Diagnostics: []model.Diagnostic{},
	}
}
