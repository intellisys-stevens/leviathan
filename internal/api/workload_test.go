package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/intellisys-stevens/leviathan/internal/model"
)

func TestWorkloadTelemetryWireCollectionsPreserveSource(t *testing.T) {
	for _, populated := range []bool{false, true} {
		source := newStubSource()
		source.snapshot.WorkloadTelemetry = &model.WorkloadTelemetry{Status: model.WorkloadTelemetryAvailable}
		if populated {
			source.snapshot.WorkloadTelemetry.Owners = []model.WorkloadOwnerTelemetry{{Ref: "owner_test"}}
		}
		response := httptest.NewRecorder()
		newTestServer(source, nil).ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v1/snapshot", nil))
		if response.Code != http.StatusOK {
			t.Fatalf("status=%d", response.Code)
		}
		var payload struct {
			Telemetry struct {
				Owners []struct {
					Workspaces []json.RawMessage          `json:"workspaces"`
					Metrics    map[string]json.RawMessage `json:"metrics"`
				} `json:"owners"`
			} `json:"workloadTelemetry"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
			t.Fatal(err)
		}
		if payload.Telemetry.Owners == nil {
			t.Fatal("owner collection was encoded as null")
		}
		if populated {
			owner := payload.Telemetry.Owners[0]
			if owner.Workspaces == nil || owner.Metrics == nil {
				t.Fatal("nested owner collections were encoded as null")
			}
			original := source.snapshot.WorkloadTelemetry.Owners[0]
			if original.Workspaces != nil || original.Metrics != nil {
				t.Fatal("wire normalization mutated the published owner snapshot")
			}
		} else if source.snapshot.WorkloadTelemetry.Owners != nil {
			t.Fatal("wire normalization mutated the published inventory")
		}
	}
}
