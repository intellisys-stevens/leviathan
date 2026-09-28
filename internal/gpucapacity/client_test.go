package gpucapacity

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func fixture(now time.Time) Document {
	count, memory := int64(0), int64(96<<30)
	return Document{Status: "available", ObservedAt: &now, Revision: 9, Rows: []Row{{ID: "capacity_11111111111111111111111111111111", Mode: "native", Model: "GPU", MemoryBytes: &memory, Available: &count, Status: "available"}}}
}

func TestClientKeepsSourceFreshnessAndOldBridgeUnavailable(t *testing.T) {
	now := time.Now().UTC()
	for _, scenario := range []string{"fresh zero", "stale", "old bridge", "invalid", "oversize", "redirect", "private error"} {
		t.Run(scenario, func(t *testing.T) {
			client, err := NewClient("/tmp/capacity.sock")
			if err != nil {
				t.Fatal(err)
			}
			defer client.Close()
			client.http = &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
				if request.Method != http.MethodGet || request.URL.Path != "/v1/gpu-capacity" {
					t.Fatalf("unexpected request: %s %s", request.Method, request.URL.Path)
				}
				if scenario == "private error" {
					return nil, errors.New("private-claim-secret")
				}
				w := httptest.NewRecorder()
				w.Header().Set("Content-Type", "application/json")
				d := fixture(now)
				switch scenario {
				case "old bridge":
					w.WriteHeader(404)
				case "redirect":
					w.WriteHeader(302)
				case "invalid":
					_, _ = w.WriteString(`{"private":"secret"}`)
				case "oversize":
					_, _ = w.WriteString(strings.Repeat("x", MaxDocumentBytes+1))
				default:
					if scenario == "stale" {
						old := now.Add(-16 * time.Second)
						d.ObservedAt = &old
					}
					_ = json.NewEncoder(w).Encode(d)
				}
				return w.Result(), nil
			})}
			d, err := client.Read(context.Background(), now)
			if scenario == "fresh zero" {
				if err != nil || d.Status != "available" || d.Rows[0].Available == nil || *d.Rows[0].Available != 0 {
					t.Fatalf("%+v %v", d, err)
				}
				return
			}
			if scenario == "stale" {
				if err != nil || d.Status != "stale" || d.Rows[0].Available != nil {
					t.Fatalf("%+v %v", d, err)
				}
				return
			}
			if err == nil || strings.Contains(err.Error(), "private-claim-secret") {
				t.Fatalf("unsanitized or absent failure: %v", err)
			}
		})
	}
}

func TestDocumentDoesNotMutateSharedRowsAndValidatesState(t *testing.T) {
	now := time.Now().UTC()
	original := fixture(now)
	stale := original.At(now.Add(16 * time.Second))
	if original.Rows[0].Available == nil || stale.Rows[0].Available != nil {
		t.Fatal("freshness mutated original document")
	}
	if err := stale.Validate(); err != nil {
		t.Fatal(err)
	}
	broken := original
	broken.Status = "unavailable"
	if err := broken.Validate(); err == nil {
		t.Fatal("unavailable count was accepted")
	}
	broken = original
	broken.Rows = append(broken.Rows, broken.Rows[0])
	if err := broken.Validate(); err == nil {
		t.Fatal("duplicate row was accepted")
	}
}
