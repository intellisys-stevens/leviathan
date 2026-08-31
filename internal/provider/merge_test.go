package provider

import (
	"testing"
	"time"

	"github.com/intellisys-stevens/leviathan/internal/model"
)

func TestMetricPrecedenceAndStatus(t *testing.T) {
	at := time.Now()
	nvml := model.AvailableMetric(20, "percent", model.SourceNVML, model.ScopeGPUInstance, at)
	dcgm := model.AvailableMetric(30, "percent", model.SourceDCGM, model.ScopeGPUInstance, at)
	gpm := model.AvailableMetric(40, "percent", model.SourceNVMLGPM, model.ScopeGPUInstance, at)
	if got := MergeMetric(nvml, dcgm); got.Source != model.SourceDCGM {
		t.Fatalf("expected DCGM over NVML, got %s", got.Source)
	}
	if got := MergeMetric(dcgm, gpm); got.Source != model.SourceNVMLGPM {
		t.Fatalf("expected GPM over DCGM, got %s", got.Source)
	}
	unsupported := model.UnavailableMetric("percent", model.SourceNVMLGPM, model.ScopeGPUInstance, at, model.StatusUnsupported, "not supported")
	if got := MergeMetric(dcgm, unsupported); got.Source != model.SourceDCGM || got.Status != model.StatusAvailable {
		t.Fatal("an unavailable GPM metric replaced an available DCGM metric")
	}
}
