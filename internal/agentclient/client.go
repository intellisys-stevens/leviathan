// Package agentclient reads telemetry from explicitly bound, existing MIGLens
// agents. It is intentionally read-only and never discovers agent endpoints
// from cloud inventory or caller-controlled request data.
package agentclient

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strings"
	"time"

	"github.com/intellisys-stevens/miglens/internal/fleet"
	"github.com/intellisys-stevens/miglens/internal/model"
)

const (
	DefaultTimeout          = 5 * time.Second
	DefaultMaxSnapshotBytes = int64(8 << 20)
	DefaultMaxVersionBytes  = int64(64 << 10)
	maxConfiguredBodyBytes  = int64(32 << 20)
)

var (
	ErrUnknownBinding       = errors.New("agent binding is unavailable")
	ErrAgentUnavailable     = errors.New("agent request failed")
	ErrRedirectBlocked      = errors.New("agent redirect is not allowed")
	ErrUnexpectedStatus     = errors.New("agent returned an unexpected status")
	ErrInvalidResponse      = errors.New("agent returned an invalid response")
	ErrResponseTooLarge     = errors.New("agent response exceeds the configured limit")
	ErrIncompatibleSchema   = errors.New("agent snapshot schema is incompatible")
	ErrSnapshotHostMismatch = errors.New("agent snapshot hostname does not match its binding")
)

// Binding is a trusted association between one OpenStack instance UUID and one
// MIGLens HTTPS endpoint. ExpectedHostname is compared with Snapshot.Host.Hostname
// before the instance UUID is copied into the returned fleet sample.
type Binding struct {
	BaseURL          string
	ExpectedHostname string
}

type Options struct {
	// HTTPClient and Transport are injection points for tests and specialized
	// TLS roots. Set at most one. The source copies HTTPClient before enforcing
	// the no-redirect policy, so the caller's client is not mutated.
	HTTPClient *http.Client
	Transport  http.RoundTripper

	Timeout          time.Duration
	MaxSnapshotBytes int64
	MaxVersionBytes  int64
}

type trustedBinding struct {
	baseURL          url.URL
	expectedHostname string
}

// Source implements fleet.AgentSource using only GET requests to the existing
// MIGLens v1 snapshot and version endpoints.
type Source struct {
	bindings         map[string]trustedBinding
	client           *http.Client
	maxSnapshotBytes int64
	maxVersionBytes  int64
}

var _ fleet.AgentSource = (*Source)(nil)

var openStackUUID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

func New(bindings map[string]Binding, options Options) (*Source, error) {
	if options.HTTPClient != nil && options.Transport != nil {
		return nil, errors.New("agent client accepts either an HTTP client or a transport")
	}
	timeout := options.Timeout
	if timeout < 0 {
		return nil, errors.New("agent client timeout must not be negative")
	}
	if timeout == 0 {
		timeout = DefaultTimeout
	}
	maxSnapshotBytes, err := bodyLimit(options.MaxSnapshotBytes, DefaultMaxSnapshotBytes)
	if err != nil {
		return nil, err
	}
	maxVersionBytes, err := bodyLimit(options.MaxVersionBytes, DefaultMaxVersionBytes)
	if err != nil {
		return nil, err
	}

	trusted := make(map[string]trustedBinding, len(bindings))
	for instanceUUID, binding := range bindings {
		if !openStackUUID.MatchString(instanceUUID) {
			return nil, errors.New("agent binding contains an invalid instance UUID")
		}
		parsed, err := parseBaseURL(binding.BaseURL)
		if err != nil {
			return nil, err
		}
		expectedHostname := binding.ExpectedHostname
		if expectedHostname == "" || len(expectedHostname) > 255 || strings.TrimSpace(expectedHostname) != expectedHostname || containsControl(expectedHostname) {
			return nil, errors.New("agent binding contains an invalid expected hostname")
		}
		trusted[instanceUUID] = trustedBinding{baseURL: *parsed, expectedHostname: expectedHostname}
	}

	client := &http.Client{}
	if options.HTTPClient != nil {
		copy := *options.HTTPClient
		client = &copy
	}
	if options.Transport != nil {
		client.Transport = options.Transport
	}
	client.Timeout = timeout
	client.CheckRedirect = func(_ *http.Request, _ []*http.Request) error {
		return ErrRedirectBlocked
	}

	return &Source{
		bindings:         trusted,
		client:           client,
		maxSnapshotBytes: maxSnapshotBytes,
		maxVersionBytes:  maxVersionBytes,
	}, nil
}

func bodyLimit(configured, fallback int64) (int64, error) {
	if configured < 0 || configured > maxConfiguredBodyBytes {
		return 0, errors.New("agent response limit is invalid")
	}
	if configured == 0 {
		return fallback, nil
	}
	return configured, nil
}

func parseBaseURL(raw string) (*url.URL, error) {
	if raw == "" || strings.Contains(raw, `\`) {
		return nil, errors.New("agent binding contains an invalid base URL")
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || parsed.Hostname() == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" || parsed.Opaque != "" || parsed.RawPath != "" {
		return nil, errors.New("agent binding contains an invalid base URL")
	}
	cleanedPath := path.Clean(parsed.Path)
	if parsed.Path == "" {
		cleanedPath = ""
	}
	if cleanedPath != strings.TrimSuffix(parsed.Path, "/") && !(parsed.Path == "/" && cleanedPath == "/") {
		return nil, errors.New("agent binding contains an invalid base URL")
	}
	parsed.Path = strings.TrimSuffix(parsed.Path, "/")
	return parsed, nil
}

func containsControl(value string) bool {
	for _, character := range value {
		if character < 0x20 || character == 0x7f {
			return true
		}
	}
	return false
}

func (s *Source) Observe(ctx context.Context, instance fleet.Instance) (fleet.AgentSample, error) {
	if err := ctx.Err(); err != nil {
		return fleet.AgentSample{}, err
	}
	binding, ok := s.bindings[instance.UUID]
	if !ok {
		return fleet.AgentSample{}, ErrUnknownBinding
	}

	var snapshot model.Snapshot
	snapshotDocument, err := s.getJSON(ctx, binding, "/api/v1/snapshot", s.maxSnapshotBytes, &snapshot)
	if err != nil {
		return fleet.AgentSample{}, err
	}
	if snapshot.SchemaVersion != "v1" {
		return fleet.AgentSample{}, ErrIncompatibleSchema
	}
	if err := validateSnapshotContainers(snapshotDocument, snapshot); err != nil {
		return fleet.AgentSample{}, ErrInvalidResponse
	}
	if snapshot.Host.Hostname != binding.expectedHostname {
		return fleet.AgentSample{}, ErrSnapshotHostMismatch
	}

	var buildInfo model.BuildInfo
	if _, err := s.getJSON(ctx, binding, "/api/v1/version", s.maxVersionBytes, &buildInfo); err != nil {
		return fleet.AgentSample{}, err
	}

	// The UUID becomes trusted only after the endpoint has returned a compatible
	// snapshot with the exact hostname pinned in the binding.
	return fleet.AgentSample{
		InstanceUUID: instance.UUID,
		Source:       fleet.TelemetrySourceMIGLensAgent,
		ObservedAt:   snapshot.SampledAt,
		BuildInfo:    &buildInfo,
		Snapshot:     snapshot,
	}, nil
}

func (s *Source) getJSON(ctx context.Context, binding trustedBinding, endpointPath string, limit int64, destination any) ([]byte, error) {
	endpoint := binding.baseURL
	endpoint.Path = strings.TrimSuffix(endpoint.Path, "/") + endpointPath
	endpoint.RawPath = ""
	endpoint.RawQuery = ""
	endpoint.ForceQuery = false
	endpoint.Fragment = ""

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return nil, ErrAgentUnavailable
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("User-Agent", "miglens-fleet-agent-client")
	response, err := s.client.Do(request)
	if err != nil {
		if contextErr := ctx.Err(); contextErr != nil {
			return nil, contextErr
		}
		if errors.Is(err, ErrRedirectBlocked) {
			return nil, ErrRedirectBlocked
		}
		return nil, ErrAgentUnavailable
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4<<10))
		return nil, ErrUnexpectedStatus
	}
	mediaType, _, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		return nil, ErrInvalidResponse
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil {
		if contextErr := ctx.Err(); contextErr != nil {
			return nil, contextErr
		}
		return nil, ErrAgentUnavailable
	}
	if int64(len(data)) > limit {
		return nil, ErrResponseTooLarge
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	if err := decoder.Decode(destination); err != nil {
		return nil, ErrInvalidResponse
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return nil, ErrInvalidResponse
	}
	return data, nil
}

// validateSnapshotContainers enforces the schema-v1 fields whose absence or
// null value would otherwise survive Go's JSON decoding as zero values and
// produce a fleet document that violates the existing OpenAPI contract.
func validateSnapshotContainers(document []byte, snapshot model.Snapshot) error {
	root, err := requiredObject(document,
		"schemaVersion", "sequence", "sampledAt", "host", "gpus", "processes", "capabilities", "diagnostics",
	)
	if err != nil || snapshot.SampledAt.IsZero() || snapshot.GPUs == nil || snapshot.Processes == nil || snapshot.Diagnostics == nil {
		return ErrInvalidResponse
	}
	if _, err := requiredRawObject(root["host"], "hostname", "os", "arch"); err != nil {
		return ErrInvalidResponse
	}
	capabilities, err := requiredRawObject(root["capabilities"], "nvml", "gpm", "dcgm", "proc", "profileMetrics")
	if err != nil {
		return ErrInvalidResponse
	}
	for _, provider := range []string{"nvml", "gpm", "dcgm", "proc"} {
		if _, err := requiredRawObject(capabilities[provider], "name", "available", "status"); err != nil {
			return ErrInvalidResponse
		}
	}
	for _, gpu := range snapshot.GPUs {
		if gpu.Metrics == nil || gpu.GPUInstances == nil {
			return ErrInvalidResponse
		}
		for _, gpuInstance := range gpu.GPUInstances {
			if gpuInstance.Metrics == nil || gpuInstance.ComputeInstances == nil {
				return ErrInvalidResponse
			}
			for _, computeInstance := range gpuInstance.ComputeInstances {
				if computeInstance.Metrics == nil {
					return ErrInvalidResponse
				}
			}
		}
	}
	return nil
}

func requiredObject(document []byte, fields ...string) (map[string]json.RawMessage, error) {
	var object map[string]json.RawMessage
	if err := json.Unmarshal(document, &object); err != nil || object == nil {
		return nil, ErrInvalidResponse
	}
	return requireRawFields(object, fields...)
}

func requiredRawObject(document json.RawMessage, fields ...string) (map[string]json.RawMessage, error) {
	if isJSONNull(document) {
		return nil, ErrInvalidResponse
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(document, &object); err != nil || object == nil {
		return nil, ErrInvalidResponse
	}
	return requireRawFields(object, fields...)
}

func requireRawFields(object map[string]json.RawMessage, fields ...string) (map[string]json.RawMessage, error) {
	for _, field := range fields {
		value, found := object[field]
		if !found || isJSONNull(value) {
			return nil, ErrInvalidResponse
		}
	}
	return object, nil
}

func isJSONNull(value []byte) bool {
	return len(value) == 0 || bytes.Equal(bytes.TrimSpace(value), []byte("null"))
}
