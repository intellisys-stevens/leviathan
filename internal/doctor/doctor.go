package doctor

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	ndcgm "github.com/NVIDIA/go-dcgm/pkg/dcgm"
	gonvml "github.com/NVIDIA/go-nvml/pkg/nvml"
	"github.com/miglens/miglens/internal/config"
	"github.com/miglens/miglens/internal/model"
	gpuprocess "github.com/miglens/miglens/internal/process"
)

type Report struct {
	CheckedAt   time.Time          `json:"checkedAt"`
	Diagnostics []model.Diagnostic `json:"diagnostics"`
}

func Run(_ context.Context, cfg config.Config) Report {
	report := Report{CheckedAt: time.Now().UTC(), Diagnostics: []model.Diagnostic{}}
	report.Diagnostics = append(report.Diagnostics, checkNVML()...)
	report.Diagnostics = append(report.Diagnostics, checkDCGM(cfg.DCGMAddress))
	report.Diagnostics = append(report.Diagnostics, checkProc()...)
	return report
}

func checkNVML() []model.Diagnostic {
	if ret := gonvml.Init(); ret != gonvml.SUCCESS {
		return []model.Diagnostic{{
			Code: "nvml", Severity: "error", Component: "NVML", Summary: "NVML is unavailable", Detail: ret.String(),
			Remedy: "install or expose libnvidia-ml.so.1 from the NVIDIA driver to this process", Status: nvmlStatus(ret),
		}}
	}
	defer gonvml.Shutdown()
	count, ret := gonvml.DeviceGetCount()
	if ret != gonvml.SUCCESS {
		return []model.Diagnostic{{Code: "nvml", Severity: "error", Component: "NVML", Summary: "GPU enumeration failed", Detail: ret.String(), Status: nvmlStatus(ret)}}
	}
	result := []model.Diagnostic{{Code: "nvml", Severity: "info", Component: "NVML", Summary: fmt.Sprintf("NVML found %d physical GPU(s)", count), Status: model.StatusAvailable}}
	gpmCount, migCount, readableMIG := 0, 0, 0
	for index := 0; index < count; index++ {
		device, handleRet := gonvml.DeviceGetHandleByIndex(index)
		if handleRet != gonvml.SUCCESS {
			continue
		}
		if support, supportRet := device.GpmQueryDeviceSupport(); supportRet == gonvml.SUCCESS && support.IsSupportedDevice != 0 {
			gpmCount++
		}
		if max, maxRet := device.GetMaxMigDeviceCount(); maxRet == gonvml.SUCCESS {
			for migIndex := 0; migIndex < max; migIndex++ {
				migDevice, migRet := device.GetMigDeviceHandleByIndex(migIndex)
				if migRet != gonvml.SUCCESS {
					continue
				}
				migCount++
				if _, memoryRet := migDevice.GetMemoryInfo(); memoryRet == gonvml.SUCCESS {
					readableMIG++
				}
			}
		}
	}
	status, severity := model.StatusAvailable, "info"
	message := fmt.Sprintf("GPM supported on %d of %d physical GPU(s); %d active MIG device(s), %d with readable memory", gpmCount, count, migCount, readableMIG)
	if gpmCount == 0 {
		status, severity = model.StatusUnsupported, "warning"
	}
	result = append(result, model.Diagnostic{
		Code: "gpm", Severity: severity, Component: "NVML GPM", Summary: message,
		Remedy: "allow DCGM fallback for architectures without GPM", Status: status,
	})
	if migCount > 0 && readableMIG != migCount {
		result = append(result, model.Diagnostic{
			Code: "mig_memory", Severity: "warning", Component: "NVML",
			Summary: fmt.Sprintf("MIG memory is readable on %d of %d active device(s)", readableMIG, migCount),
			Remedy:  "expose the allocated NVIDIA device nodes read-only to MIGLens", Status: model.StatusPermissionDenied,
		})
	}
	return result
}

func checkDCGM(address string) model.Diagnostic {
	args := []string{address, "0"}
	if strings.Contains(address, "://") {
		args = []string{address}
	}
	cleanup, err := ndcgm.Init(ndcgm.Standalone, args...)
	if err != nil {
		return model.Diagnostic{
			Code: "dcgm", Severity: "warning", Component: "DCGM", Summary: "Local DCGM is unavailable", Detail: err.Error(),
			Remedy: "install DCGM 4 and run nv-hostengine locally, or use NVML/GPM with --provider nvml", Status: model.StatusUnsupported,
		}
	}
	cleanup()
	return model.Diagnostic{Code: "dcgm", Severity: "info", Component: "DCGM", Summary: "DCGM hostengine is reachable at " + address, Status: model.StatusAvailable}
}

func checkProc() []model.Diagnostic {
	result := checkProcessVisibility("/proc", "/dev/nvidia-uvm", uint32(os.Getpid()))
	result = append(result, model.Diagnostic{Code: "platform", Severity: "info", Component: "runtime", Summary: fmt.Sprintf("%s/%s", runtime.GOOS, runtime.GOARCH), Status: model.StatusAvailable})
	return result
}

func checkProcessVisibility(procRoot, uvmPath string, selfPID uint32) []model.Diagnostic {
	entries, err := os.ReadDir(procRoot)
	if err != nil {
		return []model.Diagnostic{{
			Code: "proc", Severity: "warning", Component: procRoot, Summary: "Current PID namespace is unavailable",
			Detail: err.Error(), Remedy: "make the current process namespace's /proc filesystem readable by MIGLens", Status: pathStatus(err),
		}}
	}
	processCount := 0
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		if pid, parseErr := strconv.ParseUint(entry.Name(), 10, 32); parseErr == nil && pid > 0 {
			processCount++
		}
	}
	pidOne := "unknown"
	if data, readErr := os.ReadFile(filepath.Join(procRoot, "1", "comm")); readErr == nil {
		pidOne = strings.TrimSpace(string(data))
	}
	result := []model.Diagnostic{{
		Code: "proc", Severity: "info", Component: procRoot,
		Summary: fmt.Sprintf("Current PID namespace exposes %d process(es); PID 1 is %s", processCount, pidOne),
		Detail:  "Only GPU-connected processes visible in this PID namespace are eligible for collection. A container-local PID 1 is healthy.",
		Status:  model.StatusAvailable,
	}}

	fdPath := filepath.Join(procRoot, strconv.FormatUint(uint64(selfPID), 10), "fd")
	if _, fdErr := os.ReadDir(fdPath); fdErr != nil {
		result = append(result, model.Diagnostic{
			Code: "proc_fds", Severity: "warning", Component: fdPath, Summary: "Process file descriptors cannot be inspected",
			Detail: fdErr.Error(), Remedy: "make /proc/<pid>/fd metadata readable to the workspace user running MIGLens", Status: pathStatus(fdErr),
		})
	} else {
		result = append(result, model.Diagnostic{
			Code: "proc_fds", Severity: "info", Component: fdPath, Summary: "Process file-descriptor metadata is readable",
			Detail: "MIGLens inspects device identity only; it does not read process environments or arbitrary file contents.", Status: model.StatusAvailable,
		})
	}

	if _, uvmErr := os.Stat(uvmPath); uvmErr != nil {
		result = append(result, model.Diagnostic{
			Code: "nvidia_uvm", Severity: "warning", Component: uvmPath, Summary: "NVIDIA UVM device is unavailable",
			Detail: uvmErr.Error(), Remedy: "expose /dev/nvidia-uvm to this workspace; hostPID, NVIDIA MIG monitor capability, and runtime sockets are not required", Status: pathStatus(uvmErr),
		})
		return result
	}
	result = append(result, model.Diagnostic{
		Code: "nvidia_uvm", Severity: "info", Component: uvmPath, Summary: "NVIDIA UVM device is visible",
		Detail: "An open UVM handle identifies a GPU-connected CUDA process, including an idle context.", Status: model.StatusAvailable,
	})

	scanner := gpuprocess.NewScanner(false)
	scanner.Root = procRoot
	scanner.UVMPath = uvmPath
	scanner.SelfPID = selfPID
	inventory := scanner.Scan()
	if inventory.Capability.Available {
		result = append(result, model.Diagnostic{
			Code: "gpu_processes", Severity: "info", Component: procRoot,
			Summary: fmt.Sprintf("Found %d GPU-connected process(es) in the current PID namespace", len(inventory.Processes)),
			Detail:  "Zero GPU clients is healthy. A match does not claim active kernels, GPU memory use, or GI/CI ownership.", Status: model.StatusAvailable,
		})
	} else {
		result = append(result, model.Diagnostic{
			Code: "gpu_processes", Severity: "warning", Component: procRoot, Summary: "GPU-connected process inventory is unavailable",
			Detail: inventory.Capability.Message, Remedy: "make /proc/<pid>/fd metadata readable to the workspace user running MIGLens", Status: inventory.Capability.Status,
		})
	}
	result = append(result, inventory.Diagnostics...)
	return result
}

func pathStatus(err error) model.MetricStatus {
	if errors.Is(err, os.ErrPermission) {
		return model.StatusPermissionDenied
	}
	if errors.Is(err, os.ErrNotExist) {
		return model.StatusUnsupported
	}
	return model.StatusError
}

func nvmlStatus(ret gonvml.Return) model.MetricStatus {
	if ret == gonvml.ERROR_NO_PERMISSION {
		return model.StatusPermissionDenied
	}
	if ret == gonvml.ERROR_NOT_SUPPORTED || ret == gonvml.ERROR_LIBRARY_NOT_FOUND || ret == gonvml.ERROR_DRIVER_NOT_LOADED {
		return model.StatusUnsupported
	}
	return model.StatusError
}
