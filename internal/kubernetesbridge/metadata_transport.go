package kubernetesbridge

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strings"

	"k8s.io/client-go/rest"
)

// MetadataOnlyConfig disables client-go's ordinary JSON fallback and validates
// JSON frames before its decoder can fall back to full Pod resources. This
// wrapper is used only by the optional metadata client, never the DRA client.
func MetadataOnlyConfig(config *rest.Config) *rest.Config {
	copy := rest.CopyConfig(config)
	copy.Wrap(func(next http.RoundTripper) http.RoundTripper { return metadataTransport{next: next} })
	return copy
}

type metadataTransport struct{ next http.RoundTripper }

func (t metadataTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	request = request.Clone(request.Context())
	// Keep the metadata kind selected by client-go. Advertising a single
	// object's kind first for a collection produces HTTP 406 on Kubernetes;
	// the server does not retry conversion using the next Accept candidate.
	// Remove protobuf and unrestricted JSON, since the body gate validates JSON.
	accepted := []string{}
	for _, candidate := range strings.Split(request.Header.Get("Accept"), ",") {
		mediaType, parameters, err := mime.ParseMediaType(strings.TrimSpace(candidate))
		if err == nil && mediaType == "application/json" && parameters["g"] == "meta.k8s.io" && parameters["v"] == "v1" && (parameters["as"] == "PartialObjectMetadata" || parameters["as"] == "PartialObjectMetadataList") {
			accepted = append(accepted, strings.TrimSpace(candidate))
		}
	}
	if len(accepted) != 1 {
		return nil, errors.New("Kubernetes request has no unambiguous metadata-only JSON representation")
	}
	request.Header.Set("Accept", accepted[0])
	response, err := t.next.RoundTrip(request)
	if err != nil {
		return nil, err
	}
	if response.StatusCode >= 200 && response.StatusCode < 300 {
		// A bounded stream reconnects after 4 MiB. This also bounds a server
		// response that ignores pagination or metadata-only content negotiation.
		response.Body = &metadataBody{original: response.Body, decoder: json.NewDecoder(io.LimitReader(response.Body, 4<<20)), watch: request.URL.Query().Get("watch") == "true"}
	}
	return response, nil
}

type metadataBody struct {
	original io.ReadCloser
	decoder  *json.Decoder
	buffer   bytes.Buffer
	watch    bool
}

func (b *metadataBody) Close() error { return b.original.Close() }
func (b *metadataBody) Read(out []byte) (int, error) {
	if b.buffer.Len() == 0 {
		var frame json.RawMessage
		if err := b.decoder.Decode(&frame); err != nil {
			return 0, err
		}
		if !validMetadataFrame(frame, b.watch) {
			return 0, errors.New("Kubernetes response is not metadata-only")
		}
		b.buffer.Write(frame)
		b.buffer.WriteByte('\n')
	}
	return b.buffer.Read(out)
}
func validMetadataFrame(raw json.RawMessage, watch bool) bool {
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil {
		return false
	}
	if watch {
		var event string
		if json.Unmarshal(fields["type"], &event) != nil {
			return false
		}
		if event == "ERROR" {
			var status struct {
				Kind string `json:"kind"`
			}
			return json.Unmarshal(fields["object"], &status) == nil && status.Kind == "Status"
		}
		return (event == "ADDED" || event == "MODIFIED" || event == "DELETED" || event == "BOOKMARK") && validMetadataFrame(fields["object"], false)
	}
	var kind string
	if json.Unmarshal(fields["kind"], &kind) != nil {
		return false
	}
	switch kind {
	case "PartialObjectMetadata":
		for key := range fields {
			if key != "apiVersion" && key != "kind" && key != "metadata" {
				return false
			}
		}
		return true
	case "PartialObjectMetadataList":
		for key := range fields {
			if key != "apiVersion" && key != "kind" && key != "metadata" && key != "items" {
				return false
			}
		}
		var items []map[string]json.RawMessage
		if json.Unmarshal(fields["items"], &items) != nil {
			return false
		}
		for _, item := range items {
			for key := range item {
				if key != "apiVersion" && key != "kind" && key != "metadata" {
					return false
				}
			}
			if value, ok := item["kind"]; ok {
				var itemKind string
				if json.Unmarshal(value, &itemKind) != nil || (itemKind != "PartialObjectMetadata" && itemKind != "") {
					return false
				}
			}
		}
		return true
	default:
		return false
	}
}
