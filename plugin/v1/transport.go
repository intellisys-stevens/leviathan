package v1

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const MaxDocumentBytes = 4 << 20
const ManifestPath = "/plugin/v1/manifest"
const ObservationPath = "/plugin/v1/observations/"

type Client struct {
	http     *http.Client
	mu       sync.Mutex
	manifest Manifest
	last     map[Capability]Observation
	instance string
	session  string
	retired  []string
}

func NewUnixClient(socket string) (*Client, error) {
	if !filepath.IsAbs(socket) || filepath.Clean(socket) != socket {
		return nil, errors.New("plugin socket must be an absolute clean path")
	}
	dialer := &net.Dialer{Timeout: 2 * time.Second}
	transport := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return dialer.DialContext(ctx, "unix", socket)
		},
		MaxIdleConns: 8, MaxIdleConnsPerHost: 8, IdleConnTimeout: 30 * time.Second,
		ResponseHeaderTimeout: 2 * time.Second, MaxResponseHeaderBytes: 8 << 10,
	}
	return &Client{http: &http.Client{Transport: transport, Timeout: 3 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, last: map[Capability]Observation{}}, nil
}

func (c *Client) get(ctx context.Context, path string, target any) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://unix"+path, nil)
	if err != nil {
		return err
	}
	response, err := c.http.Do(request)
	if err != nil {
		return errors.New("plugin connection is unavailable")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("plugin returned HTTP %d", response.StatusCode)
	}
	mediaType, _, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		return errors.New("plugin response must be application/json")
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, MaxDocumentBytes+1))
	if err = decoder.Decode(target); err != nil {
		return fmt.Errorf("decode plugin response: %w", err)
	}
	if decoder.InputOffset() > MaxDocumentBytes {
		return errors.New("plugin response exceeds size limit")
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		return errors.New("plugin response must contain one JSON object")
	}
	return nil
}

func (c *Client) Open(ctx context.Context) error {
	var manifest Manifest
	if err := c.get(ctx, ManifestPath, &manifest); err != nil {
		return err
	}
	if err := manifest.Validate(); err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.manifest = manifest
	c.last = map[Capability]Observation{}
	c.instance, c.session = "", ""
	c.retired = nil
	return nil
}

func (c *Client) Manifest() Manifest {
	c.mu.Lock()
	defer c.mu.Unlock()
	m := c.manifest
	m.Capabilities = map[Capability]string{}
	for key, value := range c.manifest.Capabilities {
		m.Capabilities[key] = value
	}
	return m
}

func (c *Client) Read(ctx context.Context, capability Capability, now time.Time) (Observation, error) {
	if c.Manifest().Capabilities[capability] != "1" {
		return Observation{}, fmt.Errorf("plugin does not provide %q", capability)
	}
	var observation Observation
	if err := c.get(ctx, ObservationPath+string(capability), &observation); err != nil {
		return Observation{}, err
	}
	if err := observation.ValidateAt(now); err != nil {
		return Observation{}, err
	}
	if observation.Capability != capability {
		return Observation{}, errors.New("plugin returned the wrong capability")
	}
	c.mu.Lock()
	needsManifest := c.session != observation.SessionID
	c.mu.Unlock()
	var manifest Manifest
	if needsManifest {
		// A supervisor may replace the socket's process while the client stays
		// open. Validate its descriptor before accepting the new session. The
		// network request does not hold the lock needed by other capabilities.
		if err := c.get(ctx, ManifestPath, &manifest); err != nil {
			return Observation{}, err
		}
		if err := manifest.Validate(); err != nil {
			return Observation{}, err
		}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.instance != "" && c.instance != observation.InstanceID {
		return Observation{}, errors.New("plugin producer identity changed")
	}
	for _, retired := range c.retired {
		if retired == observation.SessionID {
			return Observation{}, errors.New("plugin returned a retired session")
		}
	}
	if c.session != observation.SessionID {
		if !needsManifest || manifest.ID != c.manifest.ID || manifest.Capabilities[capability] != "1" {
			return Observation{}, errors.New("restarted plugin changed implementation or capability")
		}
		if c.session != "" {
			c.retired = append(c.retired, c.session)
			if len(c.retired) > 64 {
				c.retired = c.retired[1:]
			}
		}
		c.manifest, c.session, c.instance = manifest, observation.SessionID, observation.InstanceID
	}
	if previous, ok := c.last[capability]; ok {
		if previous.InstanceID != observation.InstanceID {
			return Observation{}, errors.New("plugin producer identity changed")
		}
		if previous.SessionID == observation.SessionID && (observation.Revision < previous.Revision || observation.ObservedAt.Before(previous.ObservedAt)) {
			return Observation{}, errors.New("plugin observation moved backwards")
		}
	}
	// Retain only the envelope for ordering, not a second copy of all telemetry.
	c.last[capability] = Observation{InstanceID: observation.InstanceID, SessionID: observation.SessionID, Revision: observation.Revision, ObservedAt: observation.ObservedAt}
	return observation, nil
}

func (c *Client) Close() error { c.http.CloseIdleConnections(); return nil }

type HandlerOptions struct{ InstanceID string }

// NewHandler serves an already-open Source. The external supervisor owns the
// process; serving never starts subprocesses or changes source timestamps.
func NewHandler(source Source, options HandlerOptions) (http.Handler, error) {
	if !ValidID(options.InstanceID) {
		return nil, errors.New("plugin instance ID is required")
	}
	manifest := source.Manifest()
	if err := manifest.Validate(); err != nil {
		return nil, err
	}
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return nil, err
	}
	session := hex.EncodeToString(random[:])
	mux := http.NewServeMux()
	mux.HandleFunc("GET "+ManifestPath, func(w http.ResponseWriter, r *http.Request) { writeJSON(w, http.StatusOK, manifest) })
	mux.HandleFunc("GET "+ObservationPath+"{capability}", func(w http.ResponseWriter, r *http.Request) {
		capability := Capability(r.PathValue("capability"))
		if manifest.Capabilities[capability] != "1" {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "unsupported capability"})
			return
		}
		observation, err := source.Read(r.Context(), capability, time.Now().UTC())
		if err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "plugin observation unavailable"})
			return
		}
		observation.InstanceID, observation.SessionID = options.InstanceID, session
		if observation.Capability != capability || observation.ValidateAt(time.Now().UTC()) != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "plugin observation invalid"})
			return
		}
		writeJSON(w, http.StatusOK, observation)
	})
	return mux, nil
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	data, err := json.Marshal(value)
	if err != nil || len(data) > MaxDocumentBytes {
		http.Error(w, "plugin response invalid", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = w.Write(append(data, '\n'))
}

// ServeUnix is a convenience for independently supervised plugin executables.
// An existing socket is not replaced; the supervisor must stop its owner first.
func ServeUnix(ctx context.Context, socket string, source Source, options HandlerOptions) error {
	if !filepath.IsAbs(socket) || filepath.Clean(socket) != socket {
		return errors.New("plugin socket must be an absolute clean path")
	}
	if err := source.Open(ctx); err != nil {
		return err
	}
	defer source.Close()
	handler, err := NewHandler(source, options)
	if err != nil {
		return err
	}
	listener, err := net.Listen("unix", socket)
	if err != nil {
		return err
	}
	defer listener.Close()
	if err = os.Chmod(socket, 0600); err != nil {
		return err
	}
	server := &http.Server{Handler: handler, ReadHeaderTimeout: 2 * time.Second, ReadTimeout: 3 * time.Second, WriteTimeout: 3 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 8 << 10}
	done := make(chan error, 1)
	go func() { done <- server.Serve(listener) }()
	select {
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
		err = <-done
	case err = <-done:
	}
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}
