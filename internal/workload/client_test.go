package workload

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

type testTransport func(*http.Request) (*http.Response, error)

func (f testTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestPrivateClientBoundsFreshnessAndSanitizesFailures(t *testing.T) {
	at := time.Now().UTC()
	for name, change := range map[string]func(*http.Response, *Document){
		"fresh":            func(*http.Response, *Document) {},
		"permissions":      func(r *http.Response, _ *Document) { r.StatusCode = http.StatusForbidden },
		"missing endpoint": func(r *http.Response, _ *Document) { r.StatusCode = http.StatusNotFound },
		"stale source":     func(_ *http.Response, d *Document) { d.ObservedAt = at.Add(-16 * time.Second) },
		"future":           func(_ *http.Response, d *Document) { d.GeneratedAt = at.Add(time.Minute) },
		"not json":         func(r *http.Response, _ *Document) { r.Header.Set("Content-Type", "text/plain") },
	} {
		t.Run(name, func(t *testing.T) {
			client, err := NewClient("/run/leviathan/attribution.sock")
			if err != nil {
				t.Fatal(err)
			}
			defer client.Close()
			client.http.Transport = testTransport(func(r *http.Request) (*http.Response, error) {
				if r.URL.Path != "/v1/workloads" {
					t.Fatal("wrong private endpoint")
				}
				document := inventory(at, podOne)
				response := &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}}}
				change(response, &document)
				data, _ := json.Marshal(document)
				if response.StatusCode != 200 {
					data = []byte("sensitive upstream details")
				}
				response.Body = io.NopCloser(strings.NewReader(string(data)))
				return response, nil
			})
			_, err = client.Read(context.Background(), at)
			if (name == "fresh") != (err == nil) {
				t.Fatalf("err=%v", err)
			}
			if err != nil && strings.Contains(err.Error(), "sensitive") {
				t.Fatal("upstream response leaked")
			}
		})
	}
}
