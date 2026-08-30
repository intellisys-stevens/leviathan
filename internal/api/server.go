package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strings"
	"sync"
	"time"

	"github.com/intellisys-stevens/miglens/internal/history"
	"github.com/intellisys-stevens/miglens/internal/model"
)

type DataSource interface {
	Current() (model.Snapshot, bool)
	History(entity string, metrics []string, window time.Duration, now time.Time) history.Series
	Subscribe() (<-chan model.Snapshot, func())
	Capabilities() model.Capabilities
	LastError() error
	RuntimeSettings() model.RuntimeSettings
	SetSamplingInterval(time.Duration) error
}

type Server struct {
	source    DataSource
	assets    fs.FS
	buildInfo model.BuildInfo
	mux       *http.ServeMux

	settingsMu          sync.Mutex
	settingsSubscribers map[uint64]chan model.RuntimeSettings
	nextSettingsSubID   uint64
}

func NewServer(source DataSource, assets fs.FS, buildInfo model.BuildInfo) *Server {
	server := &Server{
		source:              source,
		assets:              assets,
		buildInfo:           buildInfo,
		mux:                 http.NewServeMux(),
		settingsSubscribers: make(map[uint64]chan model.RuntimeSettings),
	}
	server.mux.HandleFunc("GET /api/v1/snapshot", server.snapshot)
	server.mux.HandleFunc("GET /api/v1/history", server.history)
	server.mux.HandleFunc("GET /api/v1/events", server.events)
	server.mux.HandleFunc("GET /api/v1/capabilities", server.capabilities)
	server.mux.HandleFunc("GET /api/v1/settings", server.getSettings)
	server.mux.HandleFunc("PATCH /api/v1/settings", server.patchSettings)
	server.mux.HandleFunc("GET /api/v1/version", server.version)
	server.mux.HandleFunc("GET /healthz", server.health)
	server.mux.HandleFunc("/api/", func(writer http.ResponseWriter, request *http.Request) {
		writeError(writer, http.StatusNotFound, "API endpoint not found")
	})
	server.mux.HandleFunc("/", server.static)
	return server
}

func (s *Server) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("X-Content-Type-Options", "nosniff")
	writer.Header().Set("Referrer-Policy", "no-referrer")
	writer.Header().Set("X-Frame-Options", "DENY")
	writer.Header().Set("Content-Security-Policy", "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'")
	s.mux.ServeHTTP(writer, request)
}

func (s *Server) snapshot(writer http.ResponseWriter, _ *http.Request) {
	snapshot, ok := s.source.Current()
	if !ok {
		writeError(writer, http.StatusServiceUnavailable, "snapshot not available")
		return
	}
	writeJSON(writer, http.StatusOK, snapshot)
}

func (s *Server) history(writer http.ResponseWriter, request *http.Request) {
	entity := strings.TrimSpace(request.URL.Query().Get("entity"))
	if entity == "" {
		writeError(writer, http.StatusBadRequest, "entity is required")
		return
	}
	metrics := splitList(request.URL.Query().Get("metrics"))
	window := 30 * time.Minute
	if raw := request.URL.Query().Get("window"); raw != "" {
		parsed, err := time.ParseDuration(raw)
		if err != nil || parsed <= 0 {
			writeError(writer, http.StatusBadRequest, "window must be a positive Go duration such as 5m")
			return
		}
		window = parsed
	}
	writeJSON(writer, http.StatusOK, s.source.History(entity, metrics, window, time.Now().UTC()))
}

func (s *Server) capabilities(writer http.ResponseWriter, _ *http.Request) {
	writeJSON(writer, http.StatusOK, s.source.Capabilities())
}

func (s *Server) getSettings(writer http.ResponseWriter, _ *http.Request) {
	writeJSON(writer, http.StatusOK, s.source.RuntimeSettings())
}

func (s *Server) version(writer http.ResponseWriter, _ *http.Request) {
	writeJSON(writer, http.StatusOK, s.buildInfo)
}

func (s *Server) patchSettings(writer http.ResponseWriter, request *http.Request) {
	mediaType, _, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		writeError(writer, http.StatusUnsupportedMediaType, "Content-Type must be application/json")
		return
	}

	request.Body = http.MaxBytesReader(writer, request.Body, 4<<10)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	var patch struct {
		SamplingIntervalMs *int64 `json:"samplingIntervalMs"`
	}
	if err := decoder.Decode(&patch); err != nil {
		writeError(writer, http.StatusBadRequest, "invalid settings body")
		return
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		writeError(writer, http.StatusBadRequest, "settings body must contain one JSON object")
		return
	}
	if patch.SamplingIntervalMs == nil || !containsInterval(
		s.source.RuntimeSettings().AllowedSamplingIntervalsMs,
		*patch.SamplingIntervalMs,
	) {
		writeError(writer, http.StatusBadRequest, "samplingIntervalMs must be 500, 1000, or 2000")
		return
	}
	if err := s.source.SetSamplingInterval(time.Duration(*patch.SamplingIntervalMs) * time.Millisecond); err != nil {
		writeError(writer, http.StatusBadRequest, err.Error())
		return
	}
	settings := s.source.RuntimeSettings()
	s.publishSettings(settings)
	writeJSON(writer, http.StatusOK, settings)
}

func containsInterval(allowed []int64, value int64) bool {
	for _, interval := range allowed {
		if interval == value {
			return true
		}
	}
	return false
}

func (s *Server) health(writer http.ResponseWriter, _ *http.Request) {
	snapshot, ok := s.source.Current()
	if !ok {
		message := "snapshot not available"
		if err := s.source.LastError(); err != nil {
			message = err.Error()
		}
		writeError(writer, http.StatusServiceUnavailable, message)
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"status": "ok", "sampledAt": snapshot.SampledAt})
}

func (s *Server) events(writer http.ResponseWriter, request *http.Request) {
	flusher, ok := writer.(http.Flusher)
	if !ok {
		writeError(writer, http.StatusInternalServerError, "streaming is not supported")
		return
	}
	writer.Header().Set("Content-Type", "text/event-stream")
	writer.Header().Set("Cache-Control", "no-cache, no-store")
	writer.Header().Set("Connection", "keep-alive")
	writer.Header().Set("X-Accel-Buffering", "no")
	_, _ = fmt.Fprint(writer, "retry: 1500\n\n")
	flusher.Flush()

	events, unsubscribe := s.source.Subscribe()
	defer unsubscribe()
	settingsEvents, unsubscribeSettings := s.subscribeSettings()
	defer unsubscribeSettings()
	keepalive := time.NewTicker(15 * time.Second)
	defer keepalive.Stop()
	for {
		select {
		case <-request.Context().Done():
			return
		case snapshot, open := <-events:
			if !open {
				return
			}
			data, err := json.Marshal(snapshot)
			if err != nil {
				return
			}
			_, _ = fmt.Fprintf(writer, "id: %d\nevent: snapshot\ndata: %s\n\n", snapshot.Sequence, data)
			flusher.Flush()
		case settings, open := <-settingsEvents:
			if !open {
				return
			}
			data, err := json.Marshal(settings)
			if err != nil {
				return
			}
			_, _ = fmt.Fprintf(writer, "event: settings\ndata: %s\n\n", data)
			flusher.Flush()
		case <-keepalive.C:
			_, _ = fmt.Fprint(writer, ": keepalive\n\n")
			flusher.Flush()
		}
	}
}

func (s *Server) subscribeSettings() (<-chan model.RuntimeSettings, func()) {
	s.settingsMu.Lock()
	defer s.settingsMu.Unlock()
	s.nextSettingsSubID++
	id := s.nextSettingsSubID
	channel := make(chan model.RuntimeSettings, 1)
	s.settingsSubscribers[id] = channel
	channel <- s.source.RuntimeSettings()
	return channel, func() {
		s.settingsMu.Lock()
		defer s.settingsMu.Unlock()
		if existing, ok := s.settingsSubscribers[id]; ok {
			delete(s.settingsSubscribers, id)
			close(existing)
		}
	}
}

func (s *Server) publishSettings(settings model.RuntimeSettings) {
	s.settingsMu.Lock()
	defer s.settingsMu.Unlock()
	for _, channel := range s.settingsSubscribers {
		select {
		case channel <- settings:
		default:
			select {
			case <-channel:
			default:
			}
			select {
			case channel <- settings:
			default:
			}
		}
	}
}

func (s *Server) static(writer http.ResponseWriter, request *http.Request) {
	if s.assets == nil {
		http.NotFound(writer, request)
		return
	}
	name := strings.TrimPrefix(path.Clean(request.URL.Path), "/")
	if name == "." || name == "" {
		name = "index.html"
	}
	data, err := fs.ReadFile(s.assets, name)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			writeError(writer, http.StatusInternalServerError, "embedded asset unavailable")
			return
		}
		name = "index.html"
		data, err = fs.ReadFile(s.assets, name)
		if err != nil {
			http.NotFound(writer, request)
			return
		}
	}
	contentType := mime.TypeByExtension(path.Ext(name))
	if contentType == "" {
		contentType = http.DetectContentType(data)
	}
	writer.Header().Set("Content-Type", contentType)
	if name == "index.html" {
		writer.Header().Set("Cache-Control", "no-cache")
	} else if strings.Contains(name, "/assets/") || strings.HasPrefix(name, "assets/") {
		writer.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	}
	writer.WriteHeader(http.StatusOK)
	_, _ = writer.Write(data)
}

func splitList(value string) []string {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	parts := strings.Split(value, ",")
	result := make([]string, 0, len(parts))
	for _, part := range parts {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			result = append(result, trimmed)
		}
	}
	return result
}

func writeJSON(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Content-Type", "application/json")
	writer.Header().Set("Cache-Control", "no-store")
	writer.WriteHeader(status)
	encoder := json.NewEncoder(writer)
	encoder.SetEscapeHTML(true)
	_ = encoder.Encode(value)
}

func writeError(writer http.ResponseWriter, status int, message string) {
	writeJSON(writer, status, map[string]string{"error": message})
}
