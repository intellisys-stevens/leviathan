package kubernetesbridge

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/metadata"
	"k8s.io/client-go/rest"
)

func TestMetadataClientRejectsOrdinaryPodFallback(t *testing.T) {
	for _, kind := range []string{"PodList", "PartialObjectMetadataList"} {
		t.Run(kind, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				for _, accept := range strings.Split(r.Header.Get("Accept"), ",") {
					if !strings.Contains(accept, "as=PartialObjectMetadata") {
						t.Errorf("unrestricted fallback Accept: %q", accept)
					}
				}
				w.Header().Set("Content-Type", "application/json")
				if kind == "PodList" {
					io.WriteString(w, `{"apiVersion":"v1","kind":"PodList","items":[{"metadata":{"name":"sample"},"spec":{"containers":[]}}]}`)
				} else {
					io.WriteString(w, `{"apiVersion":"meta.k8s.io/v1","kind":"PartialObjectMetadataList","metadata":{},"items":[]}`)
				}
			}))
			defer server.Close()
			client, err := metadata.NewForConfig(MetadataOnlyConfig(&rest.Config{Host: server.URL}))
			if err != nil {
				t.Fatal(err)
			}
			_, err = client.Resource(podsResource).Namespace("synthetic").List(context.Background(), metav1.ListOptions{})
			if kind == "PodList" && err == nil {
				t.Fatal("full Pod JSON fallback accepted")
			}
			if kind == "PartialObjectMetadataList" && err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestMetadataWatchRejectsSpecPayloads(t *testing.T) {
	for _, raw := range []string{`{"type":"ADDED","object":{"kind":"Pod","spec":{}}}`, `{"type":"ADDED","object":{"kind":"PartialObjectMetadata","spec":{}}}`} {
		if validMetadataFrame([]byte(raw), true) {
			t.Fatal("full-resource event accepted")
		}
	}
	if !validMetadataFrame([]byte(`{"type":"ADDED","object":{"apiVersion":"meta.k8s.io/v1","kind":"PartialObjectMetadata","metadata":{"name":"x"}}}`), true) {
		t.Fatal("metadata event rejected")
	}
}

func TestMetadataNegotiationPreservesListAndSingleKinds(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		want := "PartialObjectMetadataList"
		if r.URL.Query().Get("watch") == "true" || strings.HasSuffix(r.URL.Path, "/sample") {
			want = "PartialObjectMetadata"
		}
		// Real Kubernetes selects the first acceptable target and responds406
		// when a single-object representation is requested for a collection.
		if r.Header.Get("Accept") != "application/json;as="+want+";g=meta.k8s.io;v=v1" {
			w.WriteHeader(http.StatusNotAcceptable)
			io.WriteString(w, `{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"NotAcceptable","code":406}`)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Query().Get("watch") == "true" {
			io.WriteString(w, `{"type":"ADDED","object":{"apiVersion":"meta.k8s.io/v1","kind":"PartialObjectMetadata","metadata":{"name":"sample","namespace":"synthetic"}}}`+"\n")
			return
		}
		if want == "PartialObjectMetadata" {
			io.WriteString(w, `{"apiVersion":"meta.k8s.io/v1","kind":"PartialObjectMetadata","metadata":{"name":"sample","namespace":"synthetic"}}`)
			return
		}
		io.WriteString(w, `{"apiVersion":"meta.k8s.io/v1","kind":"PartialObjectMetadataList","metadata":{},"items":[]}`)
	}))
	defer server.Close()
	client, err := metadata.NewForConfig(MetadataOnlyConfig(&rest.Config{Host: server.URL}))
	if err != nil {
		t.Fatal(err)
	}
	resource := client.Resource(podsResource).Namespace("synthetic")
	if _, err = resource.List(context.Background(), metav1.ListOptions{}); err != nil {
		t.Fatalf("list negotiation: %v", err)
	}
	if _, err = resource.Get(context.Background(), "sample", metav1.GetOptions{}); err != nil {
		t.Fatalf("single-object negotiation: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	stream, err := resource.Watch(ctx, metav1.ListOptions{})
	if err != nil {
		t.Fatalf("watch negotiation: %v", err)
	}
	defer stream.Stop()
	select {
	case event, ok := <-stream.ResultChan():
		if !ok || event.Type != "ADDED" {
			t.Fatalf("metadata watch event=%+v open=%v", event, ok)
		}
	case <-ctx.Done():
		t.Fatal("metadata watch did not deliver its event")
	}
}
