package kubernetesbridge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/intellisys-stevens/leviathan/internal/attribution"
)

type Server struct {
	state *State
	now   func() time.Time
}

func NewServer(state *State) *Server {
	return &Server{state: state, now: func() time.Time { return time.Now().UTC() }}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/allocations", s.allocations)
	mux.HandleFunc("GET /livez", func(writer http.ResponseWriter, _ *http.Request) {
		writeJSON(writer, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("GET /readyz", func(writer http.ResponseWriter, _ *http.Request) {
		if !s.state.Ready() {
			writeJSON(writer, http.StatusServiceUnavailable, map[string]string{"status": "not_ready"})
			return
		}
		writeJSON(writer, http.StatusOK, map[string]string{"status": "ok"})
	})
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Cache-Control", "no-store")
		writer.Header().Set("X-Content-Type-Options", "nosniff")
		mux.ServeHTTP(writer, request)
	})
}

func (s *Server) allocations(writer http.ResponseWriter, _ *http.Request) {
	document := s.state.Document(s.now())
	if err := document.Validate(); err != nil {
		writeJSON(writer, http.StatusServiceUnavailable, map[string]string{"error": "attribution inventory is invalid"})
		return
	}
	data, err := json.Marshal(document)
	if err != nil || len(data) > attribution.MaxDocumentBytes {
		writeJSON(writer, http.StatusServiceUnavailable, map[string]string{"error": "attribution inventory exceeds the handoff limit"})
		return
	}
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(http.StatusOK)
	_, _ = writer.Write(append(data, '\n'))
}

func ServeUnix(ctx context.Context, socketPath string, handler http.Handler) error {
	if err := prepareSocketPath(socketPath); err != nil {
		return err
	}
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		return fmt.Errorf("listen on attribution socket: %w", err)
	}
	defer listener.Close()
	defer removeSocket(socketPath)
	if err := os.Chmod(socketPath, 0o600); err != nil {
		return fmt.Errorf("set attribution socket permissions: %w", err)
	}
	server := &http.Server{
		Handler: handler, ReadHeaderTimeout: 2 * time.Second, ReadTimeout: 2 * time.Second,
		WriteTimeout: 2 * time.Second, IdleTimeout: 15 * time.Second, MaxHeaderBytes: 8 << 10,
		ErrorLog: log.New(io.Discard, "", 0),
	}
	done := make(chan error, 1)
	go func() { done <- server.Serve(listener) }()
	select {
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
		err = <-done
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case err = <-done:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
}

func prepareSocketPath(path string) error {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return errors.New("attribution socket must be an absolute clean path")
	}
	directory := filepath.Dir(path)
	info, err := os.Lstat(directory)
	if err != nil {
		return fmt.Errorf("inspect attribution socket directory: %w", err)
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("attribution socket parent is not a real directory")
	}
	resolved, err := filepath.EvalSymlinks(directory)
	if err != nil || resolved != directory {
		return errors.New("attribution socket parent contains a symbolic link")
	}
	info, err = os.Lstat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect existing attribution socket: %w", err)
	}
	if info.Mode()&os.ModeSocket == 0 {
		return errors.New("refusing to replace a non-socket attribution path")
	}
	if err := os.Remove(path); err != nil {
		return fmt.Errorf("remove stale attribution socket: %w", err)
	}
	return nil
}

func removeSocket(path string) {
	info, err := os.Lstat(path)
	if err == nil && info.Mode()&os.ModeSocket != 0 {
		_ = os.Remove(path)
	}
}

func writeJSON(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(value)
}
