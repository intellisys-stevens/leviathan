package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/intellisys-stevens/leviathan/internal/health"
	"github.com/intellisys-stevens/leviathan/internal/model"
)

func TestStatusAvailableBeforeFirstSnapshot(t *testing.T) {
	at := time.Date(2026, 9, 5, 0, 2, 0, 0, time.UTC)
	recorder := health.New(nil, health.Options{Now: func() time.Time { return at }})
	server := NewServer(unavailableSource{newStubSource()}, nil, model.BuildInfo{}, recorder)
	response := httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v1/status", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d: %s", response.Code, response.Body.String())
	}
	var report HealthStatusReport
	if err := json.Unmarshal(response.Body.Bytes(), &report); err != nil {
		t.Fatal(err)
	}
	if len(report.Days) != health.RetentionDays || len(report.Components) != 2 || report.Persistence.Saving || report.Days[health.RetentionDays-1].ExpectedSamples != 3 {
		t.Fatalf("invalid report: %+v", report)
	}
	if report.MonitorUptimeSeconds == nil || *report.MonitorUptimeSeconds != 0 {
		t.Fatalf("initial monotonic monitor runtime = %v", report.MonitorUptimeSeconds)
	}
	for _, component := range report.Components {
		if string(component.State) != "unknown" {
			t.Fatalf("fabricated health: %+v", component)
		}
	}
}

func TestStatusWithoutRecorderIsExplicitlyUnavailable(t *testing.T) {
	response := httptest.NewRecorder()
	newTestServer(newStubSource(), nil).ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v1/status", nil))
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status=%d", response.Code)
	}
}
