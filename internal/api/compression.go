package api

import (
	"compress/gzip"
	"io"
	"net/http"
	"path/filepath"
	"strings"
)

type gzipResponseWriter struct {
	http.ResponseWriter
	writer      *gzip.Writer
	wroteHeader bool
}

func newGzipResponseWriter(writer http.ResponseWriter) (*gzipResponseWriter, error) {
	compressed, err := gzip.NewWriterLevel(writer, gzip.BestSpeed)
	if err != nil {
		return nil, err
	}
	return &gzipResponseWriter{ResponseWriter: writer, writer: compressed}, nil
}

func (w *gzipResponseWriter) WriteHeader(status int) {
	if w.wroteHeader {
		return
	}
	w.Header().Del("Content-Length")
	w.ResponseWriter.WriteHeader(status)
	w.wroteHeader = true
}

func (w *gzipResponseWriter) Write(data []byte) (int, error) {
	if !w.wroteHeader {
		w.WriteHeader(http.StatusOK)
	}
	return w.writer.Write(data)
}

func (w *gzipResponseWriter) Flush() {
	if !w.wroteHeader {
		w.WriteHeader(http.StatusOK)
	}
	_ = w.writer.Flush()
	if flusher, ok := w.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

func (w *gzipResponseWriter) Close() error { return w.writer.Close() }

func (w *gzipResponseWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func acceptsGzip(request *http.Request) bool {
	for _, value := range request.Header.Values("Accept-Encoding") {
		for _, token := range strings.Split(value, ",") {
			parts := strings.Split(token, ";")
			if !strings.EqualFold(strings.TrimSpace(parts[0]), "gzip") {
				continue
			}
			accepted := true
			for _, parameter := range parts[1:] {
				name, value, ok := strings.Cut(strings.TrimSpace(parameter), "=")
				if ok && strings.EqualFold(name, "q") && strings.TrimSpace(value) == "0" {
					accepted = false
				}
			}
			if accepted {
				return true
			}
		}
	}
	return false
}

func alreadyCompressedPath(path string) bool {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".br", ".gz", ".jpeg", ".jpg", ".png", ".webp", ".woff", ".woff2", ".zip":
		return true
	default:
		return false
	}
}

func serveCompressed(writer http.ResponseWriter, request *http.Request, serve func(http.ResponseWriter)) {
	if request.Method == http.MethodHead || request.Header.Get("Range") != "" || alreadyCompressedPath(request.URL.Path) {
		serve(writer)
		return
	}
	writer.Header().Add("Vary", "Accept-Encoding")
	if !acceptsGzip(request) {
		serve(writer)
		return
	}
	compressed, err := newGzipResponseWriter(writer)
	if err != nil {
		serve(writer)
		return
	}
	writer.Header().Set("Content-Encoding", "gzip")
	defer compressed.Close()
	serve(compressed)
}

var _ http.Flusher = (*gzipResponseWriter)(nil)
var _ io.Writer = (*gzipResponseWriter)(nil)
