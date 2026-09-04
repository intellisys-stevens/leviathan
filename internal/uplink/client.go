package uplink

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode"
)

const (
	DefaultRequestTimeout = 5 * time.Second
	MaximumRequestTimeout = time.Minute
	MaxRequestBytes       = int64(8 << 20)
	maximumReceiptBytes   = int64(1024)
	responseDrainBytes    = int64(4 << 10)
)

var (
	ErrClientConfig     = errors.New("uplink client configuration is invalid")
	ErrBaseURL          = errors.New("uplink base URL is invalid")
	ErrEncode           = errors.New("uplink payload encoding failed")
	ErrRequestTooLarge  = errors.New("uplink request exceeds 8 MiB")
	ErrRequestFailed    = errors.New("uplink request failed")
	ErrRedirectBlocked  = errors.New("uplink redirect is not allowed")
	ErrUnexpectedStatus = errors.New("uplink returned an unexpected status")
	ErrInvalidReceipt   = errors.New("uplink returned an invalid receipt")
	ErrReceiptMismatch  = errors.New("uplink receipt does not match the request")
	ErrInvalidEnvelope  = errors.New("uplink envelope is invalid")
)

type ClientOptions struct {
	// Set at most one of HTTPClient and Transport. A supplied HTTPClient is
	// copied before timeout, cookie, and redirect policy are enforced.
	HTTPClient *http.Client
	Transport  http.RoundTripper

	Timeout time.Duration
	// RequestLimit exists to test exact boundary behavior. Production callers
	// leave it zero; values above the protocol's fixed 8 MiB limit are rejected.
	RequestLimit int64
	Now          func() time.Time
}

type Client struct {
	endpoint     url.URL
	credentials  TokenSource
	httpClient   *http.Client
	requestLimit int64
	now          func() time.Time
}

// RequestError carries only scheduling advice. It never retains a response
// body, URL, bearer token, or underlying transport error.
type RequestError struct {
	kind       error
	retryable  bool
	retryAfter time.Duration
}

func (err *RequestError) Error() string { return err.kind.Error() }
func (err *RequestError) Unwrap() error { return err.kind }

func IsRetryable(err error) bool {
	var requestError *RequestError
	return errors.As(err, &requestError) && requestError.retryable
}

func RetryAfter(err error) time.Duration {
	var requestError *RequestError
	if errors.As(err, &requestError) && requestError.retryAfter > 0 {
		return requestError.retryAfter
	}
	return 0
}

func NewClient(baseURL string, credentials TokenSource, options ClientOptions) (*Client, error) {
	if credentials == nil || (options.HTTPClient != nil && options.Transport != nil) {
		return nil, ErrClientConfig
	}
	timeout := options.Timeout
	if timeout < 0 || timeout > MaximumRequestTimeout {
		return nil, ErrClientConfig
	}
	if timeout == 0 {
		timeout = DefaultRequestTimeout
	}
	limit := options.RequestLimit
	if limit < 0 || limit > MaxRequestBytes {
		return nil, ErrClientConfig
	}
	if limit == 0 {
		limit = MaxRequestBytes
	}
	parsed, err := parseBaseURL(baseURL)
	if err != nil {
		return nil, err
	}
	parsed.Path = EndpointPath

	client := &http.Client{}
	if options.HTTPClient != nil {
		copy := *options.HTTPClient
		client = &copy
	} else if options.Transport == nil {
		transport := http.DefaultTransport.(*http.Transport).Clone()
		// Do not let ambient proxy variables choose another bearer-token
		// recipient. Operators configure the trusted origin explicitly.
		transport.Proxy = nil
		if transport.TLSClientConfig == nil {
			transport.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12}
		} else {
			transport.TLSClientConfig = transport.TLSClientConfig.Clone()
			transport.TLSClientConfig.MinVersion = max(transport.TLSClientConfig.MinVersion, tls.VersionTLS12)
		}
		client.Transport = transport
	}
	if options.Transport != nil {
		client.Transport = options.Transport
	}
	client.Timeout = timeout
	client.Jar = nil
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return ErrRedirectBlocked }
	now := options.Now
	if now == nil {
		now = time.Now
	}
	return &Client{endpoint: *parsed, credentials: credentials, httpClient: client, requestLimit: limit, now: now}, nil
}

// ValidateBaseURL applies the same credential-free HTTPS-origin policy used by
// NewClient without constructing a transport or reading a credential.
func ValidateBaseURL(baseURL string) error {
	_, err := parseBaseURL(baseURL)
	return err
}

// Send performs exactly one bounded request. Retry and latest-only scheduling
// belong to Runner so transport attempts never create hidden queues.
func (client *Client) Send(ctx context.Context, envelope Envelope) (Receipt, error) {
	if client == nil || client.httpClient == nil || client.credentials == nil || client.requestLimit <= 0 || ctx == nil {
		return Receipt{}, ErrClientConfig
	}
	if err := ctx.Err(); err != nil {
		return Receipt{}, err
	}
	if err := validateEnvelope(envelope); err != nil {
		return Receipt{}, err
	}
	document, err := json.Marshal(envelope)
	if err != nil {
		return Receipt{}, requestFailure(ErrEncode, false, 0)
	}
	if int64(len(document)) > client.requestLimit {
		return Receipt{}, requestFailure(ErrRequestTooLarge, false, 0)
	}
	token, err := client.credentials.Token(ctx)
	if err != nil {
		if contextError := ctx.Err(); contextError != nil {
			return Receipt{}, contextError
		}
		return Receipt{}, requestFailure(credentialError(err), true, 0)
	}
	if !validMachineToken(token) {
		return Receipt{}, requestFailure(ErrCredentialInvalid, false, 0)
	}

	request, err := http.NewRequestWithContext(ctx, http.MethodPost, client.endpoint.String(), bytes.NewReader(document))
	if err != nil {
		return Receipt{}, requestFailure(ErrRequestFailed, true, 0)
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")

	response, err := client.httpClient.Do(request)
	if err != nil {
		if contextError := ctx.Err(); contextError != nil {
			return Receipt{}, contextError
		}
		if errors.Is(err, ErrRedirectBlocked) {
			return Receipt{}, requestFailure(ErrRedirectBlocked, false, 0)
		}
		return Receipt{}, requestFailure(ErrRequestFailed, true, 0)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusAccepted {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, responseDrainBytes))
		retryable := response.StatusCode == http.StatusRequestTimeout || response.StatusCode == http.StatusTooEarly ||
			response.StatusCode == http.StatusTooManyRequests || response.StatusCode >= http.StatusInternalServerError
		retryAfter := time.Duration(0)
		if retryable {
			retryAfter = parseRetryAfter(response.Header.Get("Retry-After"), client.now())
		}
		return Receipt{}, requestFailure(ErrUnexpectedStatus, retryable, retryAfter)
	}
	mediaType, _, mediaError := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if mediaError != nil || mediaType != "application/json" {
		return Receipt{}, requestFailure(ErrInvalidReceipt, true, 0)
	}
	document, err = io.ReadAll(io.LimitReader(response.Body, maximumReceiptBytes+1))
	if err != nil || int64(len(document)) > maximumReceiptBytes {
		return Receipt{}, requestFailure(ErrInvalidReceipt, true, 0)
	}
	receipt, err := decodeReceipt(document)
	if err != nil {
		return Receipt{}, requestFailure(ErrInvalidReceipt, true, 0)
	}
	if receipt.Status != "accepted" || receipt.StreamID != envelope.StreamID || receipt.Sequence != envelope.Sequence {
		return Receipt{}, requestFailure(ErrReceiptMismatch, true, 0)
	}
	return receipt, nil
}

func validateEnvelope(envelope Envelope) error {
	if envelope.Schema != Schema || !validStreamID(envelope.StreamID) || envelope.Sequence == 0 || envelope.SampledAt.IsZero() {
		return ErrInvalidEnvelope
	}
	return nil
}

func credentialError(err error) error {
	switch {
	case errors.Is(err, ErrCredentialInsecure):
		return ErrCredentialInsecure
	case errors.Is(err, ErrCredentialInvalid):
		return ErrCredentialInvalid
	default:
		return ErrCredentialRead
	}
}

func requestFailure(kind error, retryable bool, retryAfter time.Duration) error {
	return &RequestError{kind: kind, retryable: retryable, retryAfter: retryAfter}
}

func decodeReceipt(document []byte) (Receipt, error) {
	decoder := json.NewDecoder(bytes.NewReader(document))
	opening, err := decoder.Token()
	if err != nil || opening != json.Delim('{') {
		return Receipt{}, ErrInvalidReceipt
	}
	receipt := Receipt{}
	seen := make(map[string]bool, 3)
	for decoder.More() {
		keyToken, err := decoder.Token()
		key, ok := keyToken.(string)
		if err != nil || !ok || seen[key] {
			return Receipt{}, ErrInvalidReceipt
		}
		seen[key] = true
		switch key {
		case "status":
			err = decoder.Decode(&receipt.Status)
		case "streamId":
			err = decoder.Decode(&receipt.StreamID)
		case "sequence":
			err = decoder.Decode(&receipt.Sequence)
		default:
			return Receipt{}, ErrInvalidReceipt
		}
		if err != nil {
			return Receipt{}, ErrInvalidReceipt
		}
	}
	closing, err := decoder.Token()
	if err != nil || closing != json.Delim('}') || !seen["status"] || !seen["streamId"] || !seen["sequence"] {
		return Receipt{}, ErrInvalidReceipt
	}
	if token, err := decoder.Token(); err != io.EOF || token != nil {
		return Receipt{}, ErrInvalidReceipt
	}
	return receipt, nil
}

func parseRetryAfter(value string, now time.Time) time.Duration {
	if value == "" || strings.TrimSpace(value) != value {
		return 0
	}
	if seconds, err := strconv.ParseUint(value, 10, 31); err == nil {
		return time.Duration(seconds) * time.Second
	}
	if date, err := http.ParseTime(value); err == nil && date.After(now) {
		return date.Sub(now)
	}
	return 0
}

func parseBaseURL(raw string) (*url.URL, error) {
	if raw == "" || strings.TrimSpace(raw) != raw || strings.ContainsAny(raw, `\\?#`) || containsURLControl(raw) {
		return nil, ErrBaseURL
	}
	parsed, err := url.Parse(raw)
	if err != nil || !strings.EqualFold(parsed.Scheme, "https") || parsed.Host == "" || parsed.Hostname() == "" ||
		parsed.User != nil || parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" || parsed.Opaque != "" ||
		parsed.RawPath != "" || (parsed.Path != "" && parsed.Path != "/") || strings.HasSuffix(parsed.Host, ":") {
		return nil, ErrBaseURL
	}
	if port := parsed.Port(); port != "" {
		if number, err := strconv.ParseUint(port, 10, 16); err != nil || number == 0 {
			return nil, ErrBaseURL
		}
	}
	parsed.Scheme = "https"
	parsed.Path = ""
	return parsed, nil
}

func containsURLControl(value string) bool {
	for _, character := range value {
		if unicode.IsControl(character) {
			return true
		}
	}
	return false
}
