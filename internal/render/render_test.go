package render

import (
	"bytes"
	"strings"
	"testing"
	"time"

	"github.com/miglens/miglens/internal/model"
)

func TestSnapshotTableIncludesGPUProcessesWithoutGPUAttribution(t *testing.T) {
	now := time.Date(2026, 8, 29, 12, 0, 0, 0, time.UTC)
	availableMemory := model.Memory{
		TotalBytes: model.Uint64(1024), UsedBytes: model.Uint64(0), FreeBytes: model.Uint64(1024),
		Source: model.SourceNVML, Scope: model.ScopeGPUInstance, SampledAt: now, Status: model.StatusAvailable,
	}
	snapshot := model.Snapshot{
		SampledAt: now, Host: model.Host{Hostname: "workspace"},
		Processes: []model.Process{{
			PID: 42, User: "coder", Executable: "/usr/bin/python3", CommandLine: "python3 train.py",
			StartTime: &now, Status: model.StatusAvailable,
		}},
		GPUs: []model.GPU{{
			UUID: "GPU-a", Index: 0, Name: "NVIDIA fixture", MIGEnabled: true, Memory: availableMemory,
			GPUInstances: []model.GPUInstance{{
				UUID: "GPU-a/gi/1", ID: 1, Profile: "1g.10gb", Memory: availableMemory,
				ComputeInstances: []model.ComputeInstance{{UUID: "MIG-a", ID: 0, Profile: "1c.1g.10gb"}},
			}},
		}},
	}

	var output bytes.Buffer
	SnapshotTable(&output, snapshot, false)
	text := output.String()
	for _, expected := range []string{"GPU PROCESSES", "42", "coder", "/usr/bin/python3", "python3 train.py"} {
		if !strings.Contains(text, expected) {
			t.Fatalf("table is missing %q:\n%s", expected, text)
		}
	}
	for _, removed := range []string{"OWNER / PROCESS", "unallocated", "placement"} {
		if strings.Contains(strings.ToLower(text), strings.ToLower(removed)) {
			t.Fatalf("removed concept %q is still rendered:\n%s", removed, text)
		}
	}
}
