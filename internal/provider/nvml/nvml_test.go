package nvml

import (
	"errors"
	"math"
	"strings"
	"testing"
	"time"

	gonvml "github.com/NVIDIA/go-nvml/pkg/nvml"
	"github.com/intellisys-stevens/leviathan/internal/model"
	"github.com/intellisys-stevens/leviathan/internal/provider"
)

func TestUnavailableNVMLStartupReturnsTypedUnsupportedError(t *testing.T) {
	for _, ret := range []gonvml.Return{gonvml.ERROR_LIBRARY_NOT_FOUND, gonvml.ERROR_DRIVER_NOT_LOADED} {
		status, err := initializationFailure(ret)
		if status != model.StatusUnsupported {
			t.Fatalf("initializationFailure(%s) status = %q, want %q", ret, status, model.StatusUnsupported)
		}
		if statusFor(ret) != model.StatusError {
			t.Fatalf("runtime statusFor(%s) = %q, want %q", ret, statusFor(ret), model.StatusError)
		}
		if !errors.Is(err, provider.ErrUnavailable) {
			t.Fatalf("initializationFailure(%s) = %v, want provider unavailable", ret, err)
		}
	}
	status, err := initializationFailure(gonvml.ERROR_NO_PERMISSION)
	if status != model.StatusPermissionDenied {
		t.Fatalf("permission status = %q, want %q", status, model.StatusPermissionDenied)
	}
	if errors.Is(err, provider.ErrUnavailable) {
		t.Fatalf("permission failure was classified as provider unavailable: %v", err)
	}
	status, err = initializationFailure(gonvml.ERROR_NOT_SUPPORTED)
	if status != model.StatusUnsupported || errors.Is(err, provider.ErrUnavailable) {
		t.Fatalf("unexpected initialization failure was treated as an absent provider: status=%q err=%v", status, err)
	}
}

func TestGPMMetricNeverMarksBlankValueAvailable(t *testing.T) {
	at := time.Date(2026, 8, 29, 12, 0, 0, 0, time.UTC)
	descriptor := percentDescriptor("sm_activity")
	for _, value := range []float64{math.NaN(), math.Inf(1), math.Inf(-1)} {
		metric := gpmMetric(descriptor, gonvml.GpmMetric{NvmlReturn: uint32(gonvml.SUCCESS), Value: value}, model.ScopeGPUInstance, at)
		if metric.Status != model.StatusStale || metric.Value != nil || !strings.Contains(metric.Message, "non-finite value") {
			t.Fatalf("non-finite GPM value produced %+v", metric)
		}
	}
}

func TestGPMBlankDiagnosticRequiresEveryMetric(t *testing.T) {
	at := time.Date(2026, 8, 29, 12, 0, 0, 0, time.UTC)
	blank := gpmMetric(percentDescriptor("sm_activity"), gonvml.GpmMetric{NvmlReturn: uint32(gonvml.SUCCESS), Value: math.NaN()}, model.ScopeGPUInstance, at)
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

func TestNonMIGUtilizationPreservesParentMetrics(t *testing.T) {
	at := time.Date(2026, 8, 29, 12, 0, 0, 0, time.UTC)
	temperature := model.AvailableMetric(82, "celsius", model.SourceNVML, model.ScopePhysicalGPU, at)
	metrics := mergeDeviceUtilizationMetrics(
		model.MetricSet{"temperature": temperature},
		gonvml.Utilization{Gpu: 100, Memory: 89},
		gonvml.SUCCESS,
		at,
	)

	if got, ok := metrics["temperature"]; !ok || got.Value == nil || *got.Value != 82 {
		t.Fatalf("temperature was discarded while adding utilization: %+v", got)
	}
	for _, name := range []string{"gpu_activity", "sm_activity", "memory_activity"} {
		if _, ok := metrics[name]; !ok {
			t.Fatalf("%s was not added: %+v", name, metrics)
		}
	}
}

func TestGPMMetricClampsFinitePercentage(t *testing.T) {
	at := time.Date(2026, 8, 29, 12, 0, 0, 0, time.UTC)
	metric := gpmMetric(percentDescriptor("sm_activity"), gonvml.GpmMetric{NvmlReturn: uint32(gonvml.SUCCESS), Value: 117}, model.ScopeGPUInstance, at)
	if metric.Status != model.StatusAvailable || metric.Value == nil || *metric.Value != 100 {
		t.Fatalf("finite GPM value produced %+v", metric)
	}
}

func TestGPMMetricPreservesProviderFailure(t *testing.T) {
	at := time.Date(2026, 8, 29, 12, 0, 0, 0, time.UTC)
	metric := gpmMetric(percentDescriptor("sm_activity"), gonvml.GpmMetric{NvmlReturn: uint32(gonvml.ERROR_NOT_SUPPORTED)}, model.ScopeGPUInstance, at)
	if metric.Status != model.StatusUnsupported || metric.Value != nil {
		t.Fatalf("unsupported GPM value produced %+v", metric)
	}
}

func TestGPMPCIeMetricsUseCanonicalBytesPerSecond(t *testing.T) {
	at := time.Date(2026, 8, 29, 12, 0, 0, 0, time.UTC)
	descriptor := findGPMDescriptor(t, gpmProfileMetrics, "pcie_tx_bytes_per_second")
	metric := gpmMetric(descriptor, gonvml.GpmMetric{NvmlReturn: uint32(gonvml.SUCCESS), Value: 2.5}, model.ScopeGPUInstance, at)
	want := 2.5 * 1024 * 1024
	if metric.Value == nil || *metric.Value != want || metric.Unit != "bytes_per_second" || metric.Scope != model.ScopeGPUInstance {
		t.Fatalf("GPM PCIe metric = %+v, want %v bytes/s", metric, want)
	}

	unsupported := gpmMetric(descriptor, gonvml.GpmMetric{NvmlReturn: uint32(gonvml.ERROR_NOT_SUPPORTED)}, model.ScopeGPUInstance, at)
	if unsupported.Value != nil || unsupported.Status != model.StatusUnsupported || unsupported.Unit != "bytes_per_second" {
		t.Fatalf("unsupported GPM PCIe metric = %+v", unsupported)
	}
}

func TestPhysicalGPMDescriptorsIncludePCIeButNotMemoryActivity(t *testing.T) {
	for _, name := range []string{"pcie_tx_bytes_per_second", "pcie_rx_bytes_per_second"} {
		descriptor := findGPMDescriptor(t, physicalGPMMetrics, name)
		if descriptor.unit != "bytes_per_second" {
			t.Fatalf("physical PCIe descriptor = %+v", descriptor)
		}
	}
	for _, descriptor := range physicalGPMMetrics {
		if descriptor.name == "memory_activity" || descriptor.id == gonvml.GPM_METRIC_DRAM_BW_UTIL {
			t.Fatalf("physical GPM must not override NVML memory busy time: %+v", descriptor)
		}
	}
}

func TestLegacyPCIeAndPowerScaling(t *testing.T) {
	at := time.Date(2026, 8, 29, 12, 0, 0, 0, time.UTC)
	pcie := pcieThroughputMetric(4096, gonvml.SUCCESS, at)
	if pcie.Value == nil || *pcie.Value != 4096*1024 || pcie.Unit != "bytes_per_second" || pcie.Source != model.SourceNVML {
		t.Fatalf("legacy PCIe metric = %+v", pcie)
	}
	power := milliwattsMetric(325500, gonvml.SUCCESS, at)
	if power.Value == nil || *power.Value != 325.5 || power.Unit != "watts" || power.Scope != model.ScopePhysicalGPU || !power.SampledAt.Equal(at) {
		t.Fatalf("power metric = %+v", power)
	}
}

func TestProfileCachePreservesTrueTimestampAndBecomesStale(t *testing.T) {
	at := time.Date(2026, 8, 29, 12, 0, 0, 0, time.UTC)
	p := New(Options{ProfileInterval: 2 * time.Second, ProfileStaleAfter: 4 * time.Second})
	state := &profileState{}
	p.storeGPMMetrics(state, model.MetricSet{
		"sm_activity": model.AvailableMetric(72, "percent", model.SourceNVMLGPM, model.ScopeGPUInstance, at),
	})
	p.storeGPMMetrics(state, model.MetricSet{
		"sm_activity": model.UnavailableMetric("percent", model.SourceNVMLGPM, model.ScopeGPUInstance, at.Add(2*time.Second), model.StatusStale, "blank"),
	})

	fresh := p.cachedProfileMetrics(state, at.Add(3*time.Second))["sm_activity"]
	if fresh.Value == nil || *fresh.Value != 72 || !fresh.SampledAt.Equal(at) {
		t.Fatalf("fresh cached metric = %+v", fresh)
	}
	stale := p.cachedProfileMetrics(state, at.Add(5*time.Second))["sm_activity"]
	if stale.Value != nil || stale.Status != model.StatusStale || !stale.SampledAt.Equal(at) {
		t.Fatalf("stale cached metric = %+v", stale)
	}
}

func TestProfileCacheReplacesAvailableValueOnDefinitiveUnsupported(t *testing.T) {
	at := time.Date(2026, 8, 29, 12, 0, 0, 0, time.UTC)
	p := New(Options{})
	state := &profileState{}
	p.storeGPMMetrics(state, model.MetricSet{
		"sm_activity": model.AvailableMetric(72, "percent", model.SourceNVMLGPM, model.ScopeGPUInstance, at),
	})
	p.storeGPMMetrics(state, model.MetricSet{
		"sm_activity": model.UnavailableMetric("percent", model.SourceNVMLGPM, model.ScopeGPUInstance, at.Add(time.Second), model.StatusUnsupported, "unsupported"),
	})
	metric := p.cachedProfileMetrics(state, at.Add(time.Second))["sm_activity"]
	if metric.Value != nil || metric.Status != model.StatusUnsupported {
		t.Fatalf("unsupported cached metric = %+v", metric)
	}
}

func TestProfileSchedulingDefaultsAndTopologyPruning(t *testing.T) {
	p := New(Options{})
	if p.options.ProfileInterval != 2*time.Second || p.options.ProfileStaleAfter != 4*time.Second || p.options.TopologyInterval != 10*time.Second {
		t.Fatalf("provider defaults = profile %s stale %s topology %s", p.options.ProfileInterval, p.options.ProfileStaleAfter, p.options.TopologyInterval)
	}
	at := time.Date(2026, 8, 29, 12, 0, 0, 0, time.UTC)
	state, due := p.profileState("GPU-a/physical/mig=false", at)
	if state == nil || !due {
		t.Fatal("the first profile entity was not sampled immediately")
	}
	p.profileStates["GPU-a/gi/1:old"] = &profileState{}
	p.pruneProfileStates(map[string]bool{"GPU-a/physical/mig=false": true})
	if _, ok := p.profileStates["GPU-a/gi/1:old"]; ok {
		t.Fatal("stale topology profile state was retained")
	}
}

func TestTopologyCacheFreshnessIsBounded(t *testing.T) {
	refreshed := time.Date(2026, 8, 29, 12, 0, 0, 0, time.UTC)
	interval := 10 * time.Second
	if !topologyCacheFresh(refreshed, refreshed.Add(interval-time.Nanosecond), interval) {
		t.Fatal("topology cache expired before its rescan interval")
	}
	if topologyCacheFresh(refreshed, refreshed.Add(interval), interval) {
		t.Fatal("topology cache survived its rescan boundary")
	}
	if topologyCacheFresh(refreshed, refreshed.Add(-time.Second), interval) {
		t.Fatal("topology cache accepted a clock reversal")
	}
}

func TestGPMSupportCacheUsesDefinitiveResultsOnly(t *testing.T) {
	for _, ret := range []gonvml.Return{gonvml.SUCCESS, gonvml.ERROR_NOT_SUPPORTED, gonvml.ERROR_FUNCTION_NOT_FOUND} {
		if !cacheableGPMSupportReturn(ret) {
			t.Fatalf("definitive GPM support result %s was not cacheable", ret)
		}
	}
	for _, ret := range []gonvml.Return{gonvml.ERROR_TIMEOUT, gonvml.ERROR_NOT_READY, gonvml.ERROR_UNKNOWN} {
		if cacheableGPMSupportReturn(ret) {
			t.Fatalf("transient GPM support result %s was cached", ret)
		}
	}

	check := gpmSupportCheckFor(cachedPhysicalDevice{
		gpmSupported:  true,
		gpmSupportRet: gonvml.SUCCESS,
		gpmSupportOK:  true,
	})
	if supported, ret := check(); !supported || ret != gonvml.SUCCESS {
		t.Fatalf("cached GPM support = %t, %s", supported, ret)
	}
}

func TestMIGMemoryCacheUsesProfileCadenceAndExpires(t *testing.T) {
	at := time.Date(2026, 8, 29, 12, 0, 0, 0, time.UTC)
	total, used, free := uint64(24<<30), uint64(6<<30), uint64(18<<30)
	calls := 0
	state := &memoryState{}
	sample := func() model.Memory {
		calls++
		return model.Memory{
			TotalBytes: &total, UsedBytes: &used, FreeBytes: &free,
			Source: model.SourceNVML, Scope: model.ScopeGPUInstance,
			SampledAt: at.Add(time.Duration(calls-1) * 2 * time.Second), Status: model.StatusAvailable,
		}
	}

	first := sampleCachedMemory(state, "GPU-a/gi/1", at, 2*time.Second, 4*time.Second, true, sample)
	withinCadence := sampleCachedMemory(state, "GPU-a/gi/1", at.Add(time.Second), 2*time.Second, 4*time.Second, true, sample)
	atBoundary := sampleCachedMemory(state, "GPU-a/gi/1", at.Add(2*time.Second), 2*time.Second, 4*time.Second, true, sample)
	if calls != 2 || first.UsedBytes == nil || withinCadence.UsedBytes == nil || atBoundary.UsedBytes == nil {
		t.Fatalf("MIG memory cadence calls=%d first=%+v cached=%+v boundary=%+v", calls, first, withinCadence, atBoundary)
	}
	if !withinCadence.SampledAt.Equal(at) || !atBoundary.SampledAt.Equal(at.Add(2*time.Second)) {
		t.Fatalf("MIG memory timestamps cached=%s boundary=%s", withinCadence.SampledAt, atBoundary.SampledAt)
	}

	expired := cachedMemoryAt(first, at.Add(5*time.Second), 4*time.Second)
	if expired.Status != model.StatusStale || expired.UsedBytes != nil || expired.FreeBytes != nil || expired.TotalBytes == nil || !expired.SampledAt.Equal(at) {
		t.Fatalf("expired MIG memory = %+v", expired)
	}
}

func TestMIGMemoryCacheRetainsFreshValueAcrossTransientFailure(t *testing.T) {
	at := time.Date(2026, 8, 29, 12, 0, 0, 0, time.UTC)
	used := uint64(1)
	state := &memoryState{memory: model.Memory{
		UsedBytes: &used, Source: model.SourceNVML, Scope: model.ScopeGPUInstance,
		SampledAt: at, Status: model.StatusAvailable,
	}}
	failed := sampleCachedMemory(state, "GPU-a/gi/1", at.Add(2*time.Second), 2*time.Second, 4*time.Second, true, func() model.Memory {
		return model.UnavailableMemory(model.SourceNVML, model.ScopeGPUInstance, at.Add(2*time.Second), model.StatusError, "transient")
	})
	if failed.Status != model.StatusAvailable || failed.UsedBytes == nil || *failed.UsedBytes != used || !failed.SampledAt.Equal(at) {
		t.Fatalf("fresh MIG memory was discarded after transient failure: %+v", failed)
	}
}

func TestProfileSchedulingStaggersAdditionalEntities(t *testing.T) {
	at := time.Date(2026, 8, 29, 12, 0, 0, 0, time.UTC)
	interval := 2 * time.Second
	p := New(Options{ProfileInterval: interval})
	if _, due := p.profileState("GPU-a/physical/mig=false", at); !due {
		t.Fatal("first entity should establish the profile cadence immediately")
	}
	state, due := p.profileState("GPU-a/gi/1:new", at)
	if !due {
		t.Fatal("new entity did not capture an immediate GPM baseline")
	}
	if state.nextAt.Before(at.Add(100*time.Millisecond)) || state.nextAt.After(at.Add(interval)) {
		t.Fatalf("additional entity follow-up was not staggered inside the interval: next=%s", state.nextAt)
	}
	if _, due := p.profileState("GPU-a/gi/1:new", state.nextAt); !due {
		t.Fatal("staggered entity was not due at its scheduled phase")
	}

	unStaggered := New(Options{ProfileInterval: interval, DisableProfileStagger: true})
	if _, due := unStaggered.profileState("GPU-a/physical/mig=false", at); !due {
		t.Fatal("first unstaggered entity was not due")
	}
	if _, due := unStaggered.profileState("GPU-a/gi/1:new", at); !due {
		t.Fatal("disabled staggering delayed an entity")
	}
}

func percentDescriptor(name string) gpmProfileMetric {
	return gpmProfileMetric{name: name, unit: "percent", scale: 1, percent: true}
}

func findGPMDescriptor(t *testing.T, descriptors []gpmProfileMetric, name string) gpmProfileMetric {
	t.Helper()
	for _, descriptor := range descriptors {
		if descriptor.name == name {
			return descriptor
		}
	}
	t.Fatalf("GPM descriptor %q not found", name)
	return gpmProfileMetric{}
}

func TestGPMSampleKeyChangesWithMIGTopology(t *testing.T) {
	instance := model.GPUInstance{ID: 1, Profile: "1g.24gb", ComputeInstances: []model.ComputeInstance{{UUID: "MIG-old", ID: 0, Profile: "1c.1g.24gb"}}}
	before := gpmSampleKey("GPU-a", instance)
	instance.ComputeInstances[0].UUID = "MIG-new"
	if after := gpmSampleKey("GPU-a", instance); after == before {
		t.Fatalf("GPM sample key survived a topology replacement: %q", after)
	}
}
