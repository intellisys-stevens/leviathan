package uplink

import (
	"bytes"
	"encoding/json"
	"errors"
	"math"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/intellisys-stevens/leviathan/internal/model"
)

const testStreamID = "AAAAAAAAAAAAAAAAAAAAAA"

func TestProjectSanitizesAndDeepCopiesSnapshot(t *testing.T) {
	snapshot := projectionSnapshot()
	envelope, err := Project(snapshot, model.BuildInfo{Version: "0.4.0", Commit: "abc123", BuildDate: "2026-09-02"}, testStreamID, 9)
	if err != nil {
		t.Fatal(err)
	}
	if envelope.Schema != Schema || envelope.Sequence != 9 || envelope.StreamID != testStreamID {
		t.Fatalf("identity = %+v", envelope)
	}
	if len(envelope.System.Storage.Filesystems) != 1 {
		t.Fatalf("filesystems = %+v", envelope.System.Storage.Filesystems)
	}
	filesystem := envelope.System.Storage.Filesystems[0]
	if filesystem.MountPoint != "/var/lib/data" || !strings.HasPrefix(filesystem.ID, "fs_") || filesystem.ID == "raw-device-canary" {
		t.Fatalf("filesystem = %+v", filesystem)
	}
	if _, ok := envelope.GPUs[0].Metrics["secret_metric_canary"]; ok {
		t.Fatal("unknown GPU metric crossed the uplink boundary")
	}
	if metric := envelope.GPUs[0].Metrics["sm_activity"]; metric.Value == nil || *metric.Value != 73 {
		t.Fatalf("safe metric = %+v", metric)
	}

	document, err := json.Marshal(envelope)
	if err != nil {
		t.Fatal(err)
	}
	for _, canary := range []string{
		"raw-device-canary", "process-user-canary", "command-line-canary", "attribution-canary",
		"pci-bus-canary", "generation-canary", "diagnostic-detail-canary", "diagnostic-remedy-canary",
		"diagnostic-component-canary", "metric-message-canary", "secret_metric_canary",
	} {
		if bytes.Contains(document, []byte(canary)) {
			t.Fatalf("private value %q crossed boundary: %s", canary, document)
		}
	}

	*snapshot.System.Memory.UsedBytes = 1
	*snapshot.GPUs[0].Memory.UsedBytes = 2
	*snapshot.GPUs[0].Metrics["sm_activity"].Value = 3
	if *envelope.System.Memory.UsedBytes != 6<<30 || *envelope.GPUs[0].Memory.UsedBytes != 4<<30 || *envelope.GPUs[0].Metrics["sm_activity"].Value != 73 {
		t.Fatal("projection retained pointers into the mutable collector snapshot")
	}
}

func TestProjectBoundsAndNormalizesUntrustedDisplayFields(t *testing.T) {
	snapshot := projectionSnapshot()
	snapshot.Host.Hostname = "host\nsecret"
	snapshot.System.CPU.Model = strings.Repeat("x", maximumIdentityFieldBytes+20)
	snapshot.System.Storage.Filesystems = []model.Filesystem{
		{ID: "one", MountPoint: "relative/path", FSType: "ext4"},
		{ID: "two", MountPoint: "/ok", FSType: "bad\ntype"},
	}
	snapshot.Diagnostics = []model.Diagnostic{
		{Code: "bad\ncode", Summary: "not sent"},
		{Code: "system_sample", Severity: "arbitrary-canary", Summary: strings.Repeat("s", maximumDiagnosticSummary+50), Status: model.StatusError},
		{Code: "gpu_process_fields", Severity: "warning", Summary: "47 GPU process records are incomplete", Status: model.StatusPermissionDenied},
	}
	envelope, err := Project(snapshot, model.BuildInfo{}, testStreamID, 1)
	if err != nil {
		t.Fatal(err)
	}
	if envelope.Host.Hostname != "" || len(envelope.System.CPU.Model) != maximumIdentityFieldBytes {
		t.Fatalf("bounded identity fields = host %q cpu model length %d", envelope.Host.Hostname, len(envelope.System.CPU.Model))
	}
	if len(envelope.System.Storage.Filesystems) != 0 {
		t.Fatalf("invalid filesystems were projected: %+v", envelope.System.Storage.Filesystems)
	}
	if len(envelope.Health.Diagnostics) != 1 || envelope.Health.Diagnostics[0].Summary != "Host telemetry is unavailable" || envelope.Health.Diagnostics[0].Severity != "warning" {
		t.Fatalf("safe diagnostics = %+v", envelope.Health.Diagnostics)
	}
}

func TestProjectConvertsNonFiniteMetricToUnavailable(t *testing.T) {
	snapshot := projectionSnapshot()
	notANumber := math.NaN()
	metric := snapshot.GPUs[0].Metrics["sm_activity"]
	metric.Value = &notANumber
	snapshot.GPUs[0].Metrics["sm_activity"] = metric
	envelope, err := Project(snapshot, model.BuildInfo{}, testStreamID, 1)
	if err != nil {
		t.Fatal(err)
	}
	got := envelope.GPUs[0].Metrics["sm_activity"]
	if got.Value != nil || got.Status != MetricStatus(model.StatusError) {
		t.Fatalf("metric = %+v", got)
	}
	if _, err := json.Marshal(envelope); err != nil {
		t.Fatalf("sanitized envelope does not encode: %v", err)
	}
}

func TestProjectRejectsInvalidEnvelopeIdentity(t *testing.T) {
	snapshot := projectionSnapshot()
	if _, err := Project(snapshot, model.BuildInfo{}, "not-base64", 1); !errors.Is(err, ErrInvalidStreamID) {
		t.Fatalf("stream error = %v", err)
	}
	if _, err := Project(snapshot, model.BuildInfo{}, testStreamID, 0); !errors.Is(err, ErrInvalidSequence) {
		t.Fatalf("sequence error = %v", err)
	}
	snapshot.SampledAt = time.Time{}
	if _, err := Project(snapshot, model.BuildInfo{}, testStreamID, 1); !errors.Is(err, ErrInvalidSnapshot) {
		t.Fatalf("snapshot error = %v", err)
	}
}

func TestNewStreamIDUsesExactly128Bits(t *testing.T) {
	streamID, err := newStreamID(bytes.NewReader(make([]byte, streamIDBytes)))
	if err != nil || streamID != testStreamID || !validStreamID(streamID) {
		t.Fatalf("stream ID = %q, err = %v", streamID, err)
	}
	if _, err := newStreamID(bytes.NewReader(make([]byte, streamIDBytes-1))); !errors.Is(err, ErrInvalidStreamID) {
		t.Fatalf("short randomness error = %v", err)
	}
}

func TestUplinkV1GoldenContract(t *testing.T) {
	envelope, err := Project(projectionSnapshot(), model.BuildInfo{Version: "0.4.0", Commit: "abc123", BuildDate: "2026-09-02"}, testStreamID, 9)
	if err != nil {
		t.Fatal(err)
	}
	wantDocument, err := os.ReadFile("testdata/uplink-v1.golden.json")
	if err != nil {
		t.Fatalf("golden fixture unavailable: %v", err)
	}
	var want Envelope
	if err := json.Unmarshal(wantDocument, &want); err != nil {
		t.Fatalf("golden fixture does not decode through the generated DTO: %v", err)
	}
	if !reflect.DeepEqual(envelope, want) {
		gotDocument, _ := json.MarshalIndent(envelope, "", "  ")
		t.Fatalf("uplink-v1 contract changed; update both repositories together\n--- want\n%s\n--- got\n%s", wantDocument, gotDocument)
	}
}

func projectionSnapshot() model.Snapshot {
	at := time.Date(2026, 9, 2, 12, 34, 56, 0, time.UTC)
	percent := model.AvailableMetric(73, "percent", model.SourceNVMLGPM, model.ScopePhysicalGPU, at)
	percent.Message = "metric-message-canary"
	unsafe := model.AvailableMetric(12, "widgets", model.SourceSynthetic, model.ScopePhysicalGPU, at)
	return model.Snapshot{
		SchemaVersion: "v1",
		Sequence:      77,
		SampledAt:     at,
		Host:          model.Host{Hostname: "node-a", OS: "linux", Arch: "amd64"},
		System: model.System{
			CPU: model.CPU{
				Model: "Example CPU", LogicalProcessors: 8,
				Utilization: model.AvailableMetric(25, "percent", model.SourceProcFS, model.ScopeHost, at),
				Load1:       model.AvailableMetric(1, "load", model.SourceProcFS, model.ScopeHost, at),
				Load5:       model.AvailableMetric(2, "load", model.SourceProcFS, model.ScopeHost, at),
				Load15:      model.AvailableMetric(3, "load", model.SourceProcFS, model.ScopeHost, at),
				Source:      model.SourceProcFS, SampledAt: at, Status: model.StatusAvailable,
			},
			Memory: model.SystemMemory{
				TotalBytes: model.Uint64(16 << 30), UsedBytes: model.Uint64(6 << 30), AvailableBytes: model.Uint64(10 << 30),
				Utilization: model.AvailableMetric(37.5, "percent", model.SourceProcFS, model.ScopeHost, at),
				Source:      model.SourceProcFS, Scope: model.ScopeHost, SampledAt: at, Status: model.StatusAvailable,
			},
			Storage: model.Storage{
				TotalBytes: model.Uint64(100 << 30), UsedBytes: model.Uint64(40 << 30), AvailableBytes: model.Uint64(60 << 30),
				ReadBytesPerSecond:  model.AvailableMetric(1024, "bytes_per_second", model.SourceProcFS, model.ScopeHost, at),
				WriteBytesPerSecond: model.AvailableMetric(2048, "bytes_per_second", model.SourceProcFS, model.ScopeHost, at),
				Filesystems: []model.Filesystem{{
					ID: "raw-device-canary", MountPoint: "/var/lib/data/../data", FSType: "ext4",
					TotalBytes: model.Uint64(100 << 30), UsedBytes: model.Uint64(40 << 30), AvailableBytes: model.Uint64(60 << 30),
					Source: model.SourceStatFS, Scope: model.ScopeHost, SampledAt: at, Status: model.StatusAvailable,
				}},
				Source: model.SourceStatFS, Scope: model.ScopeHost, SampledAt: at, Status: model.StatusAvailable,
			},
			SampledAt: at, Status: model.StatusAvailable,
		},
		GPUs: []model.GPU{{
			UUID: "GPU-aaaaaaaa", Index: 0, Name: "Example GPU", PCIBusID: "pci-bus-canary",
			MIGEnabled: true, MaxMIGDevices: 7,
			Memory:  model.Memory{TotalBytes: model.Uint64(8 << 30), UsedBytes: model.Uint64(4 << 30), FreeBytes: model.Uint64(4 << 30), Source: model.SourceNVML, Scope: model.ScopePhysicalGPU, SampledAt: at, Status: model.StatusAvailable, Message: "metric-message-canary"},
			Metrics: model.MetricSet{"sm_activity": percent, "secret_metric_canary": unsafe},
			GPUInstances: []model.GPUInstance{{
				UUID: "MIG-GI-aaaaaaaa", ID: 1, Profile: "1g.10gb", Generation: "generation-canary",
				Memory:  model.Memory{TotalBytes: model.Uint64(4 << 30), UsedBytes: model.Uint64(2 << 30), FreeBytes: model.Uint64(2 << 30), Source: model.SourceNVML, Scope: model.ScopeGPUInstance, SampledAt: at, Status: model.StatusAvailable},
				Metrics: model.MetricSet{"sm_activity": percent},
				ComputeInstances: []model.ComputeInstance{{
					UUID: "MIG-CI-aaaaaaaa", ID: 2, Profile: "1c.1g.10gb", Generation: "generation-canary",
					Memory:      model.Memory{TotalBytes: model.Uint64(4 << 30), UsedBytes: model.Uint64(2 << 30), FreeBytes: model.Uint64(2 << 30), Source: model.SourceNVML, Scope: model.ScopeComputeInstance, SampledAt: at, Status: model.StatusAvailable},
					Metrics:     model.MetricSet{"sm_activity": percent},
					Diagnostics: []model.Diagnostic{{Detail: "diagnostic-detail-canary"}},
				}},
			}},
		}},
		Processes:    []model.Process{{PID: 123, User: "process-user-canary", CommandLine: "command-line-canary"}},
		Attribution:  &model.Attribution{Workloads: []model.WorkloadAttribution{{Name: "attribution-canary"}}},
		Capabilities: model.Capabilities{NVML: model.ProviderState{Available: true, Status: model.StatusAvailable}},
		Diagnostics: []model.Diagnostic{{
			Code: "collector_sample", Severity: "warning", Component: "diagnostic-component-canary", Summary: "GPU sample delayed",
			Detail: "diagnostic-detail-canary", Remedy: "diagnostic-remedy-canary", Status: model.StatusStale,
		}},
	}
}
