package uplink

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/intellisys-stevens/leviathan/internal/model"
)

const secretCanary = "UPLINK-SECRET-CANARY"

func TestMachineTokenHasExactCanonicalFormat(t *testing.T) {
	token := testMachineToken()
	if len(token) != 70 || !validMachineToken(token) {
		t.Fatalf("token length = %d, valid = %v", len(token), validMachineToken(token))
	}
	invalid := []string{
		"", token + "x", token[:len(token)-1], strings.Replace(token, "yv1_", "yv2_", 1),
		strings.Replace(token, "_", "=", 1), token[:10] + "+" + token[11:],
	}
	for _, candidate := range invalid {
		if validMachineToken(candidate) {
			t.Fatalf("accepted invalid token %q", candidate)
		}
	}
}

func TestFileTokenSourceEnforcesPrivateRegularFileAndReloads(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "uplink-token")
	token := testMachineToken()
	if err := os.WriteFile(path, []byte(token+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	source, err := NewFileTokenSource(path)
	if err != nil {
		t.Fatal(err)
	}
	got, err := source.Token(context.Background())
	if err != nil || got != token {
		t.Fatalf("Token() = %q, %v", got, err)
	}

	rotated := machineToken(bytes.Repeat([]byte{2}, machineLookupBytes), bytes.Repeat([]byte{3}, machineSecretBytes))
	if err := os.WriteFile(path, []byte(rotated+"\r\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err = source.Token(context.Background())
	if err != nil || got != rotated {
		t.Fatalf("rotated Token() = %q, %v", got, err)
	}

	if err := os.Chmod(path, 0o640); err != nil {
		t.Fatal(err)
	}
	if _, err := source.Token(context.Background()); !errors.Is(err, ErrCredentialInsecure) {
		t.Fatalf("permission error = %v", err)
	}
	if err := os.Chmod(path, 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(directory, "link")
	if err := os.Symlink(path, link); err != nil {
		t.Fatal(err)
	}
	if _, err := NewFileTokenSource(link); !errors.Is(err, ErrCredentialRead) {
		t.Fatalf("symlink error = %v", err)
	}
	if _, err := NewFileTokenSource("relative"); !errors.Is(err, ErrCredentialRead) {
		t.Fatalf("relative path error = %v", err)
	}
}

func TestClientPostsExactBoundedEnvelope(t *testing.T) {
	envelope := testEnvelope(t)
	var calls atomic.Int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		calls.Add(1)
		if request.Method != http.MethodPost || request.URL.Path != EndpointPath || request.URL.RawQuery != "" {
			t.Errorf("request = %s %s", request.Method, request.URL.String())
		}
		if got := request.Header.Get("Authorization"); got != "Bearer "+testMachineToken() {
			t.Errorf("authorization = %q", got)
		}
		if got := request.Header.Get("Cookie"); got != "" {
			t.Errorf("cookie crossed boundary = %q", got)
		}
		body, err := io.ReadAll(request.Body)
		if err != nil {
			t.Error(err)
			return
		}
		if request.ContentLength != int64(len(body)) || request.ContentLength > MaxRequestBytes {
			t.Errorf("content length = %d, body = %d", request.ContentLength, len(body))
		}
		var got Envelope
		if err := json.Unmarshal(body, &got); err != nil || got.StreamID != envelope.StreamID || got.Sequence != envelope.Sequence {
			t.Errorf("envelope = %+v, err = %v", got, err)
		}
		writeReceipt(writer, envelope)
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
	client, err := NewClient(server.URL+"/", staticTokenSource(testMachineToken()), ClientOptions{HTTPClient: injected})
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := client.Send(context.Background(), envelope)
	if err != nil || receipt.StreamID != envelope.StreamID || receipt.Sequence != envelope.Sequence {
		t.Fatalf("receipt = %+v, err = %v", receipt, err)
	}
	if calls.Load() != 1 {
		t.Fatalf("calls = %d", calls.Load())
	}
}

func TestClientEnforcesExactRequestLimitBeforeNetwork(t *testing.T) {
	envelope := testEnvelope(t)
	document, err := json.Marshal(envelope)
	if err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		writeReceipt(writer, envelope)
	}))
	defer server.Close()

	atLimit := newTestClient(t, server, ClientOptions{RequestLimit: int64(len(document))})
	if _, err := atLimit.Send(context.Background(), envelope); err != nil {
		t.Fatalf("exact limit error = %v", err)
	}
	underLimit := newTestClient(t, server, ClientOptions{RequestLimit: int64(len(document) - 1)})
	if _, err := underLimit.Send(context.Background(), envelope); !errors.Is(err, ErrRequestTooLarge) || IsRetryable(err) {
		t.Fatalf("undersized limit error = %v", err)
	}
	if calls.Load() != 1 {
		t.Fatalf("calls = %d", calls.Load())
	}
	if MaxRequestBytes != 8<<20 {
		t.Fatalf("protocol maximum = %d", MaxRequestBytes)
	}
	if _, err := NewClient(server.URL, staticTokenSource(testMachineToken()), ClientOptions{HTTPClient: server.Client(), RequestLimit: MaxRequestBytes + 1}); !errors.Is(err, ErrClientConfig) {
		t.Fatalf("oversized configured limit error = %v", err)
	}
}

func TestClientClassifiesRetryAfterWithoutResponseDisclosure(t *testing.T) {
	fixedNow := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	tests := []struct {
		name       string
		status     int
		retryAfter string
		wantRetry  bool
		wantDelay  time.Duration
	}{
		{name: "unauthorized", status: http.StatusUnauthorized},
		{name: "too large", status: http.StatusRequestEntityTooLarge},
		{name: "timeout", status: http.StatusRequestTimeout, wantRetry: true},
		{name: "rate seconds", status: http.StatusTooManyRequests, retryAfter: "17", wantRetry: true, wantDelay: 17 * time.Second},
		{name: "service date", status: http.StatusServiceUnavailable, retryAfter: fixedNow.Add(23 * time.Second).Format(http.TimeFormat), wantRetry: true, wantDelay: 23 * time.Second},
		{name: "server", status: http.StatusInternalServerError, retryAfter: "invalid", wantRetry: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
				if test.retryAfter != "" {
					writer.Header().Set("Retry-After", test.retryAfter)
				}
				writer.WriteHeader(test.status)
				_, _ = io.WriteString(writer, secretCanary)
			}))
			defer server.Close()
			client := newTestClient(t, server, ClientOptions{Now: func() time.Time { return fixedNow }})
			_, err := client.Send(context.Background(), testEnvelope(t))
			if !errors.Is(err, ErrUnexpectedStatus) || IsRetryable(err) != test.wantRetry || RetryAfter(err) != test.wantDelay || strings.Contains(err.Error(), secretCanary) {
				t.Fatalf("error = %v, retry = %v, delay = %s", err, IsRetryable(err), RetryAfter(err))
			}
		})
	}
}

func TestClientRequiresExactMatchingReceipt(t *testing.T) {
	envelope := testEnvelope(t)
	tests := []struct {
		name        string
		contentType string
		body        string
		want        error
	}{
		{name: "wrong content type", contentType: "text/plain", body: receiptJSON(envelope), want: ErrInvalidReceipt},
		{name: "missing", contentType: "application/json", body: `{"status":"accepted"}`, want: ErrInvalidReceipt},
		{name: "unknown", contentType: "application/json", body: `{"status":"accepted","streamId":"` + testStreamID + `","sequence":9,"secret":"x"}`, want: ErrInvalidReceipt},
		{name: "duplicate", contentType: "application/json", body: `{"status":"accepted","status":"accepted","streamId":"` + testStreamID + `","sequence":9}`, want: ErrInvalidReceipt},
		{name: "trailing", contentType: "application/json", body: receiptJSON(envelope) + `{}`, want: ErrInvalidReceipt},
		{name: "wrong stream", contentType: "application/json", body: `{"status":"accepted","streamId":"BBBBBBBBBBBBBBBBBBBBBA","sequence":9}`, want: ErrReceiptMismatch},
		{name: "wrong sequence", contentType: "application/json", body: `{"status":"accepted","streamId":"` + testStreamID + `","sequence":10}`, want: ErrReceiptMismatch},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
				writer.Header().Set("Content-Type", test.contentType)
				writer.WriteHeader(http.StatusAccepted)
				_, _ = io.WriteString(writer, test.body)
			}))
			defer server.Close()
			client := newTestClient(t, server, ClientOptions{})
			_, err := client.Send(context.Background(), envelope)
			if !errors.Is(err, test.want) || !IsRetryable(err) {
				t.Fatalf("error = %v", err)
			}
		})
	}
}

func TestClientBlocksRedirectAndSanitizesCredentialAndTransportErrors(t *testing.T) {
	var targetCalls atomic.Int32
	target := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { targetCalls.Add(1) }))
	defer target.Close()
	redirector := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		http.Redirect(writer, request, target.URL+"/"+secretCanary, http.StatusTemporaryRedirect)
	}))
	defer redirector.Close()
	client := newTestClient(t, redirector, ClientOptions{})
	if _, err := client.Send(context.Background(), testEnvelope(t)); !errors.Is(err, ErrRedirectBlocked) || IsRetryable(err) || strings.Contains(err.Error(), secretCanary) {
		t.Fatalf("redirect error = %v", err)
	}
	if targetCalls.Load() != 0 {
		t.Fatalf("redirect target calls = %d", targetCalls.Load())
	}

	credentialClient, err := NewClient("https://hub.example.test", TokenSourceFunc(func(context.Context) (string, error) {
		return "", errors.New(secretCanary)
	}), ClientOptions{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return nil, errors.New("unexpected network request")
	})})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := credentialClient.Send(context.Background(), testEnvelope(t)); !errors.Is(err, ErrCredentialRead) || strings.Contains(err.Error(), secretCanary) {
		t.Fatalf("credential error = %v", err)
	}

	transportClient, err := NewClient("https://hub.example.test", staticTokenSource(testMachineToken()), ClientOptions{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return nil, errors.New("https://secret.example/" + secretCanary)
	})})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := transportClient.Send(context.Background(), testEnvelope(t)); !errors.Is(err, ErrRequestFailed) || !IsRetryable(err) || strings.Contains(err.Error(), secretCanary) {
		t.Fatalf("transport error = %v", err)
	}
}

func TestNewClientAcceptsOnlyCredentialFreeHTTPSOrigin(t *testing.T) {
	valid := []string{"https://hub.example.test", "HTTPS://hub.example.test/", "https://hub.example.test:8443", "https://[::1]:8443/"}
	for _, baseURL := range valid {
		if _, err := NewClient(baseURL, staticTokenSource(testMachineToken()), ClientOptions{}); err != nil {
			t.Fatalf("valid URL %q: %v", baseURL, err)
		}
	}
	invalid := []string{
		"", "http://hub.example.test", "https://user:pass@hub.example.test", "https://hub.example.test/path",
		"https://hub.example.test?token=" + secretCanary, "https://hub.example.test/#fragment", " https://hub.example.test",
		"https://hub.example.test ", "https://hub.example.test:", "https://hub.example.test:99999", "https://hub.example.test\\@attacker.example",
	}
	for _, baseURL := range invalid {
		_, err := NewClient(baseURL, staticTokenSource(testMachineToken()), ClientOptions{})
		if !errors.Is(err, ErrBaseURL) || strings.Contains(err.Error(), secretCanary) {
			t.Fatalf("invalid URL %q error = %v", baseURL, err)
		}
	}
}

func testEnvelope(t *testing.T) Envelope {
	t.Helper()
	envelope, err := Project(projectionSnapshot(), model.BuildInfo{Version: "0.4.0", Commit: "abc123", BuildDate: "2026-09-02"}, testStreamID, 9)
	if err != nil {
		t.Fatal(err)
	}
	return envelope
}

func newTestClient(t *testing.T, server *httptest.Server, options ClientOptions) *Client {
	t.Helper()
	if options.HTTPClient == nil && options.Transport == nil {
		options.HTTPClient = server.Client()
	}
	client, err := NewClient(server.URL, staticTokenSource(testMachineToken()), options)
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func staticTokenSource(token string) TokenSource {
	return TokenSourceFunc(func(context.Context) (string, error) { return token, nil })
}

func testMachineToken() string {
	return machineToken(make([]byte, machineLookupBytes), bytes.Repeat([]byte{1}, machineSecretBytes))
}

func machineToken(lookup, secret []byte) string {
	return machineTokenPrefix + base64.RawURLEncoding.EncodeToString(lookup) + "_" + base64.RawURLEncoding.EncodeToString(secret)
}

func receiptJSON(envelope Envelope) string {
	document, _ := json.Marshal(Receipt{Status: "accepted", StreamID: envelope.StreamID, Sequence: envelope.Sequence})
	return string(document)
}

func writeReceipt(writer http.ResponseWriter, envelope Envelope) {
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(http.StatusAccepted)
	_, _ = io.WriteString(writer, receiptJSON(envelope))
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (function roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}
