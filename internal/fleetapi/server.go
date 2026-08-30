// Package fleetapi serves the read-only controller dashboard. It is separate
// from the single-host API so the Nidhogg agent keeps its existing routes and
// outbound-network-free security boundary.
package fleetapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strings"
	"time"

	"github.com/intellisys-stevens/miglens/internal/fleet"
	"github.com/intellisys-stevens/miglens/internal/model"
)

type DataSource interface {
	Current() (fleet.Snapshot, bool)
	Subscribe() (<-chan fleet.Snapshot, func())
}

type Server struct {
	source    DataSource
	assets    fs.FS
	buildInfo model.BuildInfo
	mux       *http.ServeMux
}

func NewServer(source DataSource, assets fs.FS, buildInfo model.BuildInfo) *Server {
	server := &Server{source: source, assets: assets, buildInfo: buildInfo, mux: http.NewServeMux()}
	server.mux.HandleFunc("GET /api/fleet/v1/state", server.state)
	server.mux.HandleFunc("GET /api/fleet/v1/events", server.events)
	server.mux.HandleFunc("GET /api/fleet/v1/version", server.version)
	server.mux.HandleFunc("GET /healthz", server.health)
	server.mux.HandleFunc("/api/", func(writer http.ResponseWriter, _ *http.Request) {
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

func (s *Server) state(writer http.ResponseWriter, _ *http.Request) {
	state, ok := s.source.Current()
	if !ok {
		writeError(writer, http.StatusServiceUnavailable, "fleet state not available")
		return
	}
	writeJSON(writer, http.StatusOK, state)
}

func (s *Server) events(writer http.ResponseWriter, request *http.Request) {
	flusher, ok := writer.(http.Flusher)
	if !ok {
		writeError(writer, http.StatusInternalServerError, "streaming unsupported")
		return
	}
	updates, unsubscribe := s.source.Subscribe()
	defer unsubscribe()

	writer.Header().Set("Content-Type", "text/event-stream")
	writer.Header().Set("Cache-Control", "no-cache, no-store")
	writer.Header().Set("Connection", "keep-alive")
	writer.WriteHeader(http.StatusOK)
	flusher.Flush()

	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case <-request.Context().Done():
			return
		case state, open := <-updates:
			if !open {
				return
			}
			payload, err := json.Marshal(state)
			if err != nil {
				return
			}
			_, _ = fmt.Fprintf(writer, "id: %d\nevent: fleet\ndata: %s\n\n", state.Sequence, payload)
			flusher.Flush()
		case <-heartbeat.C:
			_, _ = writer.Write([]byte(": keepalive\n\n"))
			flusher.Flush()
		}
	}
}

func (s *Server) version(writer http.ResponseWriter, _ *http.Request) {
	writeJSON(writer, http.StatusOK, s.buildInfo)
}

func (s *Server) health(writer http.ResponseWriter, _ *http.Request) {
	state, ok := s.source.Current()
	if !ok {
		writeJSON(writer, http.StatusServiceUnavailable, map[string]string{"status": "starting"})
		return
	}
	status := "ok"
	for _, platform := range state.Platforms {
		if platform.Inventory.Status != fleet.InventoryAvailable {
			status = "degraded"
			break
		}
	}
	writeJSON(writer, http.StatusOK, map[string]any{"status": status, "sequence": state.Sequence})
}

func (s *Server) static(writer http.ResponseWriter, request *http.Request) {
	// The fleet hub deliberately does not expose the single-host /api/v1 API.
	// Send its root to the fleet route so the shared SPA never boots the
	// single-host dashboard against a server that cannot satisfy it. The
	// existing miglens agent uses a different HTTP server and keeps serving its
	// unchanged dashboard at /.
	if request.URL.Path == "/" {
		http.Redirect(writer, request, "/fleet", http.StatusTemporaryRedirect)
		return
	}
	if s.assets == nil {
		http.NotFound(writer, request)
		return
	}
	name := strings.TrimPrefix(path.Clean(request.URL.Path), "/")
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
