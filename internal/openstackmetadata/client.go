// Package openstackmetadata reads the identity of the current OpenStack
// instance from the link-local metadata service. It deliberately exposes only
// the instance UUID and never returns the rest of the metadata document.
package openstackmetadata

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"time"
)

const (
	metadataURL = "http://169.254.169.254/openstack/latest/meta_data.json"

	DefaultTimeout          = 2 * time.Second
	MaximumTimeout          = 5 * time.Second
	DefaultMaxResponseBytes = int64(64 << 10)
	MaximumResponseBytes    = int64(64 << 10)
)

var (
	ErrUnavailable        = errors.New("OpenStack metadata request failed")
	ErrRedirectBlocked    = errors.New("OpenStack metadata redirect is not allowed")
	ErrUnsafeRequest      = errors.New("OpenStack metadata request target is invalid")
	ErrUnexpectedStatus   = errors.New("OpenStack metadata returned an unexpected status")
	ErrResponseTooLarge   = errors.New("OpenStack metadata response exceeds the configured limit")
	ErrInvalidResponse    = errors.New("OpenStack metadata returned an invalid response")
	canonicalInstanceUUID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
)

// Options configures a metadata client. HTTPClient and Transport are trusted
// injection points for tests; production callers should leave both nil. When
// an *http.Transport is supplied, it is cloned and its proxy hook is removed.
// Set at most one of HTTPClient and Transport.
type Options struct {
	HTTPClient *http.Client
	Transport  http.RoundTripper

	Timeout          time.Duration
	MaxResponseBytes int64
}

// Client reads the current instance identity from OpenStack's fixed link-local
// metadata endpoint.
type Client struct {
	client           *http.Client
	maxResponseBytes int64
}

// New constructs a metadata client with bounded response and request time.
func New(options Options) (*Client, error) {
	if options.HTTPClient != nil && options.Transport != nil {
		return nil, errors.New("OpenStack metadata accepts either an HTTP client or a transport")
	}

	timeout := options.Timeout
	if timeout == 0 {
		timeout = DefaultTimeout
	}
	if timeout < 0 || timeout > MaximumTimeout {
		return nil, errors.New("OpenStack metadata timeout must be between 0 and 5s")
	}

	maxResponseBytes := options.MaxResponseBytes
	if maxResponseBytes == 0 {
		maxResponseBytes = DefaultMaxResponseBytes
	}
	if maxResponseBytes < 0 || maxResponseBytes > MaximumResponseBytes {
		return nil, errors.New("OpenStack metadata response limit must be between 0 and 65536 bytes")
	}

	httpClient := &http.Client{}
	if options.HTTPClient != nil {
		copy := *options.HTTPClient
		httpClient = &copy
	}
	transport := httpClient.Transport
	if options.Transport != nil {
		transport = options.Transport
	}
	httpClient.Transport = metadataOnlyTransport{next: withoutProxy(transport)}
	httpClient.Timeout = timeout
	httpClient.Jar = nil
	httpClient.CheckRedirect = func(_ *http.Request, _ []*http.Request) error {
		return ErrRedirectBlocked
	}

	return &Client{client: httpClient, maxResponseBytes: maxResponseBytes}, nil
}

// InstanceUUID returns the canonical lowercase UUID from meta_data.json. All
// other metadata fields are parsed only far enough to validate the JSON and
// then discarded.
func (client *Client) InstanceUUID(ctx context.Context) (string, error) {
	if client == nil || client.client == nil || ctx == nil {
		return "", ErrUnavailable
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, metadataURL, nil)
	if err != nil {
		return "", ErrUnavailable
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("User-Agent", "leviathan-openstack-metadata")

	response, err := client.client.Do(request)
	if err != nil {
		if contextErr := ctx.Err(); contextErr != nil {
			return "", contextErr
		}
		if errors.Is(err, ErrRedirectBlocked) {
			return "", ErrRedirectBlocked
		}
		if errors.Is(err, ErrUnsafeRequest) {
			return "", ErrUnsafeRequest
		}
		return "", ErrUnavailable
	}
	defer response.Body.Close()

	if response.StatusCode != http.StatusOK {
		return "", ErrUnexpectedStatus
	}
	body, err := readBounded(response.Body, client.maxResponseBytes)
	if err != nil {
		return "", err
	}
	return parseInstanceUUID(body)
}

func readBounded(reader io.Reader, limit int64) ([]byte, error) {
	body, err := io.ReadAll(io.LimitReader(reader, limit+1))
	if err != nil {
		return nil, ErrUnavailable
	}
	if int64(len(body)) > limit {
		return nil, ErrResponseTooLarge
	}
	return body, nil
}

func parseInstanceUUID(body []byte) (string, error) {
	decoder := json.NewDecoder(bytes.NewReader(body))
	start, err := decoder.Token()
	if err != nil || start != json.Delim('{') {
		return "", ErrInvalidResponse
	}

	instanceUUID := ""
	foundUUID := false
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return "", ErrInvalidResponse
		}
		key, ok := keyToken.(string)
		if !ok {
			return "", ErrInvalidResponse
		}
		if key == "uuid" {
			if foundUUID || decoder.Decode(&instanceUUID) != nil {
				return "", ErrInvalidResponse
			}
			foundUUID = true
			continue
		}

		var discarded json.RawMessage
		if decoder.Decode(&discarded) != nil {
			return "", ErrInvalidResponse
		}
	}
	end, err := decoder.Token()
	if err != nil || end != json.Delim('}') {
		return "", ErrInvalidResponse
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return "", ErrInvalidResponse
	}
	if !foundUUID || !canonicalInstanceUUID.MatchString(instanceUUID) {
		return "", ErrInvalidResponse
	}
	return instanceUUID, nil
}

type metadataOnlyTransport struct {
	next http.RoundTripper
}

func (transport metadataOnlyTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	if !isExactMetadataRequest(request) {
		return nil, ErrUnsafeRequest
	}
	return transport.next.RoundTrip(request)
}

func isExactMetadataRequest(request *http.Request) bool {
	if request == nil ||
		request.Method != http.MethodGet ||
		(request.Body != nil && request.Body != http.NoBody) ||
		request.ContentLength != 0 ||
		len(request.TransferEncoding) != 0 ||
		request.RequestURI != "" ||
		request.Host != "169.254.169.254" ||
		request.URL == nil {
		return false
	}
	url := request.URL
	return url.Scheme == "http" &&
		url.Host == "169.254.169.254" &&
		url.Hostname() == "169.254.169.254" &&
		url.Port() == "" &&
		!url.OmitHost &&
		url.Path == "/openstack/latest/meta_data.json" &&
		url.RawPath == "" &&
		url.RawQuery == "" &&
		!url.ForceQuery &&
		url.User == nil &&
		url.Fragment == "" &&
		url.RawFragment == "" &&
		url.Opaque == ""
}

func withoutProxy(transport http.RoundTripper) http.RoundTripper {
	if transport == nil {
		transport = http.DefaultTransport
	}
	if standard, ok := transport.(*http.Transport); ok {
		clone := standard.Clone()
		clone.Proxy = nil
		return clone
	}
	return transport
}
