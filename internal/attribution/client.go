package attribution

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/intellisys-stevens/miglens/internal/model"
)

type ClientOptions struct {
	SocketPath       string
	PollInterval     time.Duration
	StaleAfter       time.Duration
	ExpireAfter      time.Duration
	RequestTimeout   time.Duration
	MaxDocumentBytes int64
	Now              func() time.Time
}

func DefaultClientOptions(socketPath string) ClientOptions {
	return ClientOptions{
		SocketPath: socketPath, PollInterval: 5 * time.Second, StaleAfter: 15 * time.Second,
		ExpireAfter: 60 * time.Second, RequestTimeout: 2 * time.Second,
		MaxDocumentBytes: MaxDocumentBytes, Now: func() time.Time { return time.Now().UTC() },
	}
}

type Client struct {
	options ClientOptions
	http    *http.Client
	pollMu  sync.Mutex

	mu         sync.RWMutex
	document   *Document
	receivedAt time.Time
	cancel     context.CancelFunc
	done       chan struct{}
}

func NewClient(options ClientOptions) (*Client, error) {
	if strings.TrimSpace(options.SocketPath) == "" || !filepath.IsAbs(options.SocketPath) || filepath.Clean(options.SocketPath) != options.SocketPath {
		return nil, errors.New("attribution socket path is required")
	}
	if options.PollInterval <= 0 || options.StaleAfter <= 0 || options.ExpireAfter <= options.StaleAfter {
		return nil, errors.New("invalid attribution polling or freshness durations")
	}
	if options.RequestTimeout <= 0 || options.MaxDocumentBytes <= 0 || options.MaxDocumentBytes > MaxDocumentBytes {
		return nil, errors.New("invalid attribution request bounds")
	}
	if options.Now == nil {
		return nil, errors.New("attribution clock is required")
	}
	dialer := &net.Dialer{Timeout: options.RequestTimeout}
	transport := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return dialer.DialContext(ctx, "unix", options.SocketPath)
		},
		MaxIdleConns: 1, MaxIdleConnsPerHost: 1, IdleConnTimeout: options.PollInterval,
		ResponseHeaderTimeout: options.RequestTimeout, MaxResponseHeaderBytes: 8 << 10,
	}
	return &Client{options: options, http: &http.Client{Transport: transport, Timeout: options.RequestTimeout}}, nil
}

func (c *Client) Start(parent context.Context) {
	c.mu.Lock()
	if c.cancel != nil {
		c.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(parent)
	c.cancel = cancel
	c.done = make(chan struct{})
	done := c.done
	c.mu.Unlock()
	go c.loop(ctx, done)
}

func (c *Client) loop(ctx context.Context, done chan struct{}) {
	defer close(done)
	_ = c.Poll(ctx)
	ticker := time.NewTicker(c.options.PollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			_ = c.Poll(ctx)
		}
	}
}

func (c *Client) Close() {
	c.mu.Lock()
	cancel, done := c.cancel, c.done
	c.cancel, c.done = nil, nil
	c.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	if done != nil {
		<-done
	}
	if transport, ok := c.http.Transport.(*http.Transport); ok {
		transport.CloseIdleConnections()
	}
}

// Poll performs one bounded handoff request. It is exported for health checks
// and deterministic tests; normal callers use Start.
func (c *Client) Poll(ctx context.Context) error {
	c.pollMu.Lock()
	defer c.pollMu.Unlock()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://unix/v1/allocations", nil)
	if err != nil {
		return err
	}
	response, err := c.http.Do(request)
	if err != nil {
		return fmt.Errorf("bridge request: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4<<10))
		return fmt.Errorf("bridge returned HTTP %d", response.StatusCode)
	}
	mediaType := strings.ToLower(strings.TrimSpace(strings.Split(response.Header.Get("Content-Type"), ";")[0]))
	if mediaType != "application/json" {
		return errors.New("bridge returned a non-JSON response")
	}
	limited := io.LimitReader(response.Body, c.options.MaxDocumentBytes+1)
	data, err := io.ReadAll(limited)
	if err != nil {
		return fmt.Errorf("read bridge response: %w", err)
	}
	if int64(len(data)) > c.options.MaxDocumentBytes {
		return errors.New("bridge response exceeds the configured limit")
	}
	var document Document
	decoder := json.NewDecoder(bytes.NewReader(data))
	if err := decoder.Decode(&document); err != nil {
		return fmt.Errorf("decode bridge response: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("bridge response contains trailing JSON")
	}
	if err := document.Validate(); err != nil {
		return err
	}
	now := c.options.Now().UTC()
	if document.GeneratedAt.After(now.Add(time.Minute)) || document.SourceObservedAt.After(now.Add(time.Minute)) {
		return errors.New("bridge response contains a future timestamp")
	}
	if !document.Status.HasValidInventory {
		return nil
	}
	c.mu.Lock()
	c.document = &document
	c.receivedAt = now
	c.mu.Unlock()
	return nil
}

func (c *Client) Current(now time.Time) model.Attribution {
	c.mu.RLock()
	document, receivedAt := c.document, c.receivedAt
	c.mu.RUnlock()
	if document == nil {
		return emptyAttribution()
	}

	freshAt := receivedAt
	if document.SourceObservedAt.Before(freshAt) {
		freshAt = document.SourceObservedAt
	}
	age := now.UTC().Sub(freshAt)
	if age < 0 {
		age = 0
	}
	workloads := append([]model.WorkloadAttribution(nil), document.Workloads...)
	assignments := append([]model.ResourceAssignment(nil), document.Assignments...)
	if age >= c.options.ExpireAfter {
		return emptyAttribution()
	}

	status := model.AttributionAvailable
	if age >= c.options.StaleAfter {
		status = model.AttributionStale
	}
	observedAt := document.SourceObservedAt.UTC()
	return model.Attribution{
		Provider: model.AttributionProviderKubernetesDRA, Status: status, ObservedAt: &observedAt,
		Workloads: workloads, Assignments: assignments,
	}
}

func emptyAttribution() model.Attribution {
	return model.Attribution{
		Provider: model.AttributionProviderKubernetesDRA, Status: model.AttributionUnavailable,
		Workloads: []model.WorkloadAttribution{}, Assignments: []model.ResourceAssignment{},
	}
}
