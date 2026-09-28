package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/intellisys-stevens/leviathan/internal/gpucapacity"
)

type capacitySource struct {
	document gpucapacity.Document
	err      error
}

func (s capacitySource) Read(context.Context, time.Time) (gpucapacity.Document, error) {
	return s.document, s.err
}

func TestGPUCapacityIsIndependentSanitizedAndNeverCaches(t *testing.T) {
	for _, scenario := range []string{"unconfigured", "success", "source failed", "stale"} {
		t.Run(scenario, func(t *testing.T) {
			s := newTestServer(newStubSource(), nil)
			at := time.Now().UTC()
			count, memory := int64(2), int64(48<<30)
			d := gpucapacity.Document{Status: "available", ObservedAt: &at, Revision: 1, Rows: []gpucapacity.Row{{ID: "capacity_11111111111111111111111111111111", Mode: "mig", Model: "GPU", Profile: "2g.48gb", MemoryBytes: &memory, Available: &count, Status: "available"}}}
			if scenario == "stale" {
				old := at.Add(-16 * time.Second)
				d.ObservedAt = &old
			}
			if scenario != "unconfigured" {
				source := capacitySource{document: d}
				if scenario == "source failed" {
					source.err = errors.New("private-pool-credential")
				}
				s.WithGPUCapacity(source)
			}
			w := httptest.NewRecorder()
			s.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/v1/gpu-capacity", nil))
			if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" || strings.Contains(w.Body.String(), "private-pool-credential") {
				t.Fatal(w)
			}
			var got gpucapacity.Document
			if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
				t.Fatal(err)
			}
			if err := got.Validate(); err != nil {
				t.Fatal(err)
			}
			if scenario == "success" {
				if got.Rows[0].Available == nil || *got.Rows[0].Available != 2 {
					t.Fatal(got)
				}
			} else {
				for _, r := range got.Rows {
					if r.Available != nil {
						t.Fatal(r)
					}
				}
			}
		})
	}
}
