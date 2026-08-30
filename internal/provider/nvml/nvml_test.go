package nvml

import (
	"math"
	"strings"
	"testing"
	"time"

	gonvml "github.com/NVIDIA/go-nvml/pkg/nvml"
	"github.com/miglens/miglens/internal/model"
)

func TestGPMMetricNeverMarksBlankValueAvailable(t *testing.T) {
	at := time.Date(2026, 8, 29, 12, 0, 0, 0, time.UTC)
	for _, value := range []float64{math.NaN(), math.Inf(1), math.Inf(-1)} {
		metric := gpmMetric(gonvml.GpmMetric{NvmlReturn: uint32(gonvml.SUCCESS), Value: value}, at)
		if metric.Status != model.StatusStale || metric.Value != nil || !strings.Contains(metric.Message, "non-finite value") {
			t.Fatalf("non-finite GPM value produced %+v", metric)
		}
	}
}

func TestGPMBlankDiagnosticRequiresEveryMetric(t *testing.T) {
	at := time.Date(2026, 8, 29, 12, 0, 0, 0, time.UTC)
	blank := gpmMetric(gonvml.GpmMetric{NvmlReturn: uint32(gonvml.SUCCESS), Value: math.NaN()}, at)
	metrics := model.MetricSet{
		"gpu_activity":    blank,
		"sm_activity":     blank,
		"sm_occupancy":    blank,
		"tensor_activity": blank,
		"dram_activity":   blank,
	}
	if !allGPMMetricsBlank(metrics) {
		t.Fatal("an entirely blank GPM sample was not detected")
	}
	metrics["sm_activity"] = model.AvailableMetric(0, "percent", model.SourceNVMLGPM, model.ScopeGPUInstance, at)
	if allGPMMetricsBlank(metrics) {
		t.Fatal("one blank metric incorrectly escalated the entire GPM sample")
	}
}

func TestProfileMetricSetIncludesGPUActivity(t *testing.T) {
	metrics := unsupportedProfileMetrics(time.Now().UTC(), "disabled")
	metric, ok := metrics["gpu_activity"]
	if !ok || metric.Status != model.StatusUnsupported || metric.Source != model.SourceNVMLGPM || metric.Scope != model.ScopeGPUInstance {
		t.Fatalf("gpu_activity metric = %+v", metric)
	}
}

func TestGPMGraphicsAndSMMetricsRemainDistinct(t *testing.T) {
	mappings := map[gonvml.GpmMetricId]string{}
	for _, descriptor := range gpmProfileMetrics {
		mappings[descriptor.id] = descriptor.name
	}
	if mappings[gonvml.GPM_METRIC_GRAPHICS_UTIL] != "gpu_activity" {
		t.Fatalf("graphics utilization mapping = %q", mappings[gonvml.GPM_METRIC_GRAPHICS_UTIL])
	}
	if mappings[gonvml.GPM_METRIC_SM_UTIL] != "sm_activity" {
		t.Fatalf("SM utilization mapping = %q", mappings[gonvml.GPM_METRIC_SM_UTIL])
	}
}

func TestNonMIGUtilizationProvidesPhysicalGPUActivity(t *testing.T) {
	at := time.Date(2026, 8, 29, 12, 0, 0, 0, time.UTC)
	metrics := deviceUtilizationMetrics(gonvml.Utilization{Gpu: 43, Memory: 19}, gonvml.SUCCESS, at)
	for _, name := range []string{"gpu_activity", "sm_activity"} {
		metric := metrics[name]
		if metric.Value == nil || *metric.Value != 43 || metric.Scope != model.ScopePhysicalGPU || metric.Source != model.SourceNVML {
			t.Fatalf("%s = %+v", name, metric)
		}
	}
	if metric := metrics["memory_activity"]; metric.Value == nil || *metric.Value != 19 {
		t.Fatalf("memory activity = %+v", metric)
	}

	unavailable := deviceUtilizationMetrics(gonvml.Utilization{}, gonvml.ERROR_NOT_SUPPORTED, at)
	if metric := unavailable["gpu_activity"]; metric.Value != nil || metric.Status != model.StatusUnsupported {
		t.Fatalf("unavailable GPU activity = %+v", metric)
	}
}

func TestGPMMetricClampsFinitePercentage(t *testing.T) {
	at := time.Date(2026, 8, 29, 12, 0, 0, 0, time.UTC)
	metric := gpmMetric(gonvml.GpmMetric{NvmlReturn: uint32(gonvml.SUCCESS), Value: 117}, at)
	if metric.Status != model.StatusAvailable || metric.Value == nil || *metric.Value != 100 {
		t.Fatalf("finite GPM value produced %+v", metric)
	}
}

func TestGPMMetricPreservesProviderFailure(t *testing.T) {
	at := time.Date(2026, 8, 29, 12, 0, 0, 0, time.UTC)
	metric := gpmMetric(gonvml.GpmMetric{NvmlReturn: uint32(gonvml.ERROR_NOT_SUPPORTED)}, at)
	if metric.Status != model.StatusUnsupported || metric.Value != nil {
		t.Fatalf("unsupported GPM value produced %+v", metric)
	}
}

func TestGPMSampleKeyChangesWithMIGTopology(t *testing.T) {
	instance := model.GPUInstance{ID: 1, Profile: "1g.24gb", ComputeInstances: []model.ComputeInstance{{UUID: "MIG-old", ID: 0, Profile: "1c.1g.24gb"}}}
	before := gpmSampleKey("GPU-a", instance)
	instance.ComputeInstances[0].UUID = "MIG-new"
	if after := gpmSampleKey("GPU-a", instance); after == before {
		t.Fatalf("GPM sample key survived a topology replacement: %q", after)
	}
}
