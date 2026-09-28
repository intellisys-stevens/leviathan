package uplink

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"testing"
)

func TestV2ProjectionGoldenAndHardwareIndependentFixture(t *testing.T) {
	body, err := os.ReadFile("testdata/uplink-v1.golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var v1 Envelope
	if err = json.Unmarshal(body, &v1); err != nil {
		t.Fatal(err)
	}
	wantBody, err := os.ReadFile("testdata/uplink-v2.golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var want EnvelopeV2
	if err = json.Unmarshal(wantBody, &want); err != nil {
		t.Fatal(err)
	}
	got := ToV2(v1)
	if !reflect.DeepEqual(got, want) {
		t.Fatal("v2 wire projection drifted from golden")
	}
	amdBody, _ := os.ReadFile("testdata/uplink-v2-amd.golden.json")
	var amd EnvelopeV2
	if err = json.Unmarshal(amdBody, &amd); err != nil {
		t.Fatal(err)
	}
	if amd.Accelerators[0].Vendor != "amd" || amd.Accelerators[0].Memory.Source != "rocm" {
		t.Fatal("non-NVIDIA source not representable")
	}
	v1.GPUs = []GPU{}
	cpuOnly := ToV2(v1)
	if len(cpuOnly.Accelerators) != 0 || len(cpuOnly.Capabilities) != 2 {
		t.Fatal("CPU-only projection invented GPU capabilities")
	}
	v1.Health.GPU.Status = HealthUnavailable
	unknown := ToV2(v1)
	if unknown.Capabilities[1].Status != "unavailable" {
		t.Fatal("missing GPU telemetry claimed a complete empty inventory")
	}
}

func TestV2ClientSendsPortableEnvelopeAndChecksReceipt(t *testing.T) {
	envelope := testEnvelope(t)
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != EndpointPathV2 || r.Header.Get("Authorization") != "Bearer "+testMachineToken() {
			t.Error("wrong transport contract")
			w.WriteHeader(400)
			return
		}
		var raw map[string]json.RawMessage
		if err := json.NewDecoder(r.Body).Decode(&raw); err != nil {
			t.Error(err)
			w.WriteHeader(400)
			return
		}
		if _, exists := raw["gpus"]; exists {
			t.Error("v1 GPU field leaked into v2")
		}
		if _, exists := raw["accelerators"]; !exists {
			t.Error("missing accelerators")
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(Receipt{Status: "accepted", StreamID: envelope.StreamID, Sequence: envelope.Sequence})
	}))
	defer server.Close()
	client, err := NewClient(server.URL, TokenSourceFunc(func(context.Context) (string, error) { return testMachineToken(), nil }), ClientOptions{Schema: SchemaV2, HTTPClient: server.Client()})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = client.Send(context.Background(), envelope); err != nil {
		t.Fatal(err)
	}
}
