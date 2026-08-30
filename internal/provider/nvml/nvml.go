// Package nvml implements read-only NVIDIA discovery and sampling without
// invoking or parsing nvidia-smi.
package nvml

import (
	"context"
	"errors"
	"fmt"
	"math"
	"os"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	gonvml "github.com/NVIDIA/go-nvml/pkg/nvml"
	"github.com/intellisys-stevens/miglens/internal/model"
)

type Options struct {
	NoProfile bool
}

type Provider struct {
	options Options

	mu           sync.RWMutex
	opened       bool
	gpmAvailable bool
	gpmMessage   string
	gpmSamples   map[string]gonvml.GpmSample
}

func New(options Options) *Provider {
	return &Provider{options: options, gpmSamples: make(map[string]gonvml.GpmSample)}
}

func (p *Provider) Name() string { return "nvml" }

func (p *Provider) Open(context.Context) error {
	if ret := gonvml.Init(); ret != gonvml.SUCCESS {
		return fmt.Errorf("initialize NVML: %s", ret)
	}
	p.mu.Lock()
	p.opened = true
	p.mu.Unlock()
	return nil
}

func (p *Provider) Close() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.opened {
		return nil
	}
	for key, sample := range p.gpmSamples {
		_ = gonvml.GpmSampleFree(sample)
		delete(p.gpmSamples, key)
	}
	p.opened = false
	if ret := gonvml.Shutdown(); ret != gonvml.SUCCESS {
		return fmt.Errorf("shutdown NVML: %s", ret)
	}
	return nil
}

func (p *Provider) Capabilities() model.Capabilities {
	p.mu.RLock()
	defer p.mu.RUnlock()
	available := p.opened
	nvmlState := model.ProviderState{Name: "NVML", Available: available, Status: model.StatusAvailable}
	if !available {
		nvmlState.Status = model.StatusError
		nvmlState.Message = "NVML is not initialized"
	}
	gpmStatus := model.StatusUnsupported
	if p.gpmAvailable && !p.options.NoProfile {
		gpmStatus = model.StatusAvailable
	}
	gpmState := model.ProviderState{Name: "NVML GPM", Available: p.gpmAvailable && !p.options.NoProfile, Status: gpmStatus, Message: p.gpmMessage}
	if p.options.NoProfile {
		gpmState.Message = "profiling disabled by --no-profile"
	}
	return model.Capabilities{
		NVML:           nvmlState,
		GPM:            gpmState,
		DCGM:           model.ProviderState{Name: "DCGM", Available: false, Status: model.StatusUnsupported, Message: "local DCGM was not selected"},
		Proc:           model.ProviderState{Name: "/proc GPU clients (current PID namespace)", Available: false, Status: model.StatusStale, Message: "GPU process collector is not connected"},
		ProfileMetrics: p.gpmAvailable && !p.options.NoProfile,
	}
}

func (p *Provider) Sample(ctx context.Context, at time.Time) (model.Snapshot, error) {
	if err := ctx.Err(); err != nil {
		return model.Snapshot{}, err
	}
	p.mu.RLock()
	opened := p.opened
	p.mu.RUnlock()
	if !opened {
		return model.Snapshot{}, errors.New("NVML provider is not open")
	}
	hostname, _ := os.Hostname()
	snapshot := model.Snapshot{
		SchemaVersion: "v1", SampledAt: at.UTC(), Host: model.Host{Hostname: hostname, OS: runtime.GOOS, Arch: runtime.GOARCH},
		GPUs: []model.GPU{}, Processes: []model.Process{}, Diagnostics: []model.Diagnostic{},
	}

	count, ret := gonvml.DeviceGetCount()
	if ret != gonvml.SUCCESS {
		return snapshot, fmt.Errorf("enumerate NVIDIA GPUs: %s", ret)
	}
	seenGPM := make(map[string]bool)
	for index := 0; index < count; index++ {
		if err := ctx.Err(); err != nil {
			return model.Snapshot{}, err
		}
		device, ret := gonvml.DeviceGetHandleByIndex(index)
		if ret != gonvml.SUCCESS {
			snapshot.Diagnostics = append(snapshot.Diagnostics, diagnostic("gpu_handle", "error", fmt.Sprintf("GPU %d", index), "GPU handle is unavailable", ret.String(), remedyFor(ret), statusFor(ret)))
			continue
		}
		gpu, diagnostics := p.sampleGPU(device, index, at, seenGPM)
		snapshot.GPUs = append(snapshot.GPUs, gpu)
		snapshot.Diagnostics = append(snapshot.Diagnostics, diagnostics...)
	}
	p.pruneGPMSamples(seenGPM)
	snapshot.Capabilities = p.Capabilities()
	return snapshot, nil
}

func (p *Provider) sampleGPU(device gonvml.Device, index int, at time.Time, seenGPM map[string]bool) (model.GPU, []model.Diagnostic) {
	diagnostics := []model.Diagnostic{}
	name, nameRet := device.GetName()
	if nameRet != gonvml.SUCCESS {
		name = fmt.Sprintf("NVIDIA GPU %d", index)
	}
	uuid, uuidRet := device.GetUUID()
	if uuidRet != gonvml.SUCCESS {
		uuid = fmt.Sprintf("GPU-index-%d", index)
		diagnostics = append(diagnostics, diagnostic("gpu_uuid", "error", uuid, "Stable GPU UUID unavailable", uuidRet.String(), remedyFor(uuidRet), statusFor(uuidRet)))
	}
	gpu := model.GPU{UUID: uuid, Index: index, Name: name, Metrics: make(model.MetricSet), GPUInstances: []model.GPUInstance{}}
	if pci, ret := device.GetPciInfo(); ret == gonvml.SUCCESS {
		gpu.PCIBusID = int8String(pci.BusId[:])
	}
	gpu.Memory = memoryMetric(device, model.ScopePhysicalGPU, at)
	addParentMetrics(device, &gpu, at)

	currentMode, _, migRet := device.GetMigMode()
	gpu.MIGEnabled = migRet == gonvml.SUCCESS && currentMode != 0
	if migRet != gonvml.SUCCESS && migRet != gonvml.ERROR_NOT_SUPPORTED {
		diagnostics = append(diagnostics, diagnostic("mig_mode", "warning", uuid, "MIG mode could not be read", migRet.String(), remedyFor(migRet), statusFor(migRet)))
	}

	if !gpu.MIGEnabled {
		utilization, ret := device.GetUtilizationRates()
		gpu.Metrics = deviceUtilizationMetrics(utilization, ret, at)
		return gpu, diagnostics
	}

	maxMIG, ret := device.GetMaxMigDeviceCount()
	if ret != gonvml.SUCCESS {
		diagnostics = append(diagnostics, diagnostic("mig_enumeration", "error", uuid, "MIG devices could not be enumerated", ret.String(), remedyFor(ret), statusFor(ret)))
		return gpu, diagnostics
	}
	gpu.MaxMIGDevices = maxMIG
	byGI := make(map[uint32]*model.GPUInstance)
	for migIndex := 0; migIndex < maxMIG; migIndex++ {
		migDevice, ret := device.GetMigDeviceHandleByIndex(migIndex)
		if ret == gonvml.ERROR_NOT_FOUND || ret == gonvml.ERROR_INVALID_ARGUMENT {
			continue
		}
		if ret != gonvml.SUCCESS {
			diagnostics = append(diagnostics, diagnostic("mig_handle", severityFor(ret), uuid, fmt.Sprintf("MIG slot %d is unavailable", migIndex), ret.String(), remedyFor(ret), statusFor(ret)))
			continue
		}
		migUUID, uuidRet := migDevice.GetUUID()
		if uuidRet != gonvml.SUCCESS {
			migUUID = fmt.Sprintf("%s/mig/%d", uuid, migIndex)
		}
		giID, giRet := migDevice.GetGpuInstanceId()
		ciID, ciRet := migDevice.GetComputeInstanceId()
		if giRet != gonvml.SUCCESS || ciRet != gonvml.SUCCESS {
			diagnostics = append(diagnostics, diagnostic("mig_identity", "error", migUUID, "MIG GI/CI identity is unavailable", fmt.Sprintf("GI: %s; CI: %s", giRet, ciRet), remedyFor(worseReturn(giRet, ciRet)), statusFor(worseReturn(giRet, ciRet))))
			continue
		}

		giKey := uint32(giID)
		gi := byGI[giKey]
		attributes, attributesRet := migDevice.GetAttributes()
		if gi == nil {
			profile := "unknown"
			if attributesRet == gonvml.SUCCESS {
				profile = profileFromAttributes(attributes)
			}
			giUUID := fmt.Sprintf("%s/gi/%d", uuid, giID)
			created := model.GPUInstance{UUID: giUUID, ID: giKey, Profile: profile, Generation: giUUID, Metrics: make(model.MetricSet), ComputeInstances: []model.ComputeInstance{}}
			created.Memory = memoryMetric(migDevice, model.ScopeGPUInstance, at)
			byGI[giKey] = &created
			gi = &created
		}

		ci := model.ComputeInstance{
			UUID: migUUID, ID: uint32(ciID), Profile: computeProfileFromAttributes(attributes, attributesRet, gi.Profile),
			Memory:  model.UnavailableMemory(model.SourceNVML, model.ScopeGPUInstance, at, model.StatusUnsupported, "memory is reported at GPU-instance scope"),
			Metrics: model.MetricSet{}, Generation: migUUID,
		}
		gi.ComputeInstances = append(gi.ComputeInstances, ci)
	}

	giIDs := make([]int, 0, len(byGI))
	for id := range byGI {
		giIDs = append(giIDs, int(id))
	}
	sort.Ints(giIDs)
	for _, id := range giIDs {
		gi := byGI[uint32(id)]
		sort.Slice(gi.ComputeInstances, func(i, j int) bool { return gi.ComputeInstances[i].ID < gi.ComputeInstances[j].ID })
		if !p.options.NoProfile {
			key := gpmSampleKey(uuid, *gi)
			seenGPM[key] = true
			gi.Metrics = p.sampleGPM(device, id, key, at)
			if allGPMMetricsBlank(gi.Metrics) {
				diagnostics = append(diagnostics, model.Diagnostic{
					Code: "gpm_profile_paused", Severity: "warning", Component: gi.UUID,
					Summary: "The complete GPM profiling sample is blank",
					Detail:  "Every requested GI counter returned a non-finite value for this sample.",
					Remedy:  "check the NVIDIA driver and profiling stack; use --no-profile if the condition persists", Status: model.StatusStale,
				})
			}
		} else {
			gi.Metrics = unsupportedProfileMetrics(at, "profiling disabled")
		}
		gpu.GPUInstances = append(gpu.GPUInstances, *gi)
	}
	return gpu, diagnostics
}

func addParentMetrics(device gonvml.Device, gpu *model.GPU, at time.Time) {
	if value, ret := device.GetTemperature(gonvml.TEMPERATURE_GPU); ret == gonvml.SUCCESS {
		gpu.Metrics["temperature"] = model.AvailableMetric(float64(value), "celsius", model.SourceNVML, model.ScopePhysicalGPU, at)
	} else {
		gpu.Metrics["temperature"] = unavailableFor(ret, "celsius", model.SourceNVML, model.ScopePhysicalGPU, at)
	}
	if value, ret := device.GetPowerUsage(); ret == gonvml.SUCCESS {
		gpu.Metrics["power"] = model.AvailableMetric(float64(value)/1000, "watts", model.SourceNVML, model.ScopePhysicalGPU, at)
	} else {
		gpu.Metrics["power"] = unavailableFor(ret, "watts", model.SourceNVML, model.ScopePhysicalGPU, at)
	}
	for name, clockType := range map[string]gonvml.ClockType{"sm_clock": gonvml.CLOCK_SM, "memory_clock": gonvml.CLOCK_MEM} {
		if value, ret := device.GetClockInfo(clockType); ret == gonvml.SUCCESS {
			gpu.Metrics[name] = model.AvailableMetric(float64(value), "mhz", model.SourceNVML, model.ScopePhysicalGPU, at)
		} else {
			gpu.Metrics[name] = unavailableFor(ret, "mhz", model.SourceNVML, model.ScopePhysicalGPU, at)
		}
	}
}

func memoryMetric(device gonvml.Device, scope model.MetricScope, at time.Time) model.Memory {
	value, ret := device.GetMemoryInfo()
	if ret != gonvml.SUCCESS {
		memory := model.UnavailableMemory(model.SourceNVML, scope, at, statusFor(ret), ret.String())
		if attributes, attrRet := device.GetAttributes(); attrRet == gonvml.SUCCESS && attributes.MemorySizeMB > 0 {
			total := attributes.MemorySizeMB * 1024 * 1024
			memory.TotalBytes = &total
		}
		return memory
	}
	return model.Memory{TotalBytes: &value.Total, UsedBytes: &value.Used, FreeBytes: &value.Free, Source: model.SourceNVML, Scope: scope, SampledAt: at, Status: model.StatusAvailable}
}

func (p *Provider) sampleGPM(device gonvml.Device, giID int, key string, at time.Time) model.MetricSet {
	support, ret := device.GpmQueryDeviceSupport()
	if ret != gonvml.SUCCESS || support.IsSupportedDevice == 0 {
		message := ret.String()
		if ret == gonvml.SUCCESS {
			message = "GPM is not supported by this GPU"
		}
		p.setGPMCapability(false, message)
		return unsupportedProfileMetrics(at, message)
	}
	p.setGPMCapability(true, "per-GPU-instance profiling is supported")
	current, ret := gonvml.GpmSampleAlloc()
	if ret != gonvml.SUCCESS {
		return unavailableProfileMetricsFor(at, statusFor(ret), ret.String())
	}
	if ret := device.GpmMigSampleGet(giID, current); ret != gonvml.SUCCESS {
		_ = gonvml.GpmSampleFree(current)
		return unavailableProfileMetricsFor(at, statusFor(ret), ret.String())
	}
	p.mu.Lock()
	previous := p.gpmSamples[key]
	p.gpmSamples[key] = current
	p.mu.Unlock()
	if previous == nil {
		return unavailableProfileMetricsFor(at, model.StatusStale, "GPM needs two samples; warming up")
	}
	defer gonvml.GpmSampleFree(previous)

	request := gonvml.GpmMetricsGetType{NumMetrics: uint32(len(gpmProfileMetrics)), Sample1: previous, Sample2: current}
	for i, descriptor := range gpmProfileMetrics {
		request.Metrics[i].MetricId = uint32(descriptor.id)
	}
	if ret := gonvml.GpmMetricsGet(&request); ret != gonvml.SUCCESS {
		return unavailableProfileMetricsFor(at, statusFor(ret), ret.String())
	}
	metrics := make(model.MetricSet, len(gpmProfileMetrics))
	for i, descriptor := range gpmProfileMetrics {
		metrics[descriptor.name] = gpmMetric(request.Metrics[i], at)
	}
	return metrics
}

func gpmMetric(result gonvml.GpmMetric, at time.Time) model.Metric {
	metricRet := gonvml.Return(result.NvmlReturn)
	if metricRet != gonvml.SUCCESS {
		return unavailableFor(metricRet, "percent", model.SourceNVMLGPM, model.ScopeGPUInstance, at)
	}
	if math.IsNaN(result.Value) || math.IsInf(result.Value, 0) {
		return model.UnavailableMetric(
			"percent", model.SourceNVMLGPM, model.ScopeGPUInstance, at, model.StatusStale,
			"GPM returned a non-finite value for this sample",
		)
	}
	return model.AvailableMetric(clampPercent(result.Value), "percent", model.SourceNVMLGPM, model.ScopeGPUInstance, at)
}

type gpmProfileMetric struct {
	id   gonvml.GpmMetricId
	name string
}

var gpmProfileMetrics = []gpmProfileMetric{
	{id: gonvml.GPM_METRIC_GRAPHICS_UTIL, name: "gpu_activity"},
	{id: gonvml.GPM_METRIC_SM_UTIL, name: "sm_activity"},
	{id: gonvml.GPM_METRIC_SM_OCCUPANCY, name: "sm_occupancy"},
	{id: gonvml.GPM_METRIC_ANY_TENSOR_UTIL, name: "tensor_activity"},
	{id: gonvml.GPM_METRIC_DRAM_BW_UTIL, name: "dram_activity"},
}

func deviceUtilizationMetrics(utilization gonvml.Utilization, ret gonvml.Return, at time.Time) model.MetricSet {
	metrics := make(model.MetricSet, 3)
	if ret == gonvml.SUCCESS {
		metrics["gpu_activity"] = model.AvailableMetric(float64(utilization.Gpu), "percent", model.SourceNVML, model.ScopePhysicalGPU, at)
		metrics["sm_activity"] = model.AvailableMetric(float64(utilization.Gpu), "percent", model.SourceNVML, model.ScopePhysicalGPU, at)
		metrics["memory_activity"] = model.AvailableMetric(float64(utilization.Memory), "percent", model.SourceNVML, model.ScopePhysicalGPU, at)
		return metrics
	}
	for _, name := range []string{"gpu_activity", "sm_activity", "memory_activity"} {
		metrics[name] = unavailableFor(ret, "percent", model.SourceNVML, model.ScopePhysicalGPU, at)
	}
	return metrics
}

func gpmSampleKey(gpuUUID string, instance model.GPUInstance) string {
	parts := make([]string, 0, len(instance.ComputeInstances))
	for _, child := range instance.ComputeInstances {
		parts = append(parts, fmt.Sprintf("%s:%d:%s", child.UUID, child.ID, child.Profile))
	}
	sort.Strings(parts)
	return fmt.Sprintf("%s/gi/%d:%s|%s", gpuUUID, instance.ID, instance.Profile, strings.Join(parts, ","))
}

func allGPMMetricsBlank(metrics model.MetricSet) bool {
	for _, descriptor := range gpmProfileMetrics {
		metric, ok := metrics[descriptor.name]
		if !ok || metric.Status != model.StatusStale || !strings.Contains(metric.Message, "non-finite value") {
			return false
		}
	}
	return true
}

func (p *Provider) setGPMCapability(available bool, message string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if available || !p.gpmAvailable {
		p.gpmAvailable = available
		p.gpmMessage = message
	}
}

func (p *Provider) pruneGPMSamples(seen map[string]bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	for key, sample := range p.gpmSamples {
		if !seen[key] {
			_ = gonvml.GpmSampleFree(sample)
			delete(p.gpmSamples, key)
		}
	}
}

func unsupportedProfileMetrics(at time.Time, message string) model.MetricSet {
	return unavailableProfileMetricsFor(at, model.StatusUnsupported, message)
}

func unavailableProfileMetricsFor(at time.Time, status model.MetricStatus, message string) model.MetricSet {
	metrics := make(model.MetricSet, 5)
	for _, descriptor := range gpmProfileMetrics {
		metrics[descriptor.name] = model.UnavailableMetric("percent", model.SourceNVMLGPM, model.ScopeGPUInstance, at, status, message)
	}
	return metrics
}

func profileFromAttributes(attributes gonvml.DeviceAttributes) string {
	if attributes.GpuInstanceSliceCount == 0 {
		return "unknown"
	}
	if attributes.MemorySizeMB == 0 {
		return fmt.Sprintf("%dg", attributes.GpuInstanceSliceCount)
	}
	gb := uint64(math.Round(float64(attributes.MemorySizeMB) / 1024))
	return fmt.Sprintf("%dg.%dgb", attributes.GpuInstanceSliceCount, gb)
}

func computeProfileFromAttributes(attributes gonvml.DeviceAttributes, ret gonvml.Return, parentProfile string) string {
	if ret != gonvml.SUCCESS || attributes.ComputeInstanceSliceCount == 0 {
		return "unknown"
	}
	return fmt.Sprintf("%dc.%s", attributes.ComputeInstanceSliceCount, parentProfile)
}

func int8String(input []int8) string {
	bytes := make([]byte, 0, len(input))
	for _, value := range input {
		if value == 0 {
			break
		}
		bytes = append(bytes, byte(value))
	}
	return strings.TrimSpace(string(bytes))
}

func unavailableFor(ret gonvml.Return, unit string, source model.MetricSource, scope model.MetricScope, at time.Time) model.Metric {
	return model.UnavailableMetric(unit, source, scope, at, statusFor(ret), ret.String())
}

func statusFor(ret gonvml.Return) model.MetricStatus {
	switch ret {
	case gonvml.SUCCESS:
		return model.StatusAvailable
	case gonvml.ERROR_NOT_SUPPORTED, gonvml.ERROR_FUNCTION_NOT_FOUND, gonvml.ERROR_NO_DATA:
		return model.StatusUnsupported
	case gonvml.ERROR_NO_PERMISSION:
		return model.StatusPermissionDenied
	case gonvml.ERROR_NOT_READY, gonvml.ERROR_TIMEOUT:
		return model.StatusStale
	default:
		return model.StatusError
	}
}

func severityFor(ret gonvml.Return) string {
	if ret == gonvml.ERROR_NO_PERMISSION || ret == gonvml.ERROR_NOT_SUPPORTED {
		return "warning"
	}
	return "error"
}

func remedyFor(ret gonvml.Return) string {
	switch ret {
	case gonvml.ERROR_NO_PERMISSION:
		return "run `miglens doctor` to identify which read-only NVIDIA telemetry call is permission-restricted"
	case gonvml.ERROR_LIBRARY_NOT_FOUND, gonvml.ERROR_DRIVER_NOT_LOADED:
		return "install or expose the NVIDIA driver library (libnvidia-ml.so.1) to this process"
	default:
		return "review `miglens doctor` for the exact host capability and permission checks"
	}
}

func diagnostic(code, severity, component, summary, detail, remedy string, status model.MetricStatus) model.Diagnostic {
	return model.Diagnostic{Code: code, Severity: severity, Component: component, Summary: summary, Detail: detail, Remedy: remedy, Status: status}
}

func worseReturn(a, b gonvml.Return) gonvml.Return {
	if a != gonvml.SUCCESS {
		return a
	}
	return b
}

func clampPercent(value float64) float64 {
	if value < 0 {
		return 0
	}
	if value > 100 {
		return 100
	}
	return value
}
