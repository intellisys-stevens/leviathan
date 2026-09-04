// Package nvml implements read-only NVIDIA discovery and sampling without
// invoking or parsing nvidia-smi.
package nvml

import (
	"context"
	"errors"
	"fmt"
	"hash/fnv"
	"math"
	"os"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	gonvml "github.com/NVIDIA/go-nvml/pkg/nvml"
	"github.com/intellisys-stevens/leviathan/internal/model"
	"github.com/intellisys-stevens/leviathan/internal/provider"
)

type Options struct {
	NoProfile             bool
	ProfileInterval       time.Duration
	ProfileStaleAfter     time.Duration
	TopologyInterval      time.Duration
	DisableProfileStagger bool
}

type Provider struct {
	options Options

	mu            sync.RWMutex
	opened        bool
	nvmlStatus    model.MetricStatus
	nvmlMessage   string
	gpmAvailable  bool
	gpmMessage    string
	profileStates map[string]*profileState

	topologyRefreshedAt time.Time
	deviceHandles       []cachedPhysicalDevice
	migDevices          map[string]map[int]cachedMIGDevice
}

func New(options Options) *Provider {
	if options.ProfileInterval <= 0 {
		options.ProfileInterval = 2 * time.Second
	}
	if options.ProfileStaleAfter <= 0 {
		options.ProfileStaleAfter = 2 * options.ProfileInterval
	}
	if options.TopologyInterval <= 0 {
		options.TopologyInterval = 10 * time.Second
	}
	return &Provider{
		options: options, profileStates: make(map[string]*profileState),
		migDevices: make(map[string]map[int]cachedMIGDevice),
	}
}

type cachedDevice struct {
	device gonvml.Device
	ret    gonvml.Return
}

type cachedPhysicalDevice struct {
	cachedDevice
	name          string
	nameRet       gonvml.Return
	uuid          string
	uuidRet       gonvml.Return
	pci           gonvml.PciInfo
	pciRet        gonvml.Return
	migMode       int
	migModeRet    gonvml.Return
	maxMIGDevices int
	maxMIGRet     gonvml.Return
	gpmSupported  bool
	gpmSupportRet gonvml.Return
	gpmSupportOK  bool
	powerLimit    model.Metric
}

type cachedMIGDevice struct {
	cachedDevice
	uuid          string
	uuidRet       gonvml.Return
	giID          int
	giRet         gonvml.Return
	ciID          int
	ciRet         gonvml.Return
	attributes    gonvml.DeviceAttributes
	attributesRet gonvml.Return
	memoryState   *memoryState
}

type memoryState struct {
	mu     sync.Mutex
	nextAt time.Time
	memory model.Memory
}

type profileState struct {
	nextAt          time.Time
	gpmSample       gonvml.GpmSample
	gpmSpare        gonvml.GpmSample
	gpmMetrics      model.MetricSet
	fallbackMetrics model.MetricSet
}

func (p *Provider) Name() string { return "nvml" }

func (p *Provider) Open(context.Context) error {
	if ret := gonvml.Init(); ret != gonvml.SUCCESS {
		status, err := initializationFailure(ret)
		p.mu.Lock()
		p.opened = false
		p.nvmlStatus = status
		p.nvmlMessage = err.Error()
		p.mu.Unlock()
		return err
	}
	p.mu.Lock()
	p.opened = true
	p.nvmlStatus = model.StatusAvailable
	p.nvmlMessage = ""
	p.topologyRefreshedAt = time.Time{}
	p.deviceHandles = nil
	p.migDevices = make(map[string]map[int]cachedMIGDevice)
	p.mu.Unlock()
	return nil
}

func initializationFailure(ret gonvml.Return) (model.MetricStatus, error) {
	status := statusFor(ret)
	err := fmt.Errorf("initialize NVML: %s", ret)
	if ret == gonvml.ERROR_LIBRARY_NOT_FOUND || ret == gonvml.ERROR_DRIVER_NOT_LOADED {
		status = model.StatusUnsupported
		err = fmt.Errorf("%w: %v", provider.ErrUnavailable, err)
	}
	return status, err
}

func (p *Provider) Close() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.opened {
		return nil
	}
	for key, state := range p.profileStates {
		freeProfileSamples(state)
		delete(p.profileStates, key)
	}
	p.topologyRefreshedAt = time.Time{}
	p.deviceHandles = nil
	p.migDevices = make(map[string]map[int]cachedMIGDevice)
	p.opened = false
	p.nvmlStatus = ""
	p.nvmlMessage = ""
	if ret := gonvml.Shutdown(); ret != gonvml.SUCCESS {
		return fmt.Errorf("shutdown NVML: %s", ret)
	}
	return nil
}

func (p *Provider) Capabilities() model.Capabilities {
	p.mu.RLock()
	defer p.mu.RUnlock()
	available := p.opened
	status, message := p.nvmlStatus, p.nvmlMessage
	if status == "" {
		status = model.StatusAvailable
	}
	nvmlState := model.ProviderState{Name: "NVML", Available: available, Status: status, Message: message}
	if !available {
		if p.nvmlStatus == "" {
			nvmlState.Status = model.StatusError
			nvmlState.Message = "NVML is not initialized"
		}
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

	devices, ret := p.physicalDevices(at)
	if ret != gonvml.SUCCESS {
		return snapshot, fmt.Errorf("enumerate NVIDIA GPUs: %s", ret)
	}
	seenProfiles := make(map[string]bool)
	for index, cached := range devices {
		if err := ctx.Err(); err != nil {
			return model.Snapshot{}, err
		}
		if cached.ret != gonvml.SUCCESS {
			snapshot.Diagnostics = append(snapshot.Diagnostics, diagnostic("gpu_handle", "error", fmt.Sprintf("GPU %d", index), "GPU handle is unavailable", cached.ret.String(), remedyFor(cached.ret), statusFor(cached.ret)))
			continue
		}
		gpu, diagnostics := p.sampleGPU(cached, index, at, seenProfiles)
		snapshot.GPUs = append(snapshot.GPUs, gpu)
		snapshot.Diagnostics = append(snapshot.Diagnostics, diagnostics...)
	}
	p.pruneProfileStates(seenProfiles)
	snapshot.Capabilities = p.Capabilities()
	return snapshot, nil
}

func topologyCacheFresh(refreshedAt, at time.Time, interval time.Duration) bool {
	if refreshedAt.IsZero() || interval <= 0 || at.Before(refreshedAt) {
		return false
	}
	return at.Sub(refreshedAt) < interval
}

// Physical and MIG device handles and their identity/topology fields are not
// telemetry. Reusing them avoids repeated RM calls on every dashboard tick;
// the configured topology rescan still discovers MIG changes within a bounded
// interval while memory, utilization, temperature, power, and clocks stay live.
func (p *Provider) physicalDevices(at time.Time) ([]cachedPhysicalDevice, gonvml.Return) {
	p.mu.RLock()
	if topologyCacheFresh(p.topologyRefreshedAt, at, p.options.TopologyInterval) {
		devices := append([]cachedPhysicalDevice(nil), p.deviceHandles...)
		p.mu.RUnlock()
		return devices, gonvml.SUCCESS
	}
	p.mu.RUnlock()

	count, ret := gonvml.DeviceGetCount()
	if ret != gonvml.SUCCESS {
		return nil, ret
	}
	devices := make([]cachedPhysicalDevice, count)
	for index := 0; index < count; index++ {
		device, handleRet := gonvml.DeviceGetHandleByIndex(index)
		cached := cachedPhysicalDevice{cachedDevice: cachedDevice{device: device, ret: handleRet}}
		if handleRet == gonvml.SUCCESS {
			cached.name, cached.nameRet = device.GetName()
			cached.uuid, cached.uuidRet = device.GetUUID()
			cached.pci, cached.pciRet = device.GetPciInfo()
			cached.migMode, _, cached.migModeRet = device.GetMigMode()
			powerLimit, powerLimitRet := device.GetEnforcedPowerLimit()
			cached.powerLimit = milliwattsMetric(powerLimit, powerLimitRet, at)
			if cached.migModeRet == gonvml.SUCCESS && cached.migMode != 0 {
				cached.maxMIGDevices, cached.maxMIGRet = device.GetMaxMigDeviceCount()
			}
			if !p.options.NoProfile {
				support, supportRet := device.GpmQueryDeviceSupport()
				cached.gpmSupported = support.IsSupportedDevice != 0
				cached.gpmSupportRet = supportRet
				cached.gpmSupportOK = cacheableGPMSupportReturn(supportRet)
			}
		}
		devices[index] = cached
	}
	p.mu.Lock()
	p.topologyRefreshedAt = at
	p.deviceHandles = append([]cachedPhysicalDevice(nil), devices...)
	p.migDevices = make(map[string]map[int]cachedMIGDevice)
	p.mu.Unlock()
	return devices, gonvml.SUCCESS
}

func (p *Provider) migDevice(parent gonvml.Device, gpuUUID string, index int) cachedMIGDevice {
	p.mu.RLock()
	if devices := p.migDevices[gpuUUID]; devices != nil {
		if cached, ok := devices[index]; ok {
			p.mu.RUnlock()
			return cached
		}
	}
	p.mu.RUnlock()

	device, ret := parent.GetMigDeviceHandleByIndex(index)
	cached := cachedMIGDevice{cachedDevice: cachedDevice{device: device, ret: ret}, memoryState: &memoryState{}}
	if ret == gonvml.SUCCESS {
		cached.uuid, cached.uuidRet = device.GetUUID()
		cached.giID, cached.giRet = device.GetGpuInstanceId()
		cached.ciID, cached.ciRet = device.GetComputeInstanceId()
		cached.attributes, cached.attributesRet = device.GetAttributes()
	}
	p.mu.Lock()
	devices := p.migDevices[gpuUUID]
	if devices == nil {
		devices = make(map[int]cachedMIGDevice)
		p.migDevices[gpuUUID] = devices
	}
	devices[index] = cached
	p.mu.Unlock()
	return cached
}

func (p *Provider) sampleGPU(cached cachedPhysicalDevice, index int, at time.Time, seenProfiles map[string]bool) (model.GPU, []model.Diagnostic) {
	diagnostics := []model.Diagnostic{}
	device := cached.device
	name, nameRet := cached.name, cached.nameRet
	if nameRet != gonvml.SUCCESS {
		name = fmt.Sprintf("NVIDIA GPU %d", index)
	}
	uuid, uuidRet := cached.uuid, cached.uuidRet
	if uuidRet != gonvml.SUCCESS {
		uuid = fmt.Sprintf("GPU-index-%d", index)
		diagnostics = append(diagnostics, diagnostic("gpu_uuid", "error", uuid, "Stable GPU UUID unavailable", uuidRet.String(), remedyFor(uuidRet), statusFor(uuidRet)))
	}
	gpu := model.GPU{UUID: uuid, Index: index, Name: name, Metrics: make(model.MetricSet), GPUInstances: []model.GPUInstance{}}
	if cached.pciRet == gonvml.SUCCESS {
		gpu.PCIBusID = int8String(cached.pci.BusId[:])
	}
	gpu.Memory = memoryMetric(device, model.ScopePhysicalGPU, at)
	addParentMetrics(device, &gpu, cached.powerLimit, at)

	currentMode, migRet := cached.migMode, cached.migModeRet
	gpu.MIGEnabled = migRet == gonvml.SUCCESS && currentMode != 0
	if migRet != gonvml.SUCCESS && migRet != gonvml.ERROR_NOT_SUPPORTED {
		diagnostics = append(diagnostics, diagnostic("mig_mode", "warning", uuid, "MIG mode could not be read", migRet.String(), remedyFor(migRet), statusFor(migRet)))
	}

	if !gpu.MIGEnabled {
		utilization, ret := device.GetUtilizationRates()
		gpu.Metrics = mergeDeviceUtilizationMetrics(gpu.Metrics, utilization, ret, at)
	}
	physicalProfileKey := fmt.Sprintf("%s/physical/mig=%t", uuid, gpu.MIGEnabled)
	seenProfiles[physicalProfileKey] = true
	gpu.Metrics = provider.MergeMetricSets(
		gpu.Metrics,
		p.samplePhysicalProfile(cached, physicalProfileKey, at),
	)
	if !gpu.MIGEnabled {
		return gpu, diagnostics
	}

	maxMIG, ret := cached.maxMIGDevices, cached.maxMIGRet
	if ret != gonvml.SUCCESS {
		diagnostics = append(diagnostics, diagnostic("mig_enumeration", "error", uuid, "MIG devices could not be enumerated", ret.String(), remedyFor(ret), statusFor(ret)))
		return gpu, diagnostics
	}
	gpu.MaxMIGDevices = maxMIG
	byGI := make(map[uint32]*model.GPUInstance)
	for migIndex := 0; migIndex < maxMIG; migIndex++ {
		cached := p.migDevice(device, uuid, migIndex)
		migDevice, ret := cached.device, cached.ret
		if ret == gonvml.ERROR_NOT_FOUND || ret == gonvml.ERROR_INVALID_ARGUMENT {
			continue
		}
		if ret != gonvml.SUCCESS {
			diagnostics = append(diagnostics, diagnostic("mig_handle", severityFor(ret), uuid, fmt.Sprintf("MIG slot %d is unavailable", migIndex), ret.String(), remedyFor(ret), statusFor(ret)))
			continue
		}
		migUUID, uuidRet := cached.uuid, cached.uuidRet
		if uuidRet != gonvml.SUCCESS {
			migUUID = fmt.Sprintf("%s/mig/%d", uuid, migIndex)
		}
		giID, giRet := cached.giID, cached.giRet
		ciID, ciRet := cached.ciID, cached.ciRet
		if giRet != gonvml.SUCCESS || ciRet != gonvml.SUCCESS {
			diagnostics = append(diagnostics, diagnostic("mig_identity", "error", migUUID, "MIG GI/CI identity is unavailable", fmt.Sprintf("GI: %s; CI: %s", giRet, ciRet), remedyFor(worseReturn(giRet, ciRet)), statusFor(worseReturn(giRet, ciRet))))
			continue
		}

		giKey := uint32(giID)
		gi := byGI[giKey]
		attributes, attributesRet := cached.attributes, cached.attributesRet
		if gi == nil {
			profile := "unknown"
			if attributesRet == gonvml.SUCCESS {
				profile = profileFromAttributes(attributes)
			}
			giUUID := fmt.Sprintf("%s/gi/%d", uuid, giID)
			created := model.GPUInstance{UUID: giUUID, ID: giKey, Profile: profile, Generation: giUUID, Metrics: make(model.MetricSet), ComputeInstances: []model.ComputeInstance{}}
			created.Memory = p.sampleMIGMemory(migDevice, cached.memoryState, giUUID, at)
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
			seenProfiles[key] = true
			gi.Metrics = p.sampleGPM(cached, id, key, at)
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

func addParentMetrics(device gonvml.Device, gpu *model.GPU, powerLimit model.Metric, at time.Time) {
	if value, ret := device.GetTemperature(gonvml.TEMPERATURE_GPU); ret == gonvml.SUCCESS {
		gpu.Metrics["temperature"] = model.AvailableMetric(float64(value), "celsius", model.SourceNVML, model.ScopePhysicalGPU, at)
	} else {
		gpu.Metrics["temperature"] = unavailableFor(ret, "celsius", model.SourceNVML, model.ScopePhysicalGPU, at)
	}
	value, ret := device.GetPowerUsage()
	gpu.Metrics["power"] = milliwattsMetric(value, ret, at)
	gpu.Metrics["power_limit"] = powerLimit
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

func (p *Provider) sampleMIGMemory(device gonvml.Device, state *memoryState, key string, at time.Time) model.Memory {
	return sampleCachedMemory(
		state,
		key,
		at,
		p.options.ProfileInterval,
		p.options.ProfileStaleAfter,
		p.options.DisableProfileStagger,
		func() model.Memory { return memoryMetric(device, model.ScopeGPUInstance, at) },
	)
}

func sampleCachedMemory(
	state *memoryState,
	key string,
	at time.Time,
	interval time.Duration,
	staleAfter time.Duration,
	disableStagger bool,
	sample func() model.Memory,
) model.Memory {
	state.mu.Lock()
	defer state.mu.Unlock()

	if !state.memory.SampledAt.IsZero() && !at.Before(state.memory.SampledAt) && at.Before(state.nextAt) {
		return cachedMemoryAt(state.memory, at, staleAfter)
	}
	if disableStagger {
		state.nextAt = at.Add(interval)
	} else {
		state.nextAt = staggeredProfileTime(at.Add(time.Nanosecond), key+"/memory", interval)
		if state.nextAt.Sub(at) < 100*time.Millisecond {
			state.nextAt = at.Add(100 * time.Millisecond)
		}
	}

	candidate := sample()
	if candidate.Status == model.StatusAvailable || state.memory.Status != model.StatusAvailable ||
		state.memory.SampledAt.IsZero() || at.Sub(state.memory.SampledAt) > staleAfter {
		state.memory = candidate
	}
	return cachedMemoryAt(state.memory, at, staleAfter)
}

func cachedMemoryAt(memory model.Memory, at time.Time, staleAfter time.Duration) model.Memory {
	if memory.Status != model.StatusAvailable || memory.SampledAt.IsZero() || at.Before(memory.SampledAt) || at.Sub(memory.SampledAt) <= staleAfter {
		return memory
	}
	stale := memory
	stale.UsedBytes = nil
	stale.FreeBytes = nil
	stale.Status = model.StatusStale
	stale.Message = "cached MIG memory sample expired before the provider refreshed it"
	return stale
}

func (p *Provider) samplePhysicalProfile(cached cachedPhysicalDevice, key string, at time.Time) model.MetricSet {
	device := cached.device
	return p.sampleProfileEntity(
		key,
		model.ScopePhysicalGPU,
		physicalGPMMetrics,
		at,
		gpmSupportCheckFor(cached),
		func(sample gonvml.GpmSample) gonvml.Return { return device.GpmSampleGet(sample) },
		func() model.MetricSet { return devicePCIeMetrics(device, at) },
	)
}

func (p *Provider) sampleGPM(cached cachedPhysicalDevice, giID int, key string, at time.Time) model.MetricSet {
	device := cached.device
	return p.sampleProfileEntity(
		key,
		model.ScopeGPUInstance,
		gpmProfileMetrics,
		at,
		gpmSupportCheckFor(cached),
		func(sample gonvml.GpmSample) gonvml.Return { return device.GpmMigSampleGet(giID, sample) },
		nil,
	)
}

type gpmSupportCheck func() (bool, gonvml.Return)
type gpmSampler func(gonvml.GpmSample) gonvml.Return

func cacheableGPMSupportReturn(ret gonvml.Return) bool {
	return ret == gonvml.SUCCESS || ret == gonvml.ERROR_NOT_SUPPORTED || ret == gonvml.ERROR_FUNCTION_NOT_FOUND
}

func gpmSupportCheckFor(cached cachedPhysicalDevice) gpmSupportCheck {
	if cached.gpmSupportOK {
		return func() (bool, gonvml.Return) { return cached.gpmSupported, cached.gpmSupportRet }
	}
	return func() (bool, gonvml.Return) {
		support, ret := cached.device.GpmQueryDeviceSupport()
		return support.IsSupportedDevice != 0, ret
	}
}

func (p *Provider) sampleProfileEntity(
	key string,
	scope model.MetricScope,
	descriptors []gpmProfileMetric,
	at time.Time,
	supportCheck gpmSupportCheck,
	sample gpmSampler,
	fallback func() model.MetricSet,
) model.MetricSet {
	state, due := p.profileState(key, at)
	if !due {
		return p.cachedProfileMetrics(state, at)
	}

	if fallback != nil {
		fallbackMetrics := fallback()
		p.mu.Lock()
		state.fallbackMetrics = copyMetricSet(fallbackMetrics)
		p.mu.Unlock()
	}
	if p.options.NoProfile {
		return p.cachedProfileMetrics(state, at)
	}

	supported, ret := supportCheck()
	if ret != gonvml.SUCCESS || !supported {
		message := ret.String()
		status := statusFor(ret)
		if ret == gonvml.SUCCESS {
			message = "GPM is not supported by this GPU"
			status = model.StatusUnsupported
		}
		p.setGPMCapability(false, message)
		p.storeGPMMetrics(state, unavailableProfileMetricsFor(descriptors, scope, at, status, message))
		return p.cachedProfileMetrics(state, at)
	}
	p.setGPMCapability(true, "physical-GPU and GPU-instance profiling is supported")

	p.mu.Lock()
	current := state.gpmSpare
	state.gpmSpare = nil
	p.mu.Unlock()
	if current == nil {
		var ret gonvml.Return
		current, ret = gonvml.GpmSampleAlloc()
		if ret != gonvml.SUCCESS {
			p.storeGPMMetrics(state, unavailableProfileMetricsFor(descriptors, scope, at, statusFor(ret), ret.String()))
			return p.cachedProfileMetrics(state, at)
		}
	}
	if ret := sample(current); ret != gonvml.SUCCESS {
		p.mu.Lock()
		state.gpmSpare = current
		p.mu.Unlock()
		p.storeGPMMetrics(state, unavailableProfileMetricsFor(descriptors, scope, at, statusFor(ret), ret.String()))
		return p.cachedProfileMetrics(state, at)
	}

	p.mu.Lock()
	previous := state.gpmSample
	state.gpmSample = current
	state.gpmSpare = previous
	p.mu.Unlock()
	if previous == nil {
		p.storeGPMMetrics(state, unavailableProfileMetricsFor(descriptors, scope, at, model.StatusStale, "GPM needs two samples; warming up"))
		return p.cachedProfileMetrics(state, at)
	}

	request := gonvml.GpmMetricsGetType{NumMetrics: uint32(len(descriptors)), Sample1: previous, Sample2: current}
	for index, descriptor := range descriptors {
		request.Metrics[index].MetricId = uint32(descriptor.id)
	}
	if ret := gonvml.GpmMetricsGet(&request); ret != gonvml.SUCCESS {
		p.storeGPMMetrics(state, unavailableProfileMetricsFor(descriptors, scope, at, statusFor(ret), ret.String()))
		return p.cachedProfileMetrics(state, at)
	}
	metrics := make(model.MetricSet, len(descriptors))
	for index, descriptor := range descriptors {
		metrics[descriptor.name] = gpmMetric(descriptor, request.Metrics[index], scope, at)
	}
	p.storeGPMMetrics(state, metrics)
	return p.cachedProfileMetrics(state, at)
}

func (p *Provider) profileState(key string, at time.Time) (*profileState, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	state := p.profileStates[key]
	created := false
	if state == nil {
		state = &profileState{}
		state.nextAt = at
		p.profileStates[key] = state
		created = true
	}
	if at.Before(state.nextAt) {
		return state, false
	}
	if p.options.DisableProfileStagger {
		state.nextAt = at.Add(p.options.ProfileInterval)
	} else {
		state.nextAt = staggeredProfileTime(at.Add(time.Nanosecond), key, p.options.ProfileInterval)
		if created && state.nextAt.Sub(at) < 100*time.Millisecond {
			// GPM rate metrics require separated samples. Keep every topology's
			// first baseline immediate, then spread its second read through the
			// configured interval without scheduling an unusably short pair.
			state.nextAt = at.Add(100 * time.Millisecond)
		}
	}
	return state, true
}

func staggeredProfileTime(at time.Time, key string, interval time.Duration) time.Time {
	if interval <= 0 {
		return at
	}
	hash := fnv.New64a()
	_, _ = hash.Write([]byte(key))
	phase := time.Duration(hash.Sum64() % uint64(interval))
	periodStart := at.Truncate(interval)
	candidate := periodStart.Add(phase)
	if candidate.Before(at) {
		candidate = candidate.Add(interval)
	}
	return candidate
}

func (p *Provider) storeGPMMetrics(state *profileState, metrics model.MetricSet) {
	p.mu.Lock()
	if state.gpmMetrics == nil {
		state.gpmMetrics = make(model.MetricSet, len(metrics))
	}
	for name, candidate := range metrics {
		existing, ok := state.gpmMetrics[name]
		// A transient provider error or blank sample must not destroy the last
		// good value. cachedMetricSet will make that value stale once its real
		// sampling timestamp exceeds ProfileStaleAfter. Definitive capability
		// failures replace it immediately.
		if ok && existing.Status == model.StatusAvailable &&
			(candidate.Status == model.StatusStale || candidate.Status == model.StatusError) {
			continue
		}
		state.gpmMetrics[name] = candidate
	}
	p.mu.Unlock()
}

func (p *Provider) cachedProfileMetrics(state *profileState, at time.Time) model.MetricSet {
	p.mu.RLock()
	fallback := copyMetricSet(state.fallbackMetrics)
	gpm := copyMetricSet(state.gpmMetrics)
	p.mu.RUnlock()
	result := cachedMetricSet(fallback, at, p.options.ProfileStaleAfter)
	return provider.MergeMetricSets(result, cachedMetricSet(gpm, at, p.options.ProfileStaleAfter))
}

func cachedMetricSet(metrics model.MetricSet, at time.Time, staleAfter time.Duration) model.MetricSet {
	result := copyMetricSet(metrics)
	for name, metric := range result {
		age := at.Sub(metric.SampledAt)
		if metric.Status == model.StatusAvailable && (age < 0 || age > staleAfter) {
			metric.Value = nil
			metric.Status = model.StatusStale
			metric.Message = "profile metric cache exceeded its freshness interval"
			result[name] = metric
		}
	}
	return result
}

func copyMetricSet(metrics model.MetricSet) model.MetricSet {
	if metrics == nil {
		return make(model.MetricSet)
	}
	result := make(model.MetricSet, len(metrics))
	for name, metric := range metrics {
		result[name] = metric
	}
	return result
}

func gpmMetric(descriptor gpmProfileMetric, result gonvml.GpmMetric, scope model.MetricScope, at time.Time) model.Metric {
	metricRet := gonvml.Return(result.NvmlReturn)
	if metricRet != gonvml.SUCCESS {
		return unavailableFor(metricRet, descriptor.unit, model.SourceNVMLGPM, scope, at)
	}
	if math.IsNaN(result.Value) || math.IsInf(result.Value, 0) {
		return model.UnavailableMetric(
			descriptor.unit, model.SourceNVMLGPM, scope, at, model.StatusStale,
			"GPM returned a non-finite value for this sample",
		)
	}
	value := result.Value * descriptor.scale
	if descriptor.percent {
		value = clampPercent(value)
	} else if value < 0 {
		value = 0
	}
	return model.AvailableMetric(value, descriptor.unit, model.SourceNVMLGPM, scope, at)
}

type gpmProfileMetric struct {
	id      gonvml.GpmMetricId
	name    string
	unit    string
	scale   float64
	percent bool
}

var gpmProfileMetrics = []gpmProfileMetric{
	{id: gonvml.GPM_METRIC_GRAPHICS_UTIL, name: "gpu_activity", unit: "percent", scale: 1, percent: true},
	{id: gonvml.GPM_METRIC_SM_UTIL, name: "sm_activity", unit: "percent", scale: 1, percent: true},
	{id: gonvml.GPM_METRIC_SM_OCCUPANCY, name: "sm_occupancy", unit: "percent", scale: 1, percent: true},
	{id: gonvml.GPM_METRIC_ANY_TENSOR_UTIL, name: "tensor_activity", unit: "percent", scale: 1, percent: true},
	{id: gonvml.GPM_METRIC_DRAM_BW_UTIL, name: "dram_activity", unit: "percent", scale: 1, percent: true},
	{id: gonvml.GPM_METRIC_PCIE_TX_PER_SEC, name: "pcie_tx_bytes_per_second", unit: "bytes_per_second", scale: 1024 * 1024},
	{id: gonvml.GPM_METRIC_PCIE_RX_PER_SEC, name: "pcie_rx_bytes_per_second", unit: "bytes_per_second", scale: 1024 * 1024},
}

var physicalGPMMetrics = []gpmProfileMetric{
	{id: gonvml.GPM_METRIC_GRAPHICS_UTIL, name: "gpu_activity", unit: "percent", scale: 1, percent: true},
	{id: gonvml.GPM_METRIC_SM_UTIL, name: "sm_activity", unit: "percent", scale: 1, percent: true},
	{id: gonvml.GPM_METRIC_PCIE_TX_PER_SEC, name: "pcie_tx_bytes_per_second", unit: "bytes_per_second", scale: 1024 * 1024},
	{id: gonvml.GPM_METRIC_PCIE_RX_PER_SEC, name: "pcie_rx_bytes_per_second", unit: "bytes_per_second", scale: 1024 * 1024},
}

func devicePCIeMetrics(device gonvml.Device, at time.Time) model.MetricSet {
	tx, txRet := device.GetPcieThroughput(gonvml.PCIE_UTIL_TX_BYTES)
	rx, rxRet := device.GetPcieThroughput(gonvml.PCIE_UTIL_RX_BYTES)
	return model.MetricSet{
		"pcie_tx_bytes_per_second": pcieThroughputMetric(tx, txRet, at),
		"pcie_rx_bytes_per_second": pcieThroughputMetric(rx, rxRet, at),
	}
}

func pcieThroughputMetric(value uint32, ret gonvml.Return, at time.Time) model.Metric {
	if ret != gonvml.SUCCESS {
		return unavailableFor(ret, "bytes_per_second", model.SourceNVML, model.ScopePhysicalGPU, at)
	}
	return model.AvailableMetric(float64(value)*1024, "bytes_per_second", model.SourceNVML, model.ScopePhysicalGPU, at)
}

func milliwattsMetric(value uint32, ret gonvml.Return, at time.Time) model.Metric {
	if ret != gonvml.SUCCESS {
		return unavailableFor(ret, "watts", model.SourceNVML, model.ScopePhysicalGPU, at)
	}
	return model.AvailableMetric(float64(value)/1000, "watts", model.SourceNVML, model.ScopePhysicalGPU, at)
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

func mergeDeviceUtilizationMetrics(target model.MetricSet, utilization gonvml.Utilization, ret gonvml.Return, at time.Time) model.MetricSet {
	return provider.MergeMetricSets(target, deviceUtilizationMetrics(utilization, ret, at))
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
		if !descriptor.percent {
			continue
		}
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

func (p *Provider) pruneProfileStates(seen map[string]bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	for key, state := range p.profileStates {
		if !seen[key] {
			freeProfileSamples(state)
			delete(p.profileStates, key)
		}
	}
}

func freeProfileSamples(state *profileState) {
	if state.gpmSample != nil {
		_ = gonvml.GpmSampleFree(state.gpmSample)
		state.gpmSample = nil
	}
	if state.gpmSpare != nil {
		_ = gonvml.GpmSampleFree(state.gpmSpare)
		state.gpmSpare = nil
	}
}

func unsupportedProfileMetrics(at time.Time, message string) model.MetricSet {
	return unavailableProfileMetricsFor(gpmProfileMetrics, model.ScopeGPUInstance, at, model.StatusUnsupported, message)
}

func unavailableProfileMetricsFor(descriptors []gpmProfileMetric, scope model.MetricScope, at time.Time, status model.MetricStatus, message string) model.MetricSet {
	metrics := make(model.MetricSet, len(descriptors))
	for _, descriptor := range descriptors {
		metrics[descriptor.name] = model.UnavailableMetric(descriptor.unit, model.SourceNVMLGPM, scope, at, status, message)
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
		return "run `leviathan doctor` to identify which read-only NVIDIA telemetry call is permission-restricted"
	case gonvml.ERROR_LIBRARY_NOT_FOUND, gonvml.ERROR_DRIVER_NOT_LOADED:
		return "install or expose the NVIDIA driver library (libnvidia-ml.so.1) to this process"
	default:
		return "review `leviathan doctor` for the exact host capability and permission checks"
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
