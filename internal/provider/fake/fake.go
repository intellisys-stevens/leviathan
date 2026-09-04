package fake

import (
	"context"
	"fmt"
	"math"
	"os"
	"runtime"
	"sort"
	"strings"
	"sync/atomic"
	"time"

	"github.com/intellisys-stevens/leviathan/internal/model"
)

type Provider struct {
	sequence        atomic.Uint64
	scenario        string
	showCommandLine bool
}

type Options struct {
	ShowCommandLine bool
}

var scenarios = []string{"blackwell", "hopper-gpm", "a100-dcgm", "non-mig", "multi-ci", "no-gpus", "missing-libraries", "permission-denied", "stale", "reconfiguration"}

func New() *Provider { return &Provider{scenario: "blackwell"} }

func NewFixture(name string, options ...Options) (*Provider, error) {
	name = strings.ToLower(strings.TrimSpace(name))
	if name == "" || name == "populated" {
		name = "blackwell"
	}
	for _, candidate := range scenarios {
		if name == candidate {
			provider := &Provider{scenario: name}
			if len(options) > 0 {
				provider.showCommandLine = options[0].ShowCommandLine
			}
			return provider, nil
		}
	}
	return nil, fmt.Errorf("unknown fixture %q; available fixtures: %s", name, strings.Join(scenarios, ", "))
}

func Fixtures() []string { return append([]string(nil), scenarios...) }

func (p *Provider) Name() string               { return "fake" }
func (p *Provider) Open(context.Context) error { return nil }
func (p *Provider) Close() error               { return nil }

func (p *Provider) Capabilities() model.Capabilities {
	available := model.ProviderState{Name: "fixture", Available: true, Status: model.StatusAvailable, Message: "deterministic development fixture"}
	unsupported := model.ProviderState{Name: "fixture", Available: false, Status: model.StatusUnsupported, Message: "not used by this fixture"}
	proc := model.ProviderState{Name: "/proc GPU clients (fixture)", Available: true, Status: model.StatusAvailable, Message: "1 deterministic GPU-connected process"}
	capabilities := model.Capabilities{System: available, NVML: available, GPM: available, DCGM: unsupported, Proc: proc, ProfileMetrics: true}
	switch p.scenario {
	case "a100-dcgm":
		capabilities.GPM = model.ProviderState{Name: "NVML GPM", Available: false, Status: model.StatusUnsupported, Message: "Ampere fixture uses DCGM profiling"}
		capabilities.DCGM = model.ProviderState{Name: "DCGM", Available: true, Status: model.StatusAvailable, Message: "fixture DCGM profiling"}
	case "non-mig":
		capabilities.GPM, capabilities.DCGM, capabilities.ProfileMetrics = unsupported, unsupported, false
	case "missing-libraries":
		capabilities.NVML = model.ProviderState{Name: "NVML", Available: false, Status: model.StatusUnsupported, Message: "libnvidia-ml.so.1 is unavailable"}
		capabilities.GPM, capabilities.DCGM, capabilities.ProfileMetrics = unsupported, unsupported, false
	}
	return capabilities
}

func (p *Provider) Sample(_ context.Context, at time.Time) (model.Snapshot, error) {
	seq := p.sequence.Add(1)
	host, _ := os.Hostname()
	snapshot := model.Snapshot{
		SchemaVersion: "v1", Sequence: seq, SampledAt: at.UTC(), Host: model.Host{Hostname: host, OS: runtime.GOOS, Arch: runtime.GOARCH},
		System:       fixtureSystem(seq, at),
		Capabilities: p.Capabilities(), Diagnostics: []model.Diagnostic{}, GPUs: make([]model.GPU, 0, 2),
		Processes: []model.Process{
			{PID: 4100, User: "research", Executable: "/usr/bin/python3", StartTime: timePointer(at.Add(-12 * time.Minute)), Status: model.StatusAvailable},
		},
	}
	if p.showCommandLine {
		snapshot.Processes[0].CommandLine = "/usr/bin/python3 train.py --epochs 20"
	}
	for gpuIndex, count := range []int{4, 2} {
		gpuUUID := fmt.Sprintf("GPU-fixture-%d", gpuIndex)
		gpu := model.GPU{
			UUID: gpuUUID, Index: gpuIndex, Name: "NVIDIA RTX PRO 6000 Blackwell Max-Q Workstation Edition", PCIBusID: fmt.Sprintf("0000:%02x:00.0", 0x31+gpuIndex),
			MIGEnabled: true, MaxMIGDevices: 4, Metrics: model.MetricSet{}, GPUInstances: make([]model.GPUInstance, 0, count),
		}
		total := uint64(96 * 1024 * 1024 * 1024)
		used := uint64((41 + gpuIndex*8) * 1024 * 1024 * 1024)
		free := total - used
		gpu.Memory = model.Memory{TotalBytes: &total, UsedBytes: &used, FreeBytes: &free, Source: model.SourceNVML, Scope: model.ScopePhysicalGPU, SampledAt: at, Status: model.StatusAvailable}
		gpu.Metrics["temperature"] = model.AvailableMetric(48+float64(gpuIndex*3), "celsius", model.SourceNVML, model.ScopePhysicalGPU, at)
		gpu.Metrics["power"] = model.AvailableMetric(142+float64(gpuIndex*17), "watts", model.SourceNVML, model.ScopePhysicalGPU, at)
		gpu.Metrics["power_limit"] = model.AvailableMetric(300+float64(gpuIndex*25), "watts", model.SourceNVML, model.ScopePhysicalGPU, at)
		gpu.Metrics["pcie_tx_bytes_per_second"] = model.AvailableMetric(float64(220+gpuIndex*35)*1024*1024, "bytes_per_second", model.SourceNVMLGPM, model.ScopePhysicalGPU, at)
		gpu.Metrics["pcie_rx_bytes_per_second"] = model.AvailableMetric(float64(510+gpuIndex*45)*1024*1024, "bytes_per_second", model.SourceNVMLGPM, model.ScopePhysicalGPU, at)
		for i := 0; i < count; i++ {
			activity := 12 + math.Mod(float64(seq*7+uint64(i*19+gpuIndex*11)), 81)
			memTotal := uint64(24 * 1024 * 1024 * 1024)
			memUsed := uint64((5 + i*3 + gpuIndex) * 1024 * 1024 * 1024)
			memFree := memTotal - memUsed
			giID := uint32(i + 1)
			ciID := uint32(0)
			migUUID := fmt.Sprintf("MIG-fixture-%d-%d", gpuIndex, i)
			ci := model.ComputeInstance{
				UUID: migUUID, ID: ciID, Profile: "1c.1g.24gb",
				Memory:  model.UnavailableMemory(model.SourceNVML, model.ScopeGPUInstance, at, model.StatusUnsupported, "memory is scoped to the parent GPU instance"),
				Metrics: model.MetricSet{}, Generation: migUUID,
			}
			gi := model.GPUInstance{
				UUID: fmt.Sprintf("%s/gi/%d", gpuUUID, giID), ID: giID, Profile: "1g.24gb", Generation: fmt.Sprintf("%s/gi/%d", gpuUUID, giID),
				Memory: model.Memory{TotalBytes: &memTotal, UsedBytes: &memUsed, FreeBytes: &memFree, Source: model.SourceNVML, Scope: model.ScopeGPUInstance, SampledAt: at, Status: model.StatusAvailable},
				Metrics: model.MetricSet{
					"gpu_activity":             model.AvailableMetric(math.Min(100, activity*0.8+5), "percent", model.SourceNVMLGPM, model.ScopeGPUInstance, at),
					"sm_activity":              model.AvailableMetric(activity, "percent", model.SourceNVMLGPM, model.ScopeGPUInstance, at),
					"tensor_activity":          model.AvailableMetric(activity*0.62, "percent", model.SourceNVMLGPM, model.ScopeGPUInstance, at),
					"dram_activity":            model.AvailableMetric(math.Min(100, activity*0.83), "percent", model.SourceNVMLGPM, model.ScopeGPUInstance, at),
					"pcie_tx_bytes_per_second": model.AvailableMetric((activity*8+40)*1024*1024, "bytes_per_second", model.SourceNVMLGPM, model.ScopeGPUInstance, at),
					"pcie_rx_bytes_per_second": model.AvailableMetric((activity*13+80)*1024*1024, "bytes_per_second", model.SourceNVMLGPM, model.ScopeGPUInstance, at),
				},
				ComputeInstances: []model.ComputeInstance{ci},
			}
			gpu.GPUInstances = append(gpu.GPUInstances, gi)
		}
		snapshot.GPUs = append(snapshot.GPUs, gpu)
	}
	p.applyScenario(&snapshot, seq, at)
	snapshot.Capabilities = p.Capabilities()
	return snapshot, nil
}

func fixtureSystem(sequence uint64, at time.Time) model.System {
	const gib = uint64(1024 * 1024 * 1024)
	memoryTotal := uint64(128) * gib
	memoryUsed := uint64(44+sequence%12) * gib
	memoryAvailable := memoryTotal - memoryUsed
	rootTotal, rootUsed := uint64(512)*gib, uint64(181)*gib
	dataTotal, dataUsed := uint64(2*1024)*gib, uint64(930+sequence%20)*gib
	rootAvailable, dataAvailable := rootTotal-rootUsed, dataTotal-dataUsed
	status := model.StatusAvailable
	return model.System{
		CPU: model.CPU{
			Model: "Leviathan fixture CPU", LogicalProcessors: 32,
			Utilization: model.AvailableMetric(28+float64(sequence%18), "percent", model.SourceSynthetic, model.ScopeHost, at),
			Load1:       model.AvailableMetric(2.4, "load", model.SourceSynthetic, model.ScopeHost, at),
			Load5:       model.AvailableMetric(2.1, "load", model.SourceSynthetic, model.ScopeHost, at),
			Load15:      model.AvailableMetric(1.8, "load", model.SourceSynthetic, model.ScopeHost, at),
			Source:      model.SourceSynthetic, SampledAt: at, Status: status,
		},
		Memory: model.SystemMemory{
			TotalBytes: &memoryTotal, UsedBytes: &memoryUsed, AvailableBytes: &memoryAvailable,
			Utilization: model.AvailableMetric(100*float64(memoryUsed)/float64(memoryTotal), "percent", model.SourceSynthetic, model.ScopeHost, at),
			Source:      model.SourceSynthetic, Scope: model.ScopeHost, SampledAt: at, Status: status,
		},
		Storage: model.Storage{
			TotalBytes: model.Uint64(rootTotal + dataTotal), UsedBytes: model.Uint64(rootUsed + dataUsed), AvailableBytes: model.Uint64(rootAvailable + dataAvailable),
			ReadBytesPerSecond:  model.AvailableMetric(float64(320+sequence%40)*1024*1024, "bytes_per_second", model.SourceSynthetic, model.ScopeHost, at),
			WriteBytesPerSecond: model.AvailableMetric(float64(140+sequence%30)*1024*1024, "bytes_per_second", model.SourceSynthetic, model.ScopeHost, at),
			Filesystems: []model.Filesystem{
				{ID: "fs_fixture_root", MountPoint: "/", FSType: "ext4", TotalBytes: &rootTotal, UsedBytes: &rootUsed, AvailableBytes: &rootAvailable, Source: model.SourceSynthetic, Scope: model.ScopeHost, SampledAt: at, Status: status},
				{ID: "fs_fixture_data", MountPoint: "/data", FSType: "xfs", TotalBytes: &dataTotal, UsedBytes: &dataUsed, AvailableBytes: &dataAvailable, Source: model.SourceSynthetic, Scope: model.ScopeHost, SampledAt: at, Status: status},
			},
			Source: model.SourceSynthetic, Scope: model.ScopeHost, SampledAt: at, Status: status,
		},
		SampledAt: at, Status: status,
	}
}

func (p *Provider) applyScenario(snapshot *model.Snapshot, sequence uint64, at time.Time) {
	switch p.scenario {
	case "hopper-gpm":
		snapshot.GPUs = snapshot.GPUs[:1]
		snapshot.GPUs[0].Name = "NVIDIA H100 80GB HBM3"
		snapshot.GPUs[0].GPUInstances = snapshot.GPUs[0].GPUInstances[:2]
	case "a100-dcgm":
		snapshot.GPUs = snapshot.GPUs[:1]
		gpu := &snapshot.GPUs[0]
		gpu.Name = "NVIDIA A100-SXM4-80GB"
		gpu.GPUInstances = gpu.GPUInstances[:2]
		for giIndex := range gpu.GPUInstances {
			gi := &gpu.GPUInstances[giIndex]
			for name, metric := range gi.Metrics {
				metric.Source = model.SourceDCGM
				gi.Metrics[name] = metric
			}
		}
		for _, name := range []string{"pcie_tx_bytes_per_second", "pcie_rx_bytes_per_second"} {
			metric := gpu.Metrics[name]
			metric.Source = model.SourceNVML
			gpu.Metrics[name] = metric
		}
	case "non-mig":
		gpu := snapshot.GPUs[0]
		gpu.Name = "NVIDIA RTX 6000 Ada Generation"
		gpu.MIGEnabled, gpu.MaxMIGDevices = false, 0
		gpu.GPUInstances = []model.GPUInstance{}
		gpu.Metrics["gpu_activity"] = model.AvailableMetric(37, "percent", model.SourceNVML, model.ScopePhysicalGPU, at)
		gpu.Metrics["sm_activity"] = model.AvailableMetric(37, "percent", model.SourceNVML, model.ScopePhysicalGPU, at)
		gpu.Metrics["memory_activity"] = model.AvailableMetric(21, "percent", model.SourceNVML, model.ScopePhysicalGPU, at)
		gpu.Metrics["pcie_tx_bytes_per_second"] = model.AvailableMetric(180*1024*1024, "bytes_per_second", model.SourceNVML, model.ScopePhysicalGPU, at)
		gpu.Metrics["pcie_rx_bytes_per_second"] = model.AvailableMetric(420*1024*1024, "bytes_per_second", model.SourceNVML, model.ScopePhysicalGPU, at)
		snapshot.GPUs = []model.GPU{gpu}
	case "multi-ci":
		snapshot.GPUs = snapshot.GPUs[:1]
		gpu := &snapshot.GPUs[0]
		gpu.GPUInstances = gpu.GPUInstances[:1]
		gi := &gpu.GPUInstances[0]
		second := gi.ComputeInstances[0]
		second.UUID = "MIG-fixture-0-0-ci-1"
		second.ID = 1
		second.Profile = "1c.1g.24gb"
		gi.ComputeInstances = append(gi.ComputeInstances, second)
	case "no-gpus":
		snapshot.GPUs = []model.GPU{}
	case "missing-libraries":
		snapshot.GPUs = []model.GPU{}
		snapshot.Diagnostics = append(snapshot.Diagnostics, model.Diagnostic{Code: "nvml", Severity: "error", Component: "NVML", Summary: "NVML is unavailable", Detail: "library not found", Remedy: "install or expose libnvidia-ml.so.1 from the NVIDIA driver to this process", Status: model.StatusUnsupported})
	case "permission-denied":
		snapshot.Processes[0].User, snapshot.Processes[0].Executable, snapshot.Processes[0].CommandLine = "", "", ""
		snapshot.Processes[0].Status, snapshot.Processes[0].Message = model.StatusPermissionDenied, "one or more /proc fields are not readable"
		snapshot.Diagnostics = append(snapshot.Diagnostics, model.Diagnostic{Code: "gpu_process_fields", Severity: "warning", Component: "/proc", Summary: "1 GPU process record is incomplete", Detail: "permission denied", Remedy: "run Leviathan as the same workspace user", Status: model.StatusPermissionDenied})
	case "stale":
		for gpuIndex := range snapshot.GPUs {
			for giIndex := range snapshot.GPUs[gpuIndex].GPUInstances {
				gi := &snapshot.GPUs[gpuIndex].GPUInstances[giIndex]
				for name, metric := range gi.Metrics {
					gi.Metrics[name] = model.UnavailableMetric(metric.Unit, metric.Source, metric.Scope, at.Add(-5*time.Second), model.StatusStale, "provider sample paused")
				}
			}
		}
		snapshot.Diagnostics = append(snapshot.Diagnostics, model.Diagnostic{Code: "profiling_paused", Severity: "warning", Component: "GPM", Summary: "Profiling counters are stale", Detail: "provider sample paused", Status: model.StatusStale})
	case "reconfiguration":
		if sequence%3 == 2 {
			snapshot.GPUs[0].GPUInstances = snapshot.GPUs[0].GPUInstances[1:]
		}
	}
	for gpuIndex := range snapshot.GPUs {
		sort.Slice(snapshot.GPUs[gpuIndex].GPUInstances, func(i, j int) bool {
			return snapshot.GPUs[gpuIndex].GPUInstances[i].ID < snapshot.GPUs[gpuIndex].GPUInstances[j].ID
		})
	}
}

func timePointer(value time.Time) *time.Time { return &value }
