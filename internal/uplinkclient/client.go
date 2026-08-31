// Package uplinkclient sends one bounded telemetry snapshot at a time to an
// explicitly configured MIGLens Hub. It deliberately contains no discovery,
// retry, queue, or credential-enrollment behavior.
package uplinkclient

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode"

	"github.com/intellisys-stevens/miglens/internal/model"
)

const (
	DefaultTimeout         = 5 * time.Second
	MaximumTimeout         = time.Minute
	DefaultMaxRequestBytes = int64(8 << 20)
	MaximumRequestBytes    = int64(32 << 20)
	MinimumTokenBytes      = 32
	MaximumTokenBytes      = 512

	uplinkPathPrefix    = "/api/fleet/v1/uplink/"
	responseDrainLimit  = int64(4 << 10)
	maximumReceiptBytes = int64(256)
)

var (
	ErrInvalidConfig       = errors.New("uplink client configuration is invalid")
	ErrInvalidBaseURL      = errors.New("uplink base URL is invalid")
	ErrInvalidToken        = errors.New("uplink bearer token is invalid")
	ErrInvalidInstanceUUID = errors.New("uplink instance UUID is invalid")
	ErrEncode              = errors.New("uplink payload encoding failed")
	ErrRequestTooLarge     = errors.New("uplink request exceeds the configured limit")
	ErrRequestFailed       = errors.New("uplink request failed")
	ErrRedirectBlocked     = errors.New("uplink redirect is not allowed")
	ErrUnexpectedStatus    = errors.New("uplink returned an unexpected status")
	ErrInvalidReceipt      = errors.New("uplink returned an invalid receipt")
)

var openStackUUID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// Envelope is the complete JSON body accepted by the Hub uplink endpoint.
// BuildInfo is optional so telemetry can still be reported by builds that do
// not expose version metadata.
type Envelope struct {
	Snapshot  model.Snapshot   `json:"snapshot"`
	BuildInfo *model.BuildInfo `json:"buildInfo,omitempty"`
}

// Options controls finite transport limits and provides test/TLS injection
// points. Set at most one of HTTPClient and Transport. A supplied HTTPClient is
// copied before timeout, cookie, and redirect policy are enforced.
type Options struct {
	HTTPClient *http.Client
	Transport  http.RoundTripper

	Timeout         time.Duration
	MaxRequestBytes int64
}

// Client sends synchronous, single-attempt telemetry requests to one trusted
// Hub origin.
type Client struct {
	baseURL         url.URL
	token           string
	httpClient      *http.Client
	maxRequestBytes int64
}

// New validates and retains one HTTPS Hub origin and bearer token. baseURL may
// contain only the HTTPS origin (an optional trailing slash is accepted).
func New(baseURL, token string, options Options) (*Client, error) {
	if options.HTTPClient != nil && options.Transport != nil {
		return nil, ErrInvalidConfig
	}
	timeout := options.Timeout
	if timeout < 0 || timeout > MaximumTimeout {
		return nil, ErrInvalidConfig
	}
	if timeout == 0 {
		timeout = DefaultTimeout
	}
	maxRequestBytes := options.MaxRequestBytes
	if maxRequestBytes < 0 || maxRequestBytes > MaximumRequestBytes {
		return nil, ErrInvalidConfig
	}
	if maxRequestBytes == 0 {
		maxRequestBytes = DefaultMaxRequestBytes
	}

	parsed, err := parseBaseURL(baseURL)
	if err != nil {
		return nil, err
	}
	if !validToken(token) {
		return nil, ErrInvalidToken
	}

	httpClient := &http.Client{}
	if options.HTTPClient != nil {
		copy := *options.HTTPClient
		httpClient = &copy
	}
	if options.Transport != nil {
		httpClient.Transport = options.Transport
	}
	// Uplink authentication is carried only by the explicit bearer header.
	// Do not inherit cookies or redirect policy from an injected client.
	httpClient.Jar = nil
	httpClient.Timeout = timeout
	httpClient.CheckRedirect = func(*http.Request, []*http.Request) error {
		return ErrRedirectBlocked
	}

	return &Client{
		baseURL:         *parsed,
		token:           token,
		httpClient:      httpClient,
		maxRequestBytes: maxRequestBytes,
	}, nil
}

// Send posts snapshot and optional buildInfo for one canonical lowercase
// OpenStack instance UUID. It performs exactly one HTTP request and returns
// only sanitized errors that do not include the endpoint, token, or response
// body.
func (c *Client) Send(ctx context.Context, instanceUUID string, snapshot model.Snapshot, buildInfo *model.BuildInfo) error {
	if c == nil || c.httpClient == nil || c.maxRequestBytes <= 0 {
		return ErrInvalidConfig
	}
	if ctx == nil {
		return ErrInvalidConfig
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if !openStackUUID.MatchString(instanceUUID) {
		return ErrInvalidInstanceUUID
	}

	document, err := json.Marshal(Envelope{Snapshot: snapshot, BuildInfo: buildInfo})
	if err != nil {
		return ErrEncode
	}
	if int64(len(document)) > c.maxRequestBytes {
		return ErrRequestTooLarge
	}
	if err := ctx.Err(); err != nil {
		return err
	}

	endpoint := c.baseURL
	endpoint.Path = uplinkPathPrefix + instanceUUID
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), bytes.NewReader(document))
	if err != nil {
		return ErrRequestFailed
	}
	request.Header.Set("Authorization", "Bearer "+c.token)
	request.Header.Set("Content-Type", "application/json")

	response, err := c.httpClient.Do(request)
	if err != nil {
		if contextErr := ctx.Err(); contextErr != nil {
			return contextErr
		}
		if errors.Is(err, ErrRedirectBlocked) {
			return ErrRedirectBlocked
		}
		return ErrRequestFailed
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusAccepted {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, responseDrainLimit))
		return ErrUnexpectedStatus
	}
	contentTypes := response.Header.Values("Content-Type")
	if len(contentTypes) != 1 || contentTypes[0] != "application/json" {
		return ErrInvalidReceipt
	}
	receipt, readErr := io.ReadAll(io.LimitReader(response.Body, maximumReceiptBytes+1))
	if readErr != nil || int64(len(receipt)) > maximumReceiptBytes || !validAcceptedReceipt(receipt) {
		return ErrInvalidReceipt
	}
	return nil
}

func validAcceptedReceipt(document []byte) bool {
	decoder := json.NewDecoder(bytes.NewReader(document))
	opening, err := decoder.Token()
	if err != nil || opening != json.Delim('{') {
		return false
	}
	seenStatus := false
	status := ""
	for decoder.More() {
		keyToken, err := decoder.Token()
		key, ok := keyToken.(string)
		if err != nil || !ok || key != "status" || seenStatus {
			return false
		}
		if err := decoder.Decode(&status); err != nil {
			return false
		}
		seenStatus = true
	}
	closing, err := decoder.Token()
	if err != nil || closing != json.Delim('}') {
		return false
	}
	if token, err := decoder.Token(); err != io.EOF || token != nil {
		return false
	}
	return seenStatus && status == "accepted"
}

func parseBaseURL(raw string) (*url.URL, error) {
	if raw == "" || strings.TrimSpace(raw) != raw || strings.ContainsAny(raw, `\\?#`) || containsControl(raw) {
		return nil, ErrInvalidBaseURL
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.Hostname() == "" ||
		parsed.User != nil || parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" ||
		parsed.Opaque != "" || parsed.RawPath != "" || (parsed.Path != "" && parsed.Path != "/") ||
		strings.HasSuffix(parsed.Host, ":") {
		return nil, ErrInvalidBaseURL
	}
	parsed.Path = ""
	return parsed, nil
}

func validToken(token string) bool {
	if len(token) < MinimumTokenBytes || len(token) > MaximumTokenBytes {
		return false
	}
	for _, character := range []byte(token) {
		if character < 0x21 || character > 0x7e {
			return false
		}
	}
	return true
}

func containsControl(value string) bool {
	for _, character := range value {
		if unicode.IsControl(character) {
			return true
		}
	}
	return false
}
