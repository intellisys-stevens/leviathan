package openstackinventory

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gophercloud/gophercloud/v2"
	"github.com/intellisys-stevens/miglens/internal/fleet"
)

const (
	testProjectID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	testInstanceA = "11111111-1111-4111-8111-111111111111"
	testInstanceB = "22222222-2222-4222-8222-222222222222"
	testCanary    = "SECRET-CANARY-MUST-NEVER-LEAK"
)

func TestListUsesProjectScopedMarkerPaginationAndMapsOnlySafeFields(t *testing.T) {
	var server *httptest.Server
	var mu sync.Mutex
	requests := make([]url.Values, 0, 2)
	server = httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet {
			t.Errorf("method = %s, want GET", request.Method)
		}
		if request.URL.Path != "/v2.1/"+testProjectID+"/servers/detail" {
			t.Errorf("path = %q", request.URL.Path)
		}
		if request.URL.Query().Has("all_tenants") {
			t.Error("request unexpectedly included all_tenants")
		}
		mu.Lock()
		requests = append(requests, request.URL.Query())
		mu.Unlock()
		writer.Header().Set("Content-Type", "application/json")

		if request.URL.Query().Get("marker") == "" {
			writePage(t, writer, []map[string]any{testServerPayload(testInstanceA, "user-a", " Alpha\nnode ", "ACTIVE")}, server.URL+"/steal?all_tenants=true&marker="+testInstanceA)
			return
		}
		if request.URL.Query().Get("marker") != testInstanceA {
			t.Errorf("marker = %q, want %q", request.URL.Query().Get("marker"), testInstanceA)
		}
		writePage(t, writer, []map[string]any{testServerPayload(testInstanceB, "user-b", "Bravo", "SHELVED_OFFLOADED")}, "")
	}))
	t.Cleanup(server.Close)

	resolverCalls := make(map[string]int)
	resolver := CreatorResolverFunc(func(_ context.Context, userID string) (string, error) {
		resolverCalls[userID]++
		if userID == "user-a" {
			return "owner-a@example.test", nil
		}
		return "", errors.New("identity failure " + testCanary)
	})
	source := sourceForTestServer(t, server, 10, resolver)
	observation, err := source.List(context.Background())
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if len(observation.Instances) != 2 {
		t.Fatalf("instances = %d, want 2", len(observation.Instances))
	}
	if observation.Instances[0].Name != "Alpha node" || observation.Instances[0].CreatorUsername != "owner-a@example.test" {
		t.Fatalf("first instance = %+v", observation.Instances[0])
	}
	if observation.Instances[0].CloudState != fleet.CloudStateActive || observation.Instances[1].CloudState != fleet.CloudStateShelvedOffloaded {
		t.Fatalf("cloud states = %q, %q", observation.Instances[0].CloudState, observation.Instances[1].CloudState)
	}
	if observation.Instances[1].CreatorUsername != "fallback-owner-b@example.test" {
		t.Fatalf("metadata creator fallback = %q", observation.Instances[1].CreatorUsername)
	}
	if resolverCalls["user-a"] != 1 || resolverCalls["user-b"] != 1 {
		t.Fatalf("resolver calls = %v", resolverCalls)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(requests) != 2 || requests[0].Get("marker") != "" || requests[1].Get("marker") != testInstanceA {
		t.Fatalf("pagination queries = %v", requests)
	}
	if requests[1].Has("all_tenants") {
		t.Fatalf("server-provided next URL influenced query: %v", requests[1])
	}

	encoded, err := json.Marshal(observation)
	if err != nil {
		t.Fatalf("json.Marshal() error = %v", err)
	}
	text := string(encoded)
	for _, forbidden := range []string{testCanary, "user-a", "user-b", "metadata", "tags", "adminPass", "fault", "key_name", "addresses", "links", server.URL} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("inventory retained forbidden value %q: %s", forbidden, text)
		}
	}
}

func TestListRejectsTenantMismatchAsAnAtomicFailure(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		outside := testServerPayload(testInstanceB, "user-b", "Outside", "ACTIVE")
		outside["tenant_id"] = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
		writePage(t, writer, []map[string]any{
			testServerPayload(testInstanceA, "user-a", "Inside", "ACTIVE"),
			outside,
		}, "")
	}))
	t.Cleanup(server.Close)

	observation, err := sourceForTestServer(t, server, 10, EmptyCreatorResolver{}).List(context.Background())
	if !errors.Is(err, errTenantMismatch) {
		t.Fatalf("List() error = %v, want tenant mismatch", err)
	}
	if !observation.ObservedAt.IsZero() || len(observation.Instances) != 0 {
		t.Fatalf("partial observation escaped tenant mismatch: %+v", observation)
	}
}

func TestListEnforcesTotalInstanceLimitAcrossPages(t *testing.T) {
	var server *httptest.Server
	server = httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Query().Get("marker") == "" {
			writePage(t, writer, []map[string]any{testServerPayload(testInstanceA, "user-a", "One", "ACTIVE")}, server.URL+"/next")
			return
		}
		writePage(t, writer, []map[string]any{testServerPayload(testInstanceB, "user-b", "Two", "ACTIVE")}, server.URL+"/more")
	}))
	t.Cleanup(server.Close)

	observation, err := sourceForTestServer(t, server, 1, EmptyCreatorResolver{}).List(context.Background())
	if !errors.Is(err, errInstanceLimit) {
		t.Fatalf("List() error = %v, want instance limit", err)
	}
	if len(observation.Instances) != 0 {
		t.Fatal("partial over-limit inventory was returned")
	}
}

func TestListRedactsUpstreamResponseBody(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusInternalServerError)
		_, _ = writer.Write([]byte(`{"error":"` + testCanary + `"}`))
	}))
	t.Cleanup(server.Close)

	observation, err := sourceForTestServer(t, server, 10, EmptyCreatorResolver{}).List(context.Background())
	if err == nil {
		t.Fatal("List() error = nil, want upstream failure")
	}
	if strings.Contains(err.Error(), testCanary) || strings.Contains(err.Error(), server.URL) {
		t.Fatalf("List() leaked upstream response or endpoint: %v", err)
	}
	if len(observation.Instances) != 0 {
		t.Fatal("failed inventory returned instances")
	}
}

func TestMapServerStatusAndCreatorBoundaries(t *testing.T) {
	tests := map[string]fleet.CloudState{
		"ACTIVE":            fleet.CloudStateActive,
		"SHUTOFF":           fleet.CloudStateShutoff,
		"SHELVED":           fleet.CloudStateShelved,
		"SHELVED_OFFLOADED": fleet.CloudStateShelvedOffloaded,
		"BUILD":             fleet.CloudStateBuilding,
		"PAUSED":            fleet.CloudStatePaused,
		"SUSPENDED":         fleet.CloudStateSuspended,
		"ERROR":             fleet.CloudStateError,
		"REBOOT":            fleet.CloudStateUnknown,
		testCanary:          fleet.CloudStateUnknown,
	}
	for raw, expected := range tests {
		t.Run(raw, func(t *testing.T) {
			mapped := mapServer(serverValue(testInstanceA, "raw-user-id", "node", raw), "trusted-user")
			if mapped.CloudState != expected {
				t.Fatalf("CloudState = %q, want %q", mapped.CloudState, expected)
			}
			if mapped.CreatorUsername != "trusted-user" {
				t.Fatalf("creator mapping username = %q", mapped.CreatorUsername)
			}
			if strings.Contains(mapped.RawCloudState, testCanary) {
				t.Fatalf("raw state retained canary: %q", mapped.RawCloudState)
			}
		})
	}
}

func TestCreatorMetadataUsesOnlyExactBoundedUsername(t *testing.T) {
	var server novaServer
	payload := `{
		"id":"` + testInstanceA + `",
		"metadata":{
			"exoCreatorUsername":" owner@example.test ",
			"ExoCreatorUsername":"` + testCanary + `",
			"other":"` + testCanary + `"
		}
	}`
	if err := json.Unmarshal([]byte(payload), &server); err != nil {
		t.Fatalf("json.Unmarshal() error = %v", err)
	}
	if got := normalizedCreatorUsername(server.Metadata.username); got != "owner@example.test" {
		t.Fatalf("creator username = %q", got)
	}
	for _, invalid := range []string{"bad\nuser", strings.Repeat("x", 257), " \t "} {
		if got := normalizedCreatorUsername(invalid); got != "" {
			t.Fatalf("normalizedCreatorUsername(%q) = %q, want empty", invalid, got)
		}
	}
	encoded, err := json.Marshal(mapServer(server, normalizedCreatorUsername(server.Metadata.username)))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), testCanary) || strings.Contains(string(encoded), "metadata") {
		t.Fatalf("mapped instance retained unapproved metadata: %s", encoded)
	}
}

func TestNewFromEnvAuthenticatesProjectScopedAndSelectsAllowedComputeEndpoint(t *testing.T) {
	var server *httptest.Server
	server = httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/v3/auth/tokens":
			if request.Method != http.MethodPost {
				t.Errorf("auth method = %s", request.Method)
			}
			var body struct {
				Auth struct {
					Scope struct {
						Project struct {
							ID string `json:"id"`
						} `json:"project"`
					} `json:"scope"`
				} `json:"auth"`
			}
			if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
				t.Errorf("decode auth request: %v", err)
			}
			if body.Auth.Scope.Project.ID != testProjectID {
				t.Errorf("auth project = %q", body.Auth.Scope.Project.ID)
			}
			writer.Header().Set("Content-Type", "application/json")
			writer.Header().Set("X-Subject-Token", "test-token")
			writer.WriteHeader(http.StatusCreated)
			writeTokenResponse(t, writer, server.URL)
		case "/v2.1/" + testProjectID + "/servers/detail":
			if request.URL.Query().Has("all_tenants") {
				t.Error("authenticated list used all_tenants")
			}
			writePage(t, writer, []map[string]any{testServerPayload(testInstanceA, "raw-user", "Node", "ACTIVE")}, "")
		default:
			http.NotFound(writer, request)
		}
	}))
	t.Cleanup(server.Close)
	parsed, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}

	setAuthEnvironment(t, server.URL+"/v3")
	source, err := NewFromEnv(context.Background(), Config{
		AllowedProjectIDs:   []string{testProjectID},
		AllowedAuthHosts:    []string{parsed.Host},
		AllowedComputeHosts: []string{parsed.Host},
		MaxInstances:        10,
		RequestTimeout:      2 * time.Second,
		HTTPClient:          server.Client(),
		Clock: func() time.Time {
			return time.Date(2026, time.August, 30, 20, 0, 0, 0, time.UTC)
		},
	})
	if err != nil {
		t.Fatalf("NewFromEnv() error = %v", err)
	}
	observation, err := source.List(context.Background())
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if len(observation.Instances) != 1 || observation.Instances[0].CreatorUsername != "fallback-owner@example.test" {
		t.Fatalf("default creator mapping = %+v", observation.Instances)
	}
	encoded, _ := json.Marshal(observation)
	if strings.Contains(string(encoded), "raw-user") || strings.Contains(string(encoded), testCanary) {
		t.Fatalf("authenticated inventory leaked raw identity or credential: %s", encoded)
	}
}

func TestNewFromEnvRejectsNonAllowlistedProjectBeforeAuthentication(t *testing.T) {
	setAuthEnvironment(t, "https://identity.example.test/v3")
	_, err := NewFromEnv(context.Background(), Config{
		AllowedProjectIDs:   []string{"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},
		AllowedAuthHosts:    []string{"identity.example.test"},
		AllowedComputeHosts: []string{"compute.example.test"},
	})
	if err == nil || !strings.Contains(err.Error(), "not allowlisted") {
		t.Fatalf("NewFromEnv() error = %v, want project allowlist rejection", err)
	}
}

func sourceForTestServer(t *testing.T, server *httptest.Server, maxInstances int, resolver CreatorResolver) *Source {
	t.Helper()
	parsed, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	config, err := (Config{
		AllowedProjectIDs:   []string{testProjectID},
		AllowedAuthHosts:    []string{parsed.Host},
		AllowedComputeHosts: []string{parsed.Host},
		MaxInstances:        maxInstances,
		RequestTimeout:      2 * time.Second,
		HTTPClient:          server.Client(),
		CreatorResolver:     resolver,
		Clock: func() time.Time {
			return time.Date(2026, time.August, 30, 19, 0, 0, 0, time.UTC)
		},
	}).normalized()
	if err != nil {
		t.Fatalf("test config: %v", err)
	}
	provider := &gophercloud.ProviderClient{}
	provider.UseTokenLock()
	provider.SetToken("test-token")
	provider.HTTPClient = securedHTTPClient(config, &url.URL{Scheme: "https", Host: parsed.Host, Path: "/v3"})
	compute := &gophercloud.ServiceClient{
		ProviderClient: provider,
		Endpoint:       server.URL + "/v2.1/" + testProjectID + "/",
		Type:           "compute",
	}
	return newSource(compute, testProjectID, config)
}

func testServerPayload(id, userID, name, status string) map[string]any {
	return map[string]any{
		"id":        id,
		"tenant_id": testProjectID,
		"user_id":   userID,
		"name":      name,
		"status":    status,
		"flavor":    map[string]any{"id": "g3.medium", "secret": testCanary},
		"metadata": map[string]string{
			"exoCreatorUsername": " " + metadataCreator(userID) + " ",
			"secret":             testCanary,
		},
		"tags":         []string{testCanary},
		"adminPass":    testCanary,
		"fault":        map[string]any{"message": testCanary, "details": testCanary},
		"key_name":     testCanary,
		"addresses":    map[string]any{"private": []any{testCanary}},
		"links":        []map[string]string{{"rel": "self", "href": "https://endpoint.invalid/" + testCanary}},
		"config_drive": "",
	}
}

func metadataCreator(userID string) string {
	switch userID {
	case "user-a":
		return "fallback-owner-a@example.test"
	case "user-b":
		return "fallback-owner-b@example.test"
	default:
		return "fallback-owner@example.test"
	}
}

func serverValue(id, userID, name, status string) novaServer {
	server := novaServer{ID: id, TenantID: testProjectID, UserID: userID, Name: name, Status: status}
	server.Flavor.ID = "g3.medium"
	return server
}

func writePage(t *testing.T, writer http.ResponseWriter, payload []map[string]any, next string) {
	t.Helper()
	links := []map[string]string{}
	if next != "" {
		links = append(links, map[string]string{"rel": "next", "href": next})
	}
	writer.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(writer).Encode(map[string]any{"servers": payload, "servers_links": links}); err != nil {
		t.Errorf("encode server page: %v", err)
	}
}

func setAuthEnvironment(t *testing.T, authURL string) {
	t.Helper()
	values := map[string]string{
		"OS_AUTH_URL":                      authURL,
		"OS_USERNAME":                      "reader",
		"OS_USERID":                        "",
		"OS_PASSWORD":                      testCanary,
		"OS_PASSCODE":                      "",
		"OS_PROJECT_ID":                    testProjectID,
		"OS_PROJECT_NAME":                  "",
		"OS_TENANT_ID":                     "",
		"OS_TENANT_NAME":                   "",
		"OS_DOMAIN_ID":                     "",
		"OS_DOMAIN_NAME":                   "Default",
		"OS_APPLICATION_CREDENTIAL_ID":     "",
		"OS_APPLICATION_CREDENTIAL_NAME":   "",
		"OS_APPLICATION_CREDENTIAL_SECRET": "",
		"OS_SYSTEM_SCOPE":                  "",
		"OS_REGION_NAME":                   "RegionOne",
		"OS_INTERFACE":                     "public",
	}
	for name, value := range values {
		t.Setenv(name, value)
	}
}

func writeTokenResponse(t *testing.T, writer http.ResponseWriter, endpoint string) {
	t.Helper()
	response := map[string]any{
		"token": map[string]any{
			"methods":    []string{"password"},
			"expires_at": "2099-08-30T21:00:00.000000Z",
			"issued_at":  "2026-08-30T20:00:00.000000Z",
			"project": map[string]any{
				"id": testProjectID, "name": "test-project",
				"domain": map[string]string{"id": "default", "name": "Default"},
			},
			"user": map[string]any{
				"id": "reader-id", "name": "reader",
				"domain": map[string]string{"id": "default", "name": "Default"},
			},
			"roles": []any{},
			"catalog": []map[string]any{{
				"id": "compute-service", "name": "nova", "type": "compute",
				"endpoints": []map[string]string{{
					"id": "compute-public", "interface": "public", "region": "RegionOne", "region_id": "RegionOne",
					"url": endpoint + "/v2.1/" + testProjectID + "/",
				}},
			}},
		},
	}
	if err := json.NewEncoder(writer).Encode(response); err != nil {
		t.Errorf("encode token response: %v", err)
	}
}

func TestReadOnlyTransportRejectsAllTenantsAndMutations(t *testing.T) {
	transport := &readOnlyTransport{
		base:         http.DefaultTransport,
		authHost:     "identity.example.test",
		authHosts:    hostSet([]string{"identity.example.test"}),
		computeHosts: hostSet([]string{"compute.example.test"}),
	}
	for _, rawRequest := range []string{
		"GET https://compute.example.test/v2/servers/detail?all_tenants=true",
		"POST https://compute.example.test/v2/servers",
		"DELETE https://compute.example.test/v2/servers/" + testInstanceA,
		"GET http://compute.example.test/v2/servers/detail",
		"GET https://untrusted.example.test/v2/servers/detail",
	} {
		t.Run(rawRequest, func(t *testing.T) {
			parts := strings.SplitN(rawRequest, " ", 2)
			request, err := http.NewRequest(parts[0], parts[1], nil)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := transport.RoundTrip(request); err == nil {
				t.Fatal("RoundTrip() error = nil, want rejection")
			}
		})
	}
}
