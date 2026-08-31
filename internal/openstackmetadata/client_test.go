package openstackmetadata

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const (
	testInstanceUUID = "11111111-2222-4333-8444-555555555555"
	secretCanary     = "METADATA_SECRET_CANARY"
)

func TestInstanceUUIDUsesOnlyExactMetadataEndpoint(t *testing.T) {
	var calls atomic.Int32
	transport := roundTripFunc(func(request *http.Request) (*http.Response, error) {
		calls.Add(1)
		if request.Method != http.MethodGet {
			t.Fatalf("method = %q", request.Method)
		}
		if request.URL.String() != metadataURL || request.Host != "169.254.169.254" || request.Body != nil {
			t.Fatalf("request target = %#v, host = %q", request.URL, request.Host)
		}
		if request.Header.Get("Accept") != "application/json" {
			t.Fatalf("Accept = %q", request.Header.Get("Accept"))
		}
		return testResponse(request, http.StatusOK, `{
			"uuid":"`+testInstanceUUID+`",
			"hostname":"private-hostname",
			"meta":{"private":"discard me"},
			"keys":[{"data":"discard me too"}]
		}`), nil
	})

	client, err := New(Options{Transport: transport})
	if err != nil {
		t.Fatal(err)
	}
	instanceUUID, err := client.InstanceUUID(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if instanceUUID != testInstanceUUID {
		t.Fatalf("instance UUID = %q", instanceUUID)
	}
	if calls.Load() != 1 {
		t.Fatalf("requests = %d", calls.Load())
	}
}

func TestInstanceUUIDRejectsInvalidDocuments(t *testing.T) {
	tests := []struct {
		name string
		body string
	}{
		{name: "missing uuid", body: `{"hostname":"node"}`},
		{name: "uppercase uuid", body: `{"uuid":"11111111-2222-4333-8444-55555555555A"}`},
		{name: "compact uuid", body: `{"uuid":"11111111222243338444555555555555"}`},
		{name: "uuid number", body: `{"uuid":123}`},
		{name: "uuid null", body: `{"uuid":null}`},
		{name: "duplicate uuid", body: `{"uuid":"` + testInstanceUUID + `","uuid":"` + testInstanceUUID + `"}`},
		{name: "top level array", body: `[{"uuid":"` + testInstanceUUID + `"}]`},
		{name: "trailing document", body: `{"uuid":"` + testInstanceUUID + `"}{}`},
		{name: "malformed unknown field", body: `{"uuid":"` + testInstanceUUID + `","meta":]`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			client := newResponseClient(t, http.StatusOK, test.body, Options{})
			instanceUUID, err := client.InstanceUUID(context.Background())
			if instanceUUID != "" || !errors.Is(err, ErrInvalidResponse) {
				t.Fatalf("instance UUID = %q, error = %v", instanceUUID, err)
			}
		})
	}
}

func TestInstanceUUIDBoundsResponse(t *testing.T) {
	body := `{"uuid":"` + testInstanceUUID + `","padding":"` + strings.Repeat("x", 256) + `"}`
	client := newResponseClient(t, http.StatusOK, body, Options{MaxResponseBytes: 128})
	instanceUUID, err := client.InstanceUUID(context.Background())
	if instanceUUID != "" || !errors.Is(err, ErrResponseTooLarge) {
		t.Fatalf("instance UUID = %q, error = %v", instanceUUID, err)
	}
}

func TestInstanceUUIDErrorsNeverExposeResponseOrTransportDetails(t *testing.T) {
	tests := []struct {
		name      string
		transport http.RoundTripper
		wantErr   error
	}{
		{
			name: "status body",
			transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
				return testResponse(request, http.StatusInternalServerError, secretCanary), nil
			}),
			wantErr: ErrUnexpectedStatus,
		},
		{
			name: "invalid body",
			transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
				return testResponse(request, http.StatusOK, `{"uuid":"`+secretCanary+`"}`), nil
			}),
			wantErr: ErrInvalidResponse,
		},
		{
			name: "transport error",
			transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
				return nil, errors.New(secretCanary)
			}),
			wantErr: ErrUnavailable,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			client, err := New(Options{Transport: test.transport})
			if err != nil {
				t.Fatal(err)
			}
			_, err = client.InstanceUUID(context.Background())
			if !errors.Is(err, test.wantErr) || strings.Contains(err.Error(), secretCanary) {
				t.Fatalf("error = %v", err)
			}
		})
	}
}

func TestInstanceUUIDBlocksRedirect(t *testing.T) {
	var calls atomic.Int32
	transport := roundTripFunc(func(request *http.Request) (*http.Response, error) {
		calls.Add(1)
		response := testResponse(request, http.StatusFound, "")
		response.Header.Set("Location", "http://127.0.0.1/"+secretCanary)
		return response, nil
	})
	client, err := New(Options{Transport: transport})
	if err != nil {
		t.Fatal(err)
	}

	_, err = client.InstanceUUID(context.Background())
	if !errors.Is(err, ErrRedirectBlocked) || strings.Contains(err.Error(), secretCanary) {
		t.Fatalf("error = %v", err)
	}
	if calls.Load() != 1 {
		t.Fatalf("requests = %d", calls.Load())
	}
}

func TestMetadataOnlyTransportRejectsEveryOtherTarget(t *testing.T) {
	var calls atomic.Int32
	transport := metadataOnlyTransport{next: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		calls.Add(1)
		return testResponse(request, http.StatusOK, `{}`), nil
	})}

	valid, err := http.NewRequest(http.MethodGet, metadataURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	valid.Host = "169.254.169.254"
	unsafeRequests := map[string]*http.Request{
		"method":        valid.Clone(context.Background()),
		"body":          valid.Clone(context.Background()),
		"host override": valid.Clone(context.Background()),
		"https":         valid.Clone(context.Background()),
		"port":          valid.Clone(context.Background()),
		"other host":    valid.Clone(context.Background()),
		"other path":    valid.Clone(context.Background()),
		"query":         valid.Clone(context.Background()),
		"force query":   valid.Clone(context.Background()),
		"userinfo":      valid.Clone(context.Background()),
		"fragment":      valid.Clone(context.Background()),
		"omit host":     valid.Clone(context.Background()),
	}
	unsafeRequests["method"].Method = http.MethodPost
	unsafeRequests["body"].Body = io.NopCloser(strings.NewReader(secretCanary))
	unsafeRequests["body"].ContentLength = int64(len(secretCanary))
	unsafeRequests["host override"].Host = "attacker.example"
	unsafeRequests["https"].URL.Scheme = "https"
	unsafeRequests["port"].URL.Host = "169.254.169.254:80"
	unsafeRequests["other host"].URL.Host = "127.0.0.1"
	unsafeRequests["other path"].URL.Path = "/latest/meta-data/"
	unsafeRequests["query"].URL.RawQuery = "token=" + secretCanary
	unsafeRequests["force query"].URL.ForceQuery = true
	unsafeRequests["userinfo"].URL.User = url.UserPassword("user", secretCanary)
	unsafeRequests["fragment"].URL.Fragment = secretCanary
	unsafeRequests["omit host"].URL.OmitHost = true

	for name, request := range unsafeRequests {
		t.Run(name, func(t *testing.T) {
			response, err := transport.RoundTrip(request)
			if response != nil || !errors.Is(err, ErrUnsafeRequest) || strings.Contains(err.Error(), secretCanary) {
				t.Fatalf("response = %#v, error = %v", response, err)
			}
		})
	}
	if calls.Load() != 0 {
		t.Fatalf("downstream requests = %d", calls.Load())
	}
}

func TestNewRemovesStandardTransportProxyWithoutMutatingCaller(t *testing.T) {
	proxy := func(*http.Request) (*url.URL, error) {
		return url.Parse("http://127.0.0.1:8888")
	}
	original := &http.Transport{Proxy: proxy}
	client, err := New(Options{Transport: original})
	if err != nil {
		t.Fatal(err)
	}
	wrapper, ok := client.client.Transport.(metadataOnlyTransport)
	if !ok {
		t.Fatalf("transport = %T", client.client.Transport)
	}
	clone, ok := wrapper.next.(*http.Transport)
	if !ok || clone.Proxy != nil {
		t.Fatalf("safe transport = %#v", wrapper.next)
	}
	if original.Proxy == nil {
		t.Fatal("caller's transport was mutated")
	}
}

func TestNewEnforcesSafeClientControls(t *testing.T) {
	originalRedirect := func(*http.Request, []*http.Request) error { return nil }
	original := &http.Client{
		Timeout:       time.Hour,
		CheckRedirect: originalRedirect,
		Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			return testResponse(request, http.StatusOK, `{"uuid":"`+testInstanceUUID+`"}`), nil
		}),
	}
	client, err := New(Options{HTTPClient: original})
	if err != nil {
		t.Fatal(err)
	}
	if client.client == original || client.client.Timeout != DefaultTimeout {
		t.Fatalf("client = %#v", client.client)
	}
	if original.Timeout != time.Hour || original.CheckRedirect == nil {
		t.Fatal("caller's HTTP client was mutated")
	}
}

func TestNewRejectsUnsafeOptions(t *testing.T) {
	tests := []struct {
		name    string
		options Options
	}{
		{name: "client and transport", options: Options{HTTPClient: &http.Client{}, Transport: roundTripFunc(nil)}},
		{name: "negative timeout", options: Options{Timeout: -time.Second}},
		{name: "long timeout", options: Options{Timeout: MaximumTimeout + time.Nanosecond}},
		{name: "negative body limit", options: Options{MaxResponseBytes: -1}},
		{name: "large body limit", options: Options{MaxResponseBytes: MaximumResponseBytes + 1}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			client, err := New(test.options)
			if client != nil || err == nil {
				t.Fatalf("client = %#v, error = %v", client, err)
			}
		})
	}
}

func TestInstanceUUIDHonorsCanceledContextWithoutRequest(t *testing.T) {
	var calls atomic.Int32
	client, err := New(Options{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		calls.Add(1)
		return nil, errors.New("unexpected request")
	})})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	_, err = client.InstanceUUID(ctx)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v", err)
	}
	if calls.Load() != 0 {
		t.Fatalf("requests = %d", calls.Load())
	}
}

func newResponseClient(t *testing.T, status int, body string, options Options) *Client {
	t.Helper()
	options.Transport = roundTripFunc(func(request *http.Request) (*http.Response, error) {
		return testResponse(request, status, body), nil
	})
	client, err := New(options)
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func testResponse(request *http.Request, status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Header:     make(http.Header),
		Body:       io.NopCloser(strings.NewReader(body)),
		Request:    request,
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (function roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}
