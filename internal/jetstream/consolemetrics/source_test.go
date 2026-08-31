package consolemetrics

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/intellisys-stevens/miglens/internal/fleet"
	"github.com/intellisys-stevens/miglens/internal/model"
)

const testInstanceUUID = "123e4567-e89b-42d3-a456-426614174000"

func TestObserveSelectsNewestFreshSampleAndBuildsSyntheticGPUs(t *testing.T) {
	now := time.Date(2026, 8, 31, 2, 0, 0, 0, time.UTC)
	canary := "SECRET-CONSOLE-CANARY"
	older := metricsLine(now.Add(-2*time.Minute), "[10]")
	newest := metricsLine(now.Add(-30*time.Second), "[17,83]")
	output := strings.Join([]string{
		canary,
		"cloud-init noise without an object",
		"[  13.042] " + older,
		metricsLine(now.Add(-10*time.Second), "[101]"),
		"kernel: " + newest,
	}, "\n")

	var requestedUUID string
	var requestedLines int
	source := mustSource(t, ConsoleReaderFunc(func(_ context.Context, uuid string, lines int) (string, error) {
		requestedUUID, requestedLines = uuid, lines
		return output, nil
	}), Options{Lines: 37, Clock: func() time.Time { return now }})

	instance := fleet.Instance{UUID: testInstanceUUID, Name: "gpu-worker"}
	sample, err := source.Observe(context.Background(), instance)
	if err != nil {
		t.Fatalf("Observe() error = %v", err)
	}
	if requestedUUID != testInstanceUUID || requestedLines != 37 {
		t.Fatalf("ReadConsole request = uuid %q, lines %d", requestedUUID, requestedLines)
	}
	if sample.InstanceUUID != testInstanceUUID || sample.Source != fleet.TelemetrySourceExosphereConsole || !sample.ObservedAt.Equal(now.Add(-30*time.Second)) || sample.BuildInfo != nil {
		t.Fatalf("sample identity = %+v", sample)
	}
	if sample.Snapshot.SchemaVersion != "v1" || sample.Snapshot.Host.Hostname != "gpu-worker" || !sample.Snapshot.SampledAt.Equal(sample.ObservedAt) {
		t.Fatalf("snapshot envelope = %+v", sample.Snapshot)
	}
	if sample.Snapshot.Processes == nil || len(sample.Snapshot.Processes) != 0 {
		t.Fatalf("processes = %#v", sample.Snapshot.Processes)
	}
	if sample.Snapshot.GPUs == nil || len(sample.Snapshot.GPUs) != 2 {
		t.Fatalf("GPUs = %#v", sample.Snapshot.GPUs)
	}
	for index, want := range []float64{17, 83} {
		gpu := sample.Snapshot.GPUs[index]
		if gpu.UUID != testInstanceUUID+"/gpu/"+fmt.Sprint(index) || gpu.Index != index || gpu.GPUInstances == nil {
			t.Fatalf("GPU %d identity = %+v", index, gpu)
		}
		for _, name := range []string{"gpu_activity", "sm_activity"} {
			metric := gpu.Metrics[name]
			if metric.Value == nil || *metric.Value != want || metric.Unit != "percent" || metric.Source != model.SourceSynthetic || metric.Scope != model.ScopePhysicalGPU || metric.Status != model.StatusAvailable || !metric.SampledAt.Equal(sample.ObservedAt) {
				t.Fatalf("GPU %d metric %q = %+v", index, name, metric)
			}
		}
		if gpu.Memory.TotalBytes != nil || gpu.Memory.UsedBytes != nil || gpu.Memory.FreeBytes != nil || gpu.Memory.Source != model.SourceSynthetic || gpu.Memory.Status != model.StatusUnsupported {
			t.Fatalf("GPU %d memory = %+v", index, gpu.Memory)
		}
		if memoryActivity := gpu.Metrics["memory_activity"]; memoryActivity.Value != nil || memoryActivity.Status != model.StatusUnsupported {
			t.Fatalf("GPU %d memory activity = %+v", index, memoryActivity)
		}
	}
	if !sample.Snapshot.Capabilities.NVML.Available || sample.Snapshot.Capabilities.NVML.Status != model.StatusAvailable || sample.Snapshot.Capabilities.Proc.Available || sample.Snapshot.Capabilities.Proc.Status != model.StatusUnsupported {
		t.Fatalf("capabilities = %+v", sample.Snapshot.Capabilities)
	}
	assertDiagnosticCodes(t, sample.Snapshot.Diagnostics, "console_gpu_memory", "console_gpu_processes")

	serialized, marshalErr := json.Marshal(sample)
	if marshalErr != nil {
		t.Fatalf("marshal sample: %v", marshalErr)
	}
	if strings.Contains(string(serialized), canary) || strings.Contains(fmt.Sprintf("%+v", sample), canary) {
		t.Fatal("returned sample retained raw console content")
	}
}

func TestObserveAcceptsExosphereGPUFieldVariants(t *testing.T) {
	now := time.Date(2026, 8, 31, 3, 0, 0, 0, time.UTC)
	older := metricsLine(now.Add(-2*time.Minute), "[44]")
	missingGPU := fmt.Sprintf(`{"epoch":%d,"cpuPctUsed":1,"memPctUsed":2,"rootfsPctUsed":3}`, now.Add(-time.Minute).Unix())
	nullGPU := metricsLine(now.Add(-time.Minute), "null")

	t.Run("missing defaults to an empty GPU list", func(t *testing.T) {
		source := sourceWithOutput(t, now, older+"\n"+missingGPU, Options{})
		sample, err := source.Observe(context.Background(), testInstance("missing"))
		if err != nil {
			t.Fatalf("Observe() error = %v", err)
		}
		if sample.Snapshot.GPUs == nil || len(sample.Snapshot.GPUs) != 0 || !sample.ObservedAt.Equal(now.Add(-time.Minute)) {
			t.Fatalf("selected sample = %+v", sample)
		}
		if !sample.Snapshot.Capabilities.NVML.Available || sample.Snapshot.Capabilities.NVML.Status != model.StatusAvailable {
			t.Fatalf("NVML capability = %+v", sample.Snapshot.Capabilities.NVML)
		}
		assertDiagnosticCodes(t, sample.Snapshot.Diagnostics, "console_gpu_memory", "console_gpu_processes")
	})

	t.Run("scalar is normalized to one GPU", func(t *testing.T) {
		scalarGPU := metricsLine(now.Add(-30*time.Second), "67")
		source := sourceWithOutput(t, now, older+"\n"+scalarGPU, Options{})
		sample, err := source.Observe(context.Background(), testInstance("scalar"))
		if err != nil {
			t.Fatalf("Observe() error = %v", err)
		}
		if len(sample.Snapshot.GPUs) != 1 || value(sample.Snapshot.GPUs[0].Metrics["gpu_activity"]) != 67 || !sample.ObservedAt.Equal(now.Add(-30*time.Second)) {
			t.Fatalf("selected scalar-GPU sample = %+v", sample)
		}
	})

	t.Run("null is a valid explicit unavailable value", func(t *testing.T) {
		source := sourceWithOutput(t, now, older+"\n"+nullGPU, Options{})
		sample, err := source.Observe(context.Background(), testInstance("null"))
		if err != nil {
			t.Fatalf("Observe() error = %v", err)
		}
		if sample.Snapshot.GPUs == nil || len(sample.Snapshot.GPUs) != 0 || !sample.ObservedAt.Equal(now.Add(-time.Minute)) {
			t.Fatalf("selected null-GPU sample = %+v", sample)
		}
		if sample.Snapshot.Capabilities.NVML.Available || sample.Snapshot.Capabilities.NVML.Status != model.StatusUnsupported {
			t.Fatalf("NVML capability = %+v", sample.Snapshot.Capabilities.NVML)
		}
		assertDiagnosticCodes(t, sample.Snapshot.Diagnostics, "console_gpu_memory", "console_gpu_processes", "console_gpu_utilization")
	})

	t.Run("empty array is a valid available value with no GPUs", func(t *testing.T) {
		emptyGPU := metricsLine(now.Add(-30*time.Second), "[]")
		source := sourceWithOutput(t, now, older+"\n"+emptyGPU, Options{})
		sample, err := source.Observe(context.Background(), testInstance("empty"))
		if err != nil {
			t.Fatalf("Observe() error = %v", err)
		}
		if sample.Snapshot.GPUs == nil || len(sample.Snapshot.GPUs) != 0 || !sample.ObservedAt.Equal(now.Add(-30*time.Second)) {
			t.Fatalf("selected empty-GPU sample = %+v", sample)
		}
		if !sample.Snapshot.Capabilities.NVML.Available || sample.Snapshot.Capabilities.NVML.Status != model.StatusAvailable {
			t.Fatalf("NVML capability = %+v", sample.Snapshot.Capabilities.NVML)
		}
		assertDiagnosticCodes(t, sample.Snapshot.Diagnostics, "console_gpu_memory", "console_gpu_processes")
	})
}

func TestObserveStrictlyRejectsMalformedRecords(t *testing.T) {
	now := time.Date(2026, 8, 31, 4, 0, 0, 0, time.UTC)
	epoch := now.Add(-time.Minute).Unix()
	tests := map[string]string{
		"duplicate field":     fmt.Sprintf(`{"epoch":%d,"epoch":%d,"cpuPctUsed":1,"memPctUsed":2,"rootfsPctUsed":3,"gpuPctUsed":[4]}`, epoch, epoch+1),
		"trailing object":     metricsLine(time.Unix(epoch, 0), "[4]") + `{}`,
		"trailing text":       metricsLine(time.Unix(epoch, 0), "[4]") + ` attacker`,
		"missing epoch":       `{"cpuPctUsed":1,"memPctUsed":2,"rootfsPctUsed":3,"gpuPctUsed":[4]}`,
		"missing cpu":         fmt.Sprintf(`{"epoch":%d,"memPctUsed":2,"rootfsPctUsed":3,"gpuPctUsed":[4]}`, epoch),
		"missing memory":      fmt.Sprintf(`{"epoch":%d,"cpuPctUsed":1,"rootfsPctUsed":3,"gpuPctUsed":[4]}`, epoch),
		"missing disk":        fmt.Sprintf(`{"epoch":%d,"cpuPctUsed":1,"memPctUsed":2,"gpuPctUsed":[4]}`, epoch),
		"null epoch":          fmt.Sprintf(`{"epoch":null,"cpuPctUsed":1,"memPctUsed":2,"rootfsPctUsed":3,"gpuPctUsed":[4]}`),
		"fractional percent":  fmt.Sprintf(`{"epoch":%d,"cpuPctUsed":1.5,"memPctUsed":2,"rootfsPctUsed":3,"gpuPctUsed":[4]}`, epoch),
		"string percent":      fmt.Sprintf(`{"epoch":%d,"cpuPctUsed":"1","memPctUsed":2,"rootfsPctUsed":3,"gpuPctUsed":[4]}`, epoch),
		"negative cpu":        fmt.Sprintf(`{"epoch":%d,"cpuPctUsed":-1,"memPctUsed":2,"rootfsPctUsed":3,"gpuPctUsed":[4]}`, epoch),
		"memory above range":  fmt.Sprintf(`{"epoch":%d,"cpuPctUsed":1,"memPctUsed":101,"rootfsPctUsed":3,"gpuPctUsed":[4]}`, epoch),
		"disk above range":    fmt.Sprintf(`{"epoch":%d,"cpuPctUsed":1,"memPctUsed":2,"rootfsPctUsed":101,"gpuPctUsed":[4]}`, epoch),
		"negative gpu":        fmt.Sprintf(`{"epoch":%d,"cpuPctUsed":1,"memPctUsed":2,"rootfsPctUsed":3,"gpuPctUsed":[-1]}`, epoch),
		"gpu above range":     fmt.Sprintf(`{"epoch":%d,"cpuPctUsed":1,"memPctUsed":2,"rootfsPctUsed":3,"gpuPctUsed":[101]}`, epoch),
		"gpu object":          fmt.Sprintf(`{"epoch":%d,"cpuPctUsed":1,"memPctUsed":2,"rootfsPctUsed":3,"gpuPctUsed":{"0":4}}`, epoch),
		"zero epoch":          `{"epoch":0,"cpuPctUsed":1,"memPctUsed":2,"rootfsPctUsed":3,"gpuPctUsed":[4]}`,
		"unterminated":        fmt.Sprintf(`{"epoch":%d,"cpuPctUsed":1`, epoch),
		"non-object":          `[1,2,3]`,
		"too many gpu values": fmt.Sprintf(`{"epoch":%d,"cpuPctUsed":1,"memPctUsed":2,"rootfsPctUsed":3,"gpuPctUsed":[%s]}`, epoch, strings.TrimSuffix(strings.Repeat("1,", maxGPUs+1), ",")),
	}

	for name, output := range tests {
		t.Run(name, func(t *testing.T) {
			source := sourceWithOutput(t, now, output, Options{})
			_, err := source.Observe(context.Background(), testInstance(name))
			if !errors.Is(err, ErrNoValidSample) {
				t.Fatalf("Observe() error = %v, want %v", err, ErrNoValidSample)
			}
		})
	}
}

func TestObserveIgnoresBoundedUnknownFields(t *testing.T) {
	now := time.Date(2026, 8, 31, 4, 30, 0, 0, time.UTC)
	document := fmt.Sprintf(
		`{"epoch":%d,"cpuPctUsed":1,"memPctUsed":2,"rootfsPctUsed":3,"gpuPctUsed":[4],"gpuMemoryPctUsed":[5],"future":{"nested":true}}`,
		now.Add(-time.Minute).Unix(),
	)
	source := sourceWithOutput(t, now, document, Options{})
	sample, err := source.Observe(context.Background(), testInstance("future-fields"))
	if err != nil {
		t.Fatalf("Observe() error = %v", err)
	}
	if len(sample.Snapshot.GPUs) != 1 || value(sample.Snapshot.GPUs[0].Metrics["gpu_activity"]) != 4 {
		t.Fatalf("selected sample = %+v", sample)
	}
}

func TestObserveUsesOnlyTheFirstObjectStartOnEachLine(t *testing.T) {
	now := time.Date(2026, 8, 31, 5, 0, 0, 0, time.UTC)
	valid := metricsLine(now.Add(-time.Minute), "[55]")
	output := "attacker {not-json} " + valid
	source := sourceWithOutput(t, now, output, Options{})
	_, err := source.Observe(context.Background(), testInstance("smuggling"))
	if !errors.Is(err, ErrNoValidSample) {
		t.Fatalf("Observe() error = %v, want %v", err, ErrNoValidSample)
	}

	source = sourceWithOutput(t, now, output+"\nboot: "+valid, Options{})
	sample, err := source.Observe(context.Background(), testInstance("noise"))
	if err != nil || len(sample.Snapshot.GPUs) != 1 || value(sample.Snapshot.GPUs[0].Metrics["gpu_activity"]) != 55 {
		t.Fatalf("valid later line was not selected: sample=%+v err=%v", sample, err)
	}
}

func TestObserveFreshnessAndOrdering(t *testing.T) {
	now := time.Date(2026, 8, 31, 6, 0, 0, 0, time.UTC)
	options := Options{MaxAge: 2 * time.Minute, MaxFutureSkew: 30 * time.Second}

	t.Run("expired", func(t *testing.T) {
		source := sourceWithOutput(t, now, metricsLine(now.Add(-2*time.Minute-time.Second), "[1]"), options)
		_, err := source.Observe(context.Background(), testInstance("expired"))
		if !errors.Is(err, ErrNoFreshSample) {
			t.Fatalf("Observe() error = %v, want %v", err, ErrNoFreshSample)
		}
	})

	t.Run("freshness boundary is inclusive", func(t *testing.T) {
		source := sourceWithOutput(t, now, metricsLine(now.Add(-2*time.Minute), "[2]"), options)
		sample, err := source.Observe(context.Background(), testInstance("boundary"))
		if err != nil || value(sample.Snapshot.GPUs[0].Metrics["gpu_activity"]) != 2 {
			t.Fatalf("boundary sample=%+v err=%v", sample, err)
		}
	})

	t.Run("future record cannot suppress a fresh record", func(t *testing.T) {
		output := metricsLine(now.Add(-time.Minute), "[3]") + "\n" + metricsLine(now.Add(time.Minute), "[99]")
		source := sourceWithOutput(t, now, output, options)
		sample, err := source.Observe(context.Background(), testInstance("future"))
		if err != nil || value(sample.Snapshot.GPUs[0].Metrics["gpu_activity"]) != 3 {
			t.Fatalf("selected sample=%+v err=%v", sample, err)
		}
	})

	t.Run("later line wins equal epoch", func(t *testing.T) {
		at := now.Add(-time.Minute)
		output := metricsLine(at, "[4]") + "\n" + metricsLine(at, "[5]")
		source := sourceWithOutput(t, now, output, options)
		sample, err := source.Observe(context.Background(), testInstance("tie"))
		if err != nil || value(sample.Snapshot.GPUs[0].Metrics["gpu_activity"]) != 5 {
			t.Fatalf("selected sample=%+v err=%v", sample, err)
		}
	})
}

func TestObserveBoundsConsoleAndLines(t *testing.T) {
	now := time.Date(2026, 8, 31, 7, 0, 0, 0, time.UTC)
	document := metricsLine(now.Add(-time.Minute), "[61]")

	t.Run("exact console limit is accepted", func(t *testing.T) {
		source := sourceWithOutput(t, now, document, Options{MaxConsoleBytes: len(document), MaxLineBytes: len(document)})
		if _, err := source.Observe(context.Background(), testInstance("exact")); err != nil {
			t.Fatalf("Observe() error = %v", err)
		}
	})

	t.Run("one byte above console limit is rejected", func(t *testing.T) {
		source := sourceWithOutput(t, now, document+" ", Options{MaxConsoleBytes: len(document), MaxLineBytes: len(document)})
		_, err := source.Observe(context.Background(), testInstance("large"))
		if !errors.Is(err, ErrConsoleTooLarge) {
			t.Fatalf("Observe() error = %v, want %v", err, ErrConsoleTooLarge)
		}
	})

	t.Run("oversized line is skipped without hiding a later record", func(t *testing.T) {
		oversized := "prefix {" + strings.Repeat("x", len(document)+10)
		output := oversized + "\n" + document
		source := sourceWithOutput(t, now, output, Options{MaxConsoleBytes: len(output), MaxLineBytes: len(document)})
		sample, err := source.Observe(context.Background(), testInstance("line"))
		if err != nil || value(sample.Snapshot.GPUs[0].Metrics["gpu_activity"]) != 61 {
			t.Fatalf("selected sample=%+v err=%v", sample, err)
		}
	})
}

func TestObserveSanitizesReaderErrorsAndHonorsCancellation(t *testing.T) {
	now := time.Date(2026, 8, 31, 8, 0, 0, 0, time.UTC)
	canary := "RAW-CONSOLE-SECRET"
	source := mustSource(t, ConsoleReaderFunc(func(context.Context, string, int) (string, error) {
		return "", errors.New(canary)
	}), Options{Clock: func() time.Time { return now }})
	_, err := source.Observe(context.Background(), testInstance("reader"))
	if !errors.Is(err, ErrConsoleUnavailable) || strings.Contains(err.Error(), canary) {
		t.Fatalf("sanitized error = %v", err)
	}

	var calls atomic.Int32
	source = mustSource(t, ConsoleReaderFunc(func(context.Context, string, int) (string, error) {
		calls.Add(1)
		return metricsLine(now, "[1]"), nil
	}), Options{Clock: func() time.Time { return now }})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = source.Observe(ctx, testInstance("cancel"))
	if !errors.Is(err, context.Canceled) || calls.Load() != 0 {
		t.Fatalf("cancelled Observe() error=%v calls=%d", err, calls.Load())
	}
}

func TestSourceValidation(t *testing.T) {
	reader := ConsoleReaderFunc(func(context.Context, string, int) (string, error) { return "", nil })
	invalid := []Options{
		{Lines: -1},
		{Lines: maxConfiguredLines + 1},
		{MaxAge: -1},
		{MaxAge: maxConfiguredAge + 1},
		{MaxFutureSkew: -1},
		{MaxFutureSkew: maxConfiguredFutureSkew + 1},
		{MaxConsoleBytes: -1},
		{MaxConsoleBytes: maxConfiguredConsoleBytes + 1},
		{MaxConsoleBytes: 100, MaxLineBytes: 101},
	}
	if _, err := New(nil, Options{}); !errors.Is(err, ErrInvalidConfiguration) {
		t.Fatalf("New(nil) error = %v", err)
	}
	var nilReaderFunc ConsoleReaderFunc
	typedNilSource := mustSource(t, nilReaderFunc, Options{})
	if _, err := typedNilSource.Observe(context.Background(), testInstance("typed-nil")); !errors.Is(err, ErrConsoleUnavailable) {
		t.Fatalf("typed nil reader error = %v", err)
	}
	for _, options := range invalid {
		if _, err := New(reader, options); !errors.Is(err, ErrInvalidConfiguration) {
			t.Fatalf("New(%+v) error = %v", options, err)
		}
	}

	source := mustSource(t, reader, Options{})
	if _, err := source.Observe(context.Background(), fleet.Instance{UUID: "../../not-a-uuid"}); !errors.Is(err, ErrInvalidInstanceUUID) {
		t.Fatalf("invalid UUID error = %v", err)
	}
	zeroClockSource := mustSource(t, reader, Options{Clock: func() time.Time { return time.Time{} }})
	if _, err := zeroClockSource.Observe(context.Background(), testInstance("clock")); !errors.Is(err, ErrInvalidClock) {
		t.Fatalf("zero clock error = %v", err)
	}
	var nilSource *Source
	if _, err := nilSource.Observe(context.Background(), testInstance("nil")); !errors.Is(err, ErrInvalidConfiguration) {
		t.Fatalf("nil source error = %v", err)
	}
}

func FuzzDecodeRecord(f *testing.F) {
	now := time.Date(2026, 8, 31, 9, 0, 0, 0, time.UTC)
	f.Add(metricsLine(now, "[0,100]"))
	f.Add(`{"epoch":1,"cpuPctUsed":0,"memPctUsed":0,"rootfsPctUsed":0,"gpuPctUsed":null}`)
	f.Add(`{"epoch":1,"epoch":2,"cpuPctUsed":0,"memPctUsed":0,"rootfsPctUsed":0,"gpuPctUsed":[]}`)
	f.Add("noise {not-json}")
	f.Fuzz(func(t *testing.T, document string) {
		if len(document) > DefaultMaxLineBytes {
			t.Skip()
		}
		_, _ = decodeRecord(document)
	})
}

func sourceWithOutput(t *testing.T, now time.Time, output string, options Options) *Source {
	t.Helper()
	options.Clock = func() time.Time { return now }
	return mustSource(t, ConsoleReaderFunc(func(context.Context, string, int) (string, error) {
		return output, nil
	}), options)
}

func mustSource(t *testing.T, reader ConsoleReader, options Options) *Source {
	t.Helper()
	source, err := New(reader, options)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	return source
}

func metricsLine(at time.Time, gpuJSON string) string {
	return fmt.Sprintf(`{"epoch":%d,"cpuPctUsed":10,"memPctUsed":20,"rootfsPctUsed":30,"gpuPctUsed":%s}`, at.Unix(), gpuJSON)
}

func testInstance(name string) fleet.Instance {
	return fleet.Instance{UUID: testInstanceUUID, Name: name}
}

func value(metric model.Metric) float64 {
	if metric.Value == nil {
		return -1
	}
	return *metric.Value
}

func assertDiagnosticCodes(t *testing.T, diagnostics []model.Diagnostic, expected ...string) {
	t.Helper()
	if diagnostics == nil || len(diagnostics) != len(expected) {
		t.Fatalf("diagnostics = %+v, want codes %v", diagnostics, expected)
	}
	for index, code := range expected {
		if diagnostics[index].Code != code || diagnostics[index].Detail != "" {
			t.Fatalf("diagnostic %d = %+v, want code %q with no raw detail", index, diagnostics[index], code)
		}
	}
}
