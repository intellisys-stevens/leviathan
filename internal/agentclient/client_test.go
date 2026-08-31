package agentclient

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/intellisys-stevens/leviathan/internal/fleet"
	"github.com/intellisys-stevens/leviathan/internal/model"
)

const (
	testInstanceUUID  = "11111111-1111-4111-8111-111111111111"
	otherInstanceUUID = "22222222-2222-4222-8222-222222222222"
	testHostname      = "gpu-agent-a"
	secretCanary      = "SUPER_SECRET_CANARY_TOKEN"
)

func TestObserveUsesTrustedBinding(t *testing.T) {
	sampledAt := time.Date(2026, 8, 30, 18, 0, 0, 0, time.UTC)
	requests := make(chan string, 2)
	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet {
			t.Errorf("method = %s", request.Method)
		}
		if request.URL.RawQuery != "" || request.URL.User != nil {
			t.Errorf("unsafe request URL = %#v", request.URL)
		}
		requests <- request.URL.Path
		writer.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/leviathan/api/v1/snapshot":
			_ = json.NewEncoder(writer).Encode(validSnapshot(sampledAt, testHostname))
		case "/leviathan/api/v1/version":
			_ = json.NewEncoder(writer).Encode(model.BuildInfo{Version: "0.2.0", Commit: "abc123", BuildDate: "2026-08-30T18:00:00Z"})
		default:
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()

	source := newTLSSource(t, server, map[string]Binding{
		testInstanceUUID: {BaseURL: server.URL + "/leviathan/", ExpectedHostname: testHostname},
	}, Options{})
	sample, err := source.Observe(context.Background(), fleet.Instance{UUID: testInstanceUUID, Name: "untrusted inventory name"})
	if err != nil {
		t.Fatal(err)
	}
	if sample.InstanceUUID != testInstanceUUID {
		t.Fatalf("instance UUID = %q", sample.InstanceUUID)
	}
	if sample.Snapshot.SchemaVersion != "v1" || sample.Snapshot.Host.Hostname != testHostname {
		t.Fatalf("snapshot = %+v", sample.Snapshot)
	}
	if !sample.ObservedAt.Equal(sampledAt) || sample.BuildInfo == nil || sample.BuildInfo.Version != "0.2.0" {
		t.Fatalf("sample = %+v", sample)
	}
	close(requests)
	var got []string
	for requestPath := range requests {
		got = append(got, requestPath)
	}
	if strings.Join(got, ",") != "/leviathan/api/v1/snapshot,/leviathan/api/v1/version" {
		t.Fatalf("paths = %v", got)
	}
}

func TestObserveRejectsUnknownUUIDWithoutRequest(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { calls.Add(1) }))
	defer server.Close()
	source := newTLSSource(t, server, map[string]Binding{
		testInstanceUUID: {BaseURL: server.URL, ExpectedHostname: testHostname},
	}, Options{})

	sample, err := source.Observe(context.Background(), fleet.Instance{UUID: otherInstanceUUID})
	if !errors.Is(err, ErrUnknownBinding) || sample.InstanceUUID != "" {
		t.Fatalf("sample=%+v err=%v", sample, err)
	}
	if calls.Load() != 0 {
		t.Fatalf("requests = %d", calls.Load())
	}
}

func TestObserveRejectsSnapshotIdentityBeforeAssigningUUID(t *testing.T) {
	tests := []struct {
		name     string
		snapshot model.Snapshot
		wantErr  error
	}{
		{name: "hostname", snapshot: validSnapshot(time.Now(), "different-host"), wantErr: ErrSnapshotHostMismatch},
		{name: "schema", snapshot: func() model.Snapshot {
			value := validSnapshot(time.Now(), testHostname)
			value.SchemaVersion = "v2"
			return value
		}(), wantErr: ErrIncompatibleSchema},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var versionCalls atomic.Int32
			server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				writer.Header().Set("Content-Type", "application/json")
				if request.URL.Path == "/api/v1/version" {
					versionCalls.Add(1)
				}
				_ = json.NewEncoder(writer).Encode(test.snapshot)
			}))
			defer server.Close()
			source := newTLSSource(t, server, map[string]Binding{
				testInstanceUUID: {BaseURL: server.URL, ExpectedHostname: testHostname},
			}, Options{})

			sample, err := source.Observe(context.Background(), fleet.Instance{UUID: testInstanceUUID})
			if !errors.Is(err, test.wantErr) || sample.InstanceUUID != "" {
				t.Fatalf("sample=%+v err=%v", sample, err)
			}
			if versionCalls.Load() != 0 {
				t.Fatalf("version requests = %d", versionCalls.Load())
			}
		})
	}
}

func TestObserveRejectsIncompleteSnapshotContainers(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(map[string]any)
	}{
		{name: "missing gpus", mutate: func(document map[string]any) { delete(document, "gpus") }},
		{name: "null processes", mutate: func(document map[string]any) { document["processes"] = nil }},
		{name: "missing capability provider", mutate: func(document map[string]any) {
			delete(document["capabilities"].(map[string]any), "proc")
		}},
		{name: "null nested gpu instances", mutate: func(document map[string]any) {
			document["gpus"].([]any)[0].(map[string]any)["gpuInstances"] = nil
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			snapshot := validSnapshot(time.Now().UTC(), testHostname)
			snapshot.GPUs = []model.GPU{{
				UUID: "GPU-synthetic", Name: "Synthetic", Metrics: model.MetricSet{}, GPUInstances: []model.GPUInstance{},
			}}
			encoded, err := json.Marshal(snapshot)
			if err != nil {
				t.Fatal(err)
			}
			var document map[string]any
			if err := json.Unmarshal(encoded, &document); err != nil {
				t.Fatal(err)
			}
			test.mutate(document)

			var versionCalls atomic.Int32
			server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				writer.Header().Set("Content-Type", "application/json")
				if request.URL.Path == "/api/v1/version" {
					versionCalls.Add(1)
					_ = json.NewEncoder(writer).Encode(model.BuildInfo{})
					return
				}
				_ = json.NewEncoder(writer).Encode(document)
			}))
			defer server.Close()
			source := newTLSSource(t, server, map[string]Binding{
				testInstanceUUID: {BaseURL: server.URL, ExpectedHostname: testHostname},
			}, Options{})

			sample, err := source.Observe(context.Background(), fleet.Instance{UUID: testInstanceUUID})
			if !errors.Is(err, ErrInvalidResponse) || sample.InstanceUUID != "" {
				t.Fatalf("sample=%+v err=%v", sample, err)
			}
			if versionCalls.Load() != 0 {
				t.Fatalf("version requests = %d", versionCalls.Load())
			}
		})
	}
}

func TestNewRejectsUnsafeBindings(t *testing.T) {
	tests := []struct {
		name    string
		uuid    string
		binding Binding
	}{
		{name: "invalid uuid", uuid: "not-a-uuid", binding: Binding{BaseURL: "https://agent.example", ExpectedHostname: testHostname}},
		{name: "http", uuid: testInstanceUUID, binding: Binding{BaseURL: "http://agent.example", ExpectedHostname: testHostname}},
		{name: "userinfo", uuid: testInstanceUUID, binding: Binding{BaseURL: "https://user:pass@agent.example", ExpectedHostname: testHostname}},
		{name: "query", uuid: testInstanceUUID, binding: Binding{BaseURL: "https://agent.example?token=" + secretCanary, ExpectedHostname: testHostname}},
		{name: "force query", uuid: testInstanceUUID, binding: Binding{BaseURL: "https://agent.example?", ExpectedHostname: testHostname}},
		{name: "fragment", uuid: testInstanceUUID, binding: Binding{BaseURL: "https://agent.example/#fragment", ExpectedHostname: testHostname}},
		{name: "unclean path", uuid: testInstanceUUID, binding: Binding{BaseURL: "https://agent.example/a/../b", ExpectedHostname: testHostname}},
		{name: "blank hostname", uuid: testInstanceUUID, binding: Binding{BaseURL: "https://agent.example", ExpectedHostname: ""}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := New(map[string]Binding{test.uuid: test.binding}, Options{})
			if err == nil || strings.Contains(err.Error(), secretCanary) {
				t.Fatalf("error = %v", err)
			}
		})
	}
}

func TestObserveBlocksRedirect(t *testing.T) {
	var redirectedCalls atomic.Int32
	target := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { redirectedCalls.Add(1) }))
	defer target.Close()
	redirector := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		http.Redirect(writer, request, target.URL+"/"+secretCanary, http.StatusFound)
	}))
	defer redirector.Close()
	source := newTLSSource(t, redirector, map[string]Binding{
		testInstanceUUID: {BaseURL: redirector.URL, ExpectedHostname: testHostname},
	}, Options{})

	_, err := source.Observe(context.Background(), fleet.Instance{UUID: testInstanceUUID})
	if !errors.Is(err, ErrRedirectBlocked) || strings.Contains(err.Error(), secretCanary) {
		t.Fatalf("error = %v", err)
	}
	if redirectedCalls.Load() != 0 {
		t.Fatalf("redirect target requests = %d", redirectedCalls.Load())
	}
}

func TestObserveBoundsResponses(t *testing.T) {
	tests := []struct {
		name     string
		path     string
		options  Options
		response func() any
	}{
		{
			name: "snapshot", path: "/api/v1/snapshot", options: Options{MaxSnapshotBytes: 128},
			response: func() any {
				value := validSnapshot(time.Now(), testHostname)
				value.Host.OS = strings.Repeat("x", 256)
				return value
			},
		},
		{
			name: "version", path: "/api/v1/version", options: Options{MaxVersionBytes: 32},
			response: func() any { return model.BuildInfo{Version: strings.Repeat("x", 128)} },
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				writer.Header().Set("Content-Type", "application/json")
				if request.URL.Path == test.path {
					_ = json.NewEncoder(writer).Encode(test.response())
					return
				}
				_ = json.NewEncoder(writer).Encode(validSnapshot(time.Now(), testHostname))
			}))
			defer server.Close()
			source := newTLSSource(t, server, map[string]Binding{
				testInstanceUUID: {BaseURL: server.URL, ExpectedHostname: testHostname},
			}, test.options)
			_, err := source.Observe(context.Background(), fleet.Instance{UUID: testInstanceUUID})
			if !errors.Is(err, ErrResponseTooLarge) {
				t.Fatalf("error = %v", err)
			}
		})
	}
}

func TestErrorsNeverLeakResponseOrTransportDetails(t *testing.T) {
	tests := []struct {
		name      string
		handler   http.Handler
		transport http.RoundTripper
		wantErr   error
	}{
		{
			name: "http body",
			handler: http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
				writer.WriteHeader(http.StatusInternalServerError)
				_, _ = io.WriteString(writer, secretCanary)
			}),
			wantErr: ErrUnexpectedStatus,
		},
		{
			name: "malformed body",
			handler: http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
				writer.Header().Set("Content-Type", "application/json")
				_, _ = fmt.Fprintf(writer, `{"token":%q`, secretCanary)
			}),
			wantErr: ErrInvalidResponse,
		},
		{
			name: "transport",
			transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
				return nil, errors.New("https://agent.example/?token=" + secretCanary)
			}),
			wantErr: ErrAgentUnavailable,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var server *httptest.Server
			baseURL := "https://agent.example"
			options := Options{Transport: test.transport}
			if test.handler != nil {
				server = httptest.NewTLSServer(test.handler)
				defer server.Close()
				baseURL = server.URL
				options.Transport = server.Client().Transport
			}
			source, err := New(map[string]Binding{
				testInstanceUUID: {BaseURL: baseURL, ExpectedHostname: testHostname},
			}, options)
			if err != nil {
				t.Fatal(err)
			}
			_, err = source.Observe(context.Background(), fleet.Instance{UUID: testInstanceUUID})
			if !errors.Is(err, test.wantErr) || strings.Contains(err.Error(), secretCanary) || strings.Contains(err.Error(), baseURL) {
				t.Fatalf("error = %v", err)
			}
		})
	}
}

func TestObserveHonorsContextCancellation(t *testing.T) {
	started := make(chan struct{})
	server := httptest.NewTLSServer(http.HandlerFunc(func(_ http.ResponseWriter, request *http.Request) {
		close(started)
		<-request.Context().Done()
	}))
	defer server.Close()
	source := newTLSSource(t, server, map[string]Binding{
		testInstanceUUID: {BaseURL: server.URL, ExpectedHostname: testHostname},
	}, Options{Timeout: time.Minute})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := source.Observe(ctx, fleet.Instance{UUID: testInstanceUUID})
		done <- err
	}()
	<-started
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("Observe did not honor context cancellation")
	}
}

func TestNewDoesNotMutateInjectedClient(t *testing.T) {
	originalRedirect := func(*http.Request, []*http.Request) error { return nil }
	client := &http.Client{Timeout: 17 * time.Second, CheckRedirect: originalRedirect}
	_, err := New(nil, Options{HTTPClient: client})
	if err != nil {
		t.Fatal(err)
	}
	if client.Timeout != 17*time.Second {
		t.Fatalf("injected client timeout was mutated: %s", client.Timeout)
	}
	if client.CheckRedirect == nil {
		t.Fatal("injected client redirect function was mutated")
	}
}

func TestNewAppliesDefaultTimeout(t *testing.T) {
	source, err := New(nil, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if source.client.Timeout != DefaultTimeout {
		t.Fatalf("timeout = %s, want %s", source.client.Timeout, DefaultTimeout)
	}
}

func newTLSSource(t *testing.T, server *httptest.Server, bindings map[string]Binding, options Options) *Source {
	t.Helper()
	if options.HTTPClient == nil && options.Transport == nil {
		options.Transport = server.Client().Transport
	}
	source, err := New(bindings, options)
	if err != nil {
		t.Fatal(err)
	}
	return source
}

func validSnapshot(sampledAt time.Time, hostname string) model.Snapshot {
	return model.Snapshot{
		SchemaVersion: "v1",
		Sequence:      7,
		SampledAt:     sampledAt,
		Host:          model.Host{Hostname: hostname, OS: "linux", Arch: "amd64"},
		GPUs:          []model.GPU{},
		Processes:     []model.Process{},
		Diagnostics:   []model.Diagnostic{},
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (function roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}
