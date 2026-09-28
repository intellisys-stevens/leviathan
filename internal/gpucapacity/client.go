package gpucapacity

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

// Client reads the bridge's cached capacity, independently of telemetry and
// attribution polling. Errors never contain response bodies, paths or URLs.
type Client struct{ http *http.Client }

func NewClient(socket string) (*Client, error) {
	if !filepath.IsAbs(socket) || filepath.Clean(socket) != socket {
		return nil, errors.New("capacity socket must be an absolute clean path")
	}
	dialer := &net.Dialer{Timeout: time.Second}
	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return dialer.DialContext(ctx, "unix", socket)
	}, MaxIdleConns: 1, MaxIdleConnsPerHost: 1, IdleConnTimeout: 10 * time.Second, ResponseHeaderTimeout: time.Second, MaxResponseHeaderBytes: 8192}
	return &Client{http: &http.Client{Transport: transport, Timeout: time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}

func (c *Client) Close() { c.http.CloseIdleConnections() }

func (c *Client) Read(ctx context.Context, now time.Time) (Document, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://unix/v1/gpu-capacity", nil)
	if err != nil {
		return Document{}, err
	}
	response, err := c.http.Do(request)
	if err != nil {
		return Document{}, errors.New("GPU capacity bridge is unavailable")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return Document{}, errors.New("GPU capacity is unavailable; check bridge support and configuration")
	}
	if strings.TrimSpace(strings.Split(response.Header.Get("Content-Type"), ";")[0]) != "application/json" {
		return Document{}, errors.New("GPU capacity response is invalid")
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, MaxDocumentBytes+1))
	if err != nil || len(data) > MaxDocumentBytes {
		return Document{}, errors.New("GPU capacity response exceeds its limit")
	}
	var document Document
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&document) != nil || decoder.Decode(&struct{}{}) != io.EOF {
		return Document{}, errors.New("GPU capacity response is invalid")
	}
	if err := document.Validate(); err != nil {
		return Document{}, err
	}
	return document.At(now), nil
}
