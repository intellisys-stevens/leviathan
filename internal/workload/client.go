package workload

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"path/filepath"
	"strings"
	"time"
)

// Client is called by the independent cgroup worker. Its errors intentionally
// omit URLs, socket paths and response bodies from public diagnostics.
type Client struct{ http *http.Client }

func NewClient(socket string) (*Client, error) {
	if !filepath.IsAbs(socket) || filepath.Clean(socket) != socket {
		return nil, errors.New("workload socket must be an absolute clean path")
	}
	dialer := &net.Dialer{Timeout: time.Second}
	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return dialer.DialContext(ctx, "unix", socket)
	}, MaxIdleConns: 1, MaxIdleConnsPerHost: 1, IdleConnTimeout: 10 * time.Second, ResponseHeaderTimeout: time.Second, MaxResponseHeaderBytes: 8192}
	return &Client{http: &http.Client{Transport: transport, Timeout: time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}

func (c *Client) Close() { c.http.CloseIdleConnections() }

func (c *Client) Read(ctx context.Context, now time.Time) (Document, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://unix/v1/workloads", nil)
	if err != nil {
		return Document{}, err
	}
	response, err := c.http.Do(request)
	if err != nil {
		return Document{}, errors.New("Workspace inventory connection is unavailable")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return Document{}, errors.New("Workspace inventory is unavailable; check bridge configuration and Pod permissions")
	}
	if strings.TrimSpace(strings.Split(response.Header.Get("Content-Type"), ";")[0]) != "application/json" {
		return Document{}, errors.New("Workspace inventory returned invalid content")
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, MaxDocumentBytes+1))
	if err != nil || len(data) > MaxDocumentBytes {
		return Document{}, errors.New("Workspace inventory exceeds its response limit")
	}
	var document Document
	decoder := json.NewDecoder(bytes.NewReader(data))
	if err = decoder.Decode(&document); err != nil {
		return Document{}, errors.New("Workspace inventory is invalid")
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		return Document{}, errors.New("Workspace inventory contains trailing data")
	}
	if err = document.Validate(); err != nil {
		return Document{}, err
	}
	if document.GeneratedAt.After(now.Add(5*time.Second)) || document.ObservedAt.After(now.Add(5*time.Second)) || now.Sub(document.GeneratedAt) > 15*time.Second || now.Sub(document.ObservedAt) > 15*time.Second {
		return Document{}, errors.New("Workspace inventory is stale")
	}
	return document, nil
}
