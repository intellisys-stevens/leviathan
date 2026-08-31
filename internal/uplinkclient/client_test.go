package uplinkclient

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/intellisys-stevens/leviathan/internal/model"
)

const (
	testInstanceUUID = "11111111-1111-4111-8111-111111111111"
	testToken        = "test-test-test-test-test-test-test-test"
	secretCanary     = "UPLINK_SECRET_CANARY"
)

func TestSendPostsExactEnvelope(t *testing.T) {
	snapshot := validSnapshot()
	buildInfo := &model.BuildInfo{Version: "0.3.0", Commit: "abc123", BuildDate: "2026-08-30T20:00:00Z"}
	var calls atomic.Int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		calls.Add(1)
		if request.Method != http.MethodPost {
			t.Errorf("method = %s", request.Method)
		}
		if request.URL.Path != uplinkPathPrefix+testInstanceUUID || request.URL.RawQuery != "" || request.URL.User != nil {
			t.Errorf("request URL = %#v", request.URL)
		}
		if got := request.Header.Get("Content-Type"); got != "application/json" {
			t.Errorf("Content-Type = %q", got)
		}
		if got := request.Header.Get("Authorization"); got != "Bearer "+testToken {
			t.Errorf("Authorization = %q", got)
		}
		if got := request.Header.Get("Cookie"); got != "" {
			t.Errorf("Cookie = %q", got)
		}
		document, err := io.ReadAll(request.Body)
		if err != nil {
			t.Error(err)
			return
		}
		if request.ContentLength != int64(len(document)) {
			t.Errorf("ContentLength = %d, body = %d", request.ContentLength, len(document))
		}
		var envelope Envelope
		if err := json.Unmarshal(document, &envelope); err != nil {
			t.Error(err)
			return
		}
		if envelope.Snapshot.SchemaVersion != snapshot.SchemaVersion || envelope.Snapshot.Sequence != snapshot.Sequence ||
			!envelope.Snapshot.SampledAt.Equal(snapshot.SampledAt) || envelope.Snapshot.Host != snapshot.Host {
			t.Errorf("snapshot = %+v", envelope.Snapshot)
		}
		if envelope.BuildInfo == nil || *envelope.BuildInfo != *buildInfo {
			t.Errorf("buildInfo = %+v", envelope.BuildInfo)
		}
		writeAcceptedReceipt(writer)
	}))
	defer server.Close()

	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	serverURL, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	jar.SetCookies(serverURL, []*http.Cookie{{Name: "ambient", Value: secretCanary}})
	injected := server.Client()
	injected.Jar = jar
	client, err := New(server.URL+"/", testToken, Options{HTTPClient: injected})
	if err != nil {
		t.Fatal(err)
	}
	if err := client.Send(context.Background(), testInstanceUUID, snapshot, buildInfo); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 1 {
		t.Fatalf("requests = %d", calls.Load())
	}
}

func TestSendOmitsAbsentBuildInfo(t *testing.T) {
	var document []byte
	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		var err error
		document, err = io.ReadAll(request.Body)
		if err != nil {
			t.Error(err)
		}
		writeAcceptedReceipt(writer)
	}))
	defer server.Close()
	client := newTLSClient(t, server, Options{})
	if err := client.Send(context.Background(), testInstanceUUID, validSnapshot(), nil); err != nil {
		t.Fatal(err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(document, &fields); err != nil {
		t.Fatal(err)
	}
	if _, found := fields["buildInfo"]; found {
		t.Fatalf("optional buildInfo was serialized: %s", document)
	}
	if _, found := fields["snapshot"]; !found {
		t.Fatalf("snapshot is missing: %s", document)
	}
}

func TestNewAcceptsOnlyCredentialFreeHTTPSOrigins(t *testing.T) {
	valid := []string{
		"https://hub.example.test",
		"HTTPS://hub.example.test",
		"https://hub.example.test/",
		"https://hub.example.test:8443",
		"https://[::1]:8443/",
	}
	for _, baseURL := range valid {
		t.Run("valid_"+strings.ReplaceAll(baseURL, "/", "_"), func(t *testing.T) {
			if _, err := New(baseURL, testToken, Options{}); err != nil {
				t.Fatalf("New() error = %v", err)
			}
		})
	}

	invalid := []string{
		"",
		"http://hub.example.test",
		"https://user:pass@hub.example.test",
		"https://hub.example.test/path",
		"https://hub.example.test//",
		"https://hub.example.test/%2f",
		"https://hub.example.test?token=" + secretCanary,
		"https://hub.example.test?",
		"https://hub.example.test/#" + secretCanary,
		"https://hub.example.test\\@attacker.example",
		" https://hub.example.test",
		"https://hub.example.test ",
		"https://hub.example.test:",
		"https://hub.example.test:invalid",
	}
	for _, baseURL := range invalid {
		t.Run("invalid_"+strings.ReplaceAll(baseURL, "/", "_"), func(t *testing.T) {
			_, err := New(baseURL, testToken, Options{})
			if !errors.Is(err, ErrInvalidBaseURL) || strings.Contains(err.Error(), secretCanary) || (baseURL != "" && strings.Contains(err.Error(), baseURL)) {
				t.Fatalf("error = %v", err)
			}
		})
	}
}

func TestNewValidatesBearerTokenWithoutLeakingIt(t *testing.T) {
	invalid := []string{
		strings.Repeat("a", MinimumTokenBytes-1),
		strings.Repeat("a", MaximumTokenBytes+1),
		" " + strings.Repeat("a", MinimumTokenBytes),
		strings.Repeat("a", MinimumTokenBytes) + " ",
		strings.Repeat("a", MinimumTokenBytes) + "\ninside",
		strings.Repeat("a", MinimumTokenBytes) + " internal-space",
		strings.Repeat("a", MinimumTokenBytes) + "\x7f",
		strings.Repeat("a", MinimumTokenBytes) + "é",
		strings.Repeat("a", MinimumTokenBytes) + string([]byte{0xff}),
	}
	for _, token := range invalid {
		_, err := New("https://hub.example.test", token, Options{})
		if !errors.Is(err, ErrInvalidToken) || strings.Contains(err.Error(), token) {
			t.Fatalf("error = %v", err)
		}
	}
	for _, token := range []string{strings.Repeat("a", MinimumTokenBytes), strings.Repeat("a", MaximumTokenBytes)} {
		if _, err := New("https://hub.example.test", token, Options{}); err != nil {
			t.Fatalf("boundary token length %d: %v", len(token), err)
		}
	}
}

func TestNewValidatesFiniteOptions(t *testing.T) {
	tests := []Options{
		{HTTPClient: &http.Client{}, Transport: roundTripFunc(func(*http.Request) (*http.Response, error) { return nil, nil })},
		{Timeout: -time.Second},
		{Timeout: MaximumTimeout + time.Nanosecond},
		{MaxRequestBytes: -1},
		{MaxRequestBytes: MaximumRequestBytes + 1},
	}
	for _, options := range tests {
		if _, err := New("https://hub.example.test", testToken, options); !errors.Is(err, ErrInvalidConfig) {
			t.Fatalf("options = %+v, error = %v", options, err)
		}
	}
}

func TestDefaultRequestLimitIsEightMiB(t *testing.T) {
	if DefaultMaxRequestBytes != 8<<20 {
		t.Fatalf("client default = %d", DefaultMaxRequestBytes)
	}
}

func TestSendEnforcesEncodedBodyLimitBeforeRequest(t *testing.T) {
	snapshot := validSnapshot()
	document, err := json.Marshal(Envelope{Snapshot: snapshot})
	if err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		writeAcceptedReceipt(writer)
	}))
	defer server.Close()

	atLimit := newTLSClient(t, server, Options{MaxRequestBytes: int64(len(document))})
	if err := atLimit.Send(context.Background(), testInstanceUUID, snapshot, nil); err != nil {
		t.Fatalf("exact limit: %v", err)
	}
	underLimit := newTLSClient(t, server, Options{MaxRequestBytes: int64(len(document) - 1)})
	if err := underLimit.Send(context.Background(), testInstanceUUID, snapshot, nil); !errors.Is(err, ErrRequestTooLarge) {
		t.Fatalf("undersized limit error = %v", err)
	}
	if calls.Load() != 1 {
		t.Fatalf("requests = %d", calls.Load())
	}
}

func TestSendRejectsInvalidIdentityAndEncodingBeforeRequest(t *testing.T) {
	var calls atomic.Int32
	client, err := New("https://hub.example.test", testToken, Options{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		calls.Add(1)
		return nil, errors.New("unexpected request")
	})})
	if err != nil {
		t.Fatal(err)
	}
	invalidIDs := []string{
		"not-a-uuid",
		"AAAAAAAA-1111-4111-8111-111111111111",
		testInstanceUUID + "/extra",
		"../" + testInstanceUUID,
	}
	for _, instanceUUID := range invalidIDs {
		if err := client.Send(context.Background(), instanceUUID, validSnapshot(), nil); !errors.Is(err, ErrInvalidInstanceUUID) {
			t.Fatalf("UUID %q, error = %v", instanceUUID, err)
		}
	}

	snapshot := validSnapshot()
	notANumber := math.NaN()
	snapshot.GPUs = []model.GPU{{
		Metrics:      model.MetricSet{"bad": {Value: &notANumber}},
		GPUInstances: []model.GPUInstance{},
	}}
	if err := client.Send(context.Background(), testInstanceUUID, snapshot, nil); !errors.Is(err, ErrEncode) {
		t.Fatalf("encoding error = %v", err)
	}
	if calls.Load() != 0 {
		t.Fatalf("requests = %d", calls.Load())
	}
}

func TestSendBlocksRedirectWithoutFollowingIt(t *testing.T) {
	var targetCalls atomic.Int32
	target := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		targetCalls.Add(1)
	}))
	defer target.Close()
	redirector := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		http.Redirect(writer, request, target.URL+"/"+secretCanary, http.StatusTemporaryRedirect)
	}))
	defer redirector.Close()
	client := newTLSClient(t, redirector, Options{})

	err := client.Send(context.Background(), testInstanceUUID, validSnapshot(), nil)
	if !errors.Is(err, ErrRedirectBlocked) || strings.Contains(err.Error(), secretCanary) || strings.Contains(err.Error(), target.URL) {
		t.Fatalf("error = %v", err)
	}
	if targetCalls.Load() != 0 {
		t.Fatalf("redirect target requests = %d", targetCalls.Load())
	}
}

func TestSendSanitizesResponseAndTransportErrorsAndNeverRetries(t *testing.T) {
	t.Run("status", func(t *testing.T) {
		var calls atomic.Int32
		server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
			calls.Add(1)
			writer.WriteHeader(http.StatusInternalServerError)
			_, _ = io.WriteString(writer, secretCanary)
		}))
		defer server.Close()
		client := newTLSClient(t, server, Options{})
		err := client.Send(context.Background(), testInstanceUUID, validSnapshot(), nil)
		if !errors.Is(err, ErrUnexpectedStatus) || strings.Contains(err.Error(), secretCanary) || strings.Contains(err.Error(), server.URL) {
			t.Fatalf("error = %v", err)
		}
		if calls.Load() != 1 {
			t.Fatalf("requests = %d", calls.Load())
		}
	})

	t.Run("transport", func(t *testing.T) {
		transportDetail := "https://hub.example.test/?token=" + secretCanary
		client, err := New("https://hub.example.test", testToken, Options{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			return nil, errors.New(transportDetail)
		})})
		if err != nil {
			t.Fatal(err)
		}
		err = client.Send(context.Background(), testInstanceUUID, validSnapshot(), nil)
		if !errors.Is(err, ErrRequestFailed) || strings.Contains(err.Error(), secretCanary) || strings.Contains(err.Error(), "hub.example.test") || strings.Contains(err.Error(), testToken) {
			t.Fatalf("error = %v", err)
		}
	})
}

func TestSendRequiresExactAcceptedReceipt(t *testing.T) {
	tests := []struct {
		name        string
		status      int
		contentType string
		body        string
		wantErr     error
	}{
		{name: "generic 200", status: http.StatusOK, contentType: "application/json", body: `{"status":"accepted"}`, wantErr: ErrUnexpectedStatus},
		{name: "empty 202", status: http.StatusAccepted, contentType: "application/json", wantErr: ErrInvalidReceipt},
		{name: "wrong content type", status: http.StatusAccepted, contentType: "text/plain", body: `{"status":"accepted"}`, wantErr: ErrInvalidReceipt},
		{name: "wrong status", status: http.StatusAccepted, contentType: "application/json", body: `{"status":"queued"}`, wantErr: ErrInvalidReceipt},
		{name: "unknown field", status: http.StatusAccepted, contentType: "application/json", body: `{"status":"accepted","detail":"secret"}`, wantErr: ErrInvalidReceipt},
		{name: "duplicate status", status: http.StatusAccepted, contentType: "application/json", body: `{"status":"accepted","status":"accepted"}`, wantErr: ErrInvalidReceipt},
		{name: "trailing document", status: http.StatusAccepted, contentType: "application/json", body: `{"status":"accepted"}{}`, wantErr: ErrInvalidReceipt},
		{name: "oversize", status: http.StatusAccepted, contentType: "application/json", body: strings.Repeat("x", int(maximumReceiptBytes)+1), wantErr: ErrInvalidReceipt},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
				if test.contentType != "" {
					writer.Header().Set("Content-Type", test.contentType)
				}
				writer.WriteHeader(test.status)
				_, _ = io.WriteString(writer, test.body)
			}))
			defer server.Close()
			client := newTLSClient(t, server, Options{})
			err := client.Send(context.Background(), testInstanceUUID, validSnapshot(), nil)
			if !errors.Is(err, test.wantErr) || strings.Contains(err.Error(), "secret") || (test.body != "" && strings.Contains(err.Error(), test.body)) {
				t.Fatalf("error = %v, want %v", err, test.wantErr)
			}
		})
	}
}

func TestSendHonorsCallerCancellation(t *testing.T) {
	started := make(chan struct{})
	transport := roundTripFunc(func(request *http.Request) (*http.Response, error) {
		close(started)
		<-request.Context().Done()
		return nil, request.Context().Err()
	})
	client, err := New("https://hub.example.test", testToken, Options{Transport: transport, Timeout: MaximumTimeout})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- client.Send(ctx, testInstanceUUID, validSnapshot(), nil)
	}()
	<-started
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("Send did not honor context cancellation")
	}
}

func TestSendEnforcesClientTimeout(t *testing.T) {
	transport := roundTripFunc(func(request *http.Request) (*http.Response, error) {
		<-request.Context().Done()
		return nil, errors.New("https://hub.example.test/" + secretCanary)
	})
	client, err := New("https://hub.example.test", testToken, Options{Transport: transport, Timeout: 10 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	startedAt := time.Now()
	err = client.Send(context.Background(), testInstanceUUID, validSnapshot(), nil)
	if !errors.Is(err, ErrRequestFailed) || strings.Contains(err.Error(), secretCanary) {
		t.Fatalf("error = %v", err)
	}
	if elapsed := time.Since(startedAt); elapsed > time.Second {
		t.Fatalf("timeout took %s", elapsed)
	}
}

func TestSendRejectsCanceledAndNilContextsWithoutRequest(t *testing.T) {
	var calls atomic.Int32
	client, err := New("https://hub.example.test", testToken, Options{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		calls.Add(1)
		return nil, errors.New("unexpected request")
	})})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := client.Send(ctx, testInstanceUUID, validSnapshot(), nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled context error = %v", err)
	}
	if err := client.Send(nil, testInstanceUUID, validSnapshot(), nil); !errors.Is(err, ErrInvalidConfig) {
		t.Fatalf("nil context error = %v", err)
	}
	if calls.Load() != 0 {
		t.Fatalf("requests = %d", calls.Load())
	}
}

func TestNewDoesNotMutateInjectedClient(t *testing.T) {
	originalRedirect := func(*http.Request, []*http.Request) error { return nil }
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	injected := &http.Client{Timeout: 17 * time.Second, CheckRedirect: originalRedirect, Jar: jar}
	client, err := New("https://hub.example.test", testToken, Options{HTTPClient: injected})
	if err != nil {
		t.Fatal(err)
	}
	if injected.Timeout != 17*time.Second || injected.CheckRedirect == nil || injected.Jar != jar {
		t.Fatal("New mutated the injected HTTP client")
	}
	if client.httpClient.Timeout != DefaultTimeout || client.httpClient.CheckRedirect == nil || client.httpClient.Jar != nil {
		t.Fatalf("enforced client policy = %+v", client.httpClient)
	}
}

func newTLSClient(t *testing.T, server *httptest.Server, options Options) *Client {
	t.Helper()
	if options.HTTPClient == nil && options.Transport == nil {
		options.HTTPClient = server.Client()
	}
	client, err := New(server.URL, testToken, options)
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func writeAcceptedReceipt(writer http.ResponseWriter) {
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(http.StatusAccepted)
	_, _ = io.WriteString(writer, `{"status":"accepted"}`)
}

func validSnapshot() model.Snapshot {
	return model.Snapshot{
		SchemaVersion: "v1",
		Sequence:      7,
		SampledAt:     time.Date(2026, 8, 30, 20, 0, 0, 0, time.UTC),
		Host:          model.Host{Hostname: "gpu-agent-a", OS: "linux", Arch: "amd64"},
		GPUs:          []model.GPU{},
		Processes:     []model.Process{},
		Diagnostics:   []model.Diagnostic{},
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (function roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}
