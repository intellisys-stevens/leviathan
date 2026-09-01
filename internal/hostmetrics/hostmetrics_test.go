package hostmetrics

import (
	"errors"
	"math"
	"testing"
	"time"

	"github.com/intellisys-stevens/leviathan/internal/model"
)

func TestSamplerEnrichesCPUAndMemoryAfterWarmup(t *testing.T) {
	statReads := 0
	sampler := New(Options{ReadFile: func(name string) ([]byte, error) {
		switch name {
		case "/proc/stat":
			statReads++
			if statReads == 1 {
				return []byte("cpu  100 0 50 800 50 0 0 0\n"), nil
			}
			return []byte("cpu  140 0 70 870 60 0 0 0\n"), nil
		case "/proc/meminfo":
			return []byte("MemTotal:       1000 kB\nMemAvailable:    400 kB\n"), nil
		default:
			return nil, errors.New("unexpected path")
		}
	}})
	at := time.Date(2026, 8, 31, 12, 0, 0, 0, time.UTC)
	first := model.Snapshot{SampledAt: at}
	sampler.Enrich(&first)
	if first.HostTelemetry == nil || first.HostTelemetry.Metrics["cpu_activity"].Status != model.StatusUnsupported {
		t.Fatalf("first CPU metric = %+v", first.HostTelemetry)
	}
	if first.HostTelemetry.Memory.Status != model.StatusAvailable || *first.HostTelemetry.Memory.UsedBytes != 600*1024 {
		t.Fatalf("first memory = %+v", first.HostTelemetry.Memory)
	}

	second := model.Snapshot{SampledAt: at.Add(time.Second)}
	sampler.Enrich(&second)
	cpu := second.HostTelemetry.Metrics["cpu_activity"]
	if cpu.Status != model.StatusAvailable || cpu.Value == nil || math.Abs(*cpu.Value-(60.0/140.0*100.0)) > 0.001 {
		t.Fatalf("second CPU metric = %+v", cpu)
	}
	if *second.HostTelemetry.Memory.TotalBytes != 1000*1024 || *second.HostTelemetry.Memory.FreeBytes != 400*1024 {
		t.Fatalf("second memory = %+v", second.HostTelemetry.Memory)
	}
}

func TestSamplerFailureDoesNotRemoveHostIdentity(t *testing.T) {
	sampler := New(Options{ReadFile: func(string) ([]byte, error) { return nil, errors.New("denied") }})
	snapshot := model.Snapshot{SampledAt: time.Now().UTC(), Host: model.Host{Hostname: "gpu-node", OS: "linux", Arch: "amd64"}}
	sampler.Enrich(&snapshot)
	if snapshot.Host.Hostname != "gpu-node" || snapshot.Host.OS != "linux" || snapshot.Host.Arch != "amd64" {
		t.Fatalf("host identity changed: %+v", snapshot.Host)
	}
	if snapshot.HostTelemetry == nil || snapshot.HostTelemetry.Metrics["cpu_activity"].Status != model.StatusUnsupported || snapshot.HostTelemetry.Memory.Status != model.StatusUnsupported {
		t.Fatalf("unavailable host telemetry = %+v", snapshot.HostTelemetry)
	}
}

func TestParsersRejectMalformedCounters(t *testing.T) {
	for _, document := range [][]byte{
		[]byte("cpu  1 2 3\n"),
		[]byte("cpu  1 x 3 4\n"),
		[]byte("notcpu 1 2 3 4\n"),
	} {
		if _, err := parseCPUCounters(document); err == nil {
			t.Fatalf("parseCPUCounters(%q) error = nil", document)
		}
	}
	for _, document := range [][]byte{
		[]byte("MemTotal: 100 kB\n"),
		[]byte("MemTotal: 100 kB\nMemAvailable: 101 kB\n"),
		[]byte("MemTotal: invalid kB\nMemAvailable: 1 kB\n"),
	} {
		if _, _, err := parseMemory(document); err == nil {
			t.Fatalf("parseMemory(%q) error = nil", document)
		}
	}
}
