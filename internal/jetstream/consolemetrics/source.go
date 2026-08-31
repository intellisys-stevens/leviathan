// Package consolemetrics adapts the bounded resource-usage records emitted by
// Exosphere into Leviathan fleet samples. Console output is treated as untrusted
// input: only the documented JSON record is decoded, and raw console text is
// neither retained nor copied into errors, diagnostics, or returned samples.
package consolemetrics

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/intellisys-stevens/leviathan/internal/fleet"
	"github.com/intellisys-stevens/leviathan/internal/model"
)

const (
	DefaultLines           = 200
	DefaultMaxAge          = 5 * time.Minute
	DefaultMaxFutureSkew   = time.Minute
	DefaultMaxConsoleBytes = 256 << 10
	DefaultMaxLineBytes    = 64 << 10

	maxConfiguredLines        = 200
	maxConfiguredAge          = 30 * 24 * time.Hour
	maxConfiguredFutureSkew   = 24 * time.Hour
	maxConfiguredConsoleBytes = 1 << 20
	maxGPUs                   = 64
)

var (
	ErrInvalidConfiguration = errors.New("console metrics configuration is invalid")
	ErrInvalidInstanceUUID  = errors.New("console metrics instance UUID is invalid")
	ErrConsoleUnavailable   = errors.New("instance console output is unavailable")
	ErrConsoleTooLarge      = errors.New("instance console output exceeds the configured limit")
	ErrNoValidSample        = errors.New("instance console contains no valid Exosphere metrics sample")
	ErrNoFreshSample        = errors.New("instance console contains no fresh Exosphere metrics sample")
	ErrInvalidClock         = errors.New("console metrics clock returned an invalid time")
)

var canonicalInstanceUUID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// ConsoleReader returns the requested tail of a server console. Implementations
// should use Nova's os-getConsoleOutput action and enforce their own transport
// timeout. Returned text is untrusted and may contain secrets or terminal data.
type ConsoleReader interface {
	ReadConsole(context.Context, string, int) (string, error)
}

type ConsoleReaderFunc func(context.Context, string, int) (string, error)

func (function ConsoleReaderFunc) ReadConsole(ctx context.Context, instanceUUID string, lines int) (string, error) {
	if function == nil {
		return "", ErrConsoleUnavailable
	}
	return function(ctx, instanceUUID, lines)
}

type Options struct {
	Lines           int
	MaxAge          time.Duration
	MaxFutureSkew   time.Duration
	MaxConsoleBytes int
	MaxLineBytes    int
	Clock           func() time.Time
}

// Source implements fleet.AgentSource without establishing a network path to
// the guest. It stores only a ConsoleReader and immutable parsing limits.
type Source struct {
	reader          ConsoleReader
	lines           int
	maxAge          time.Duration
	maxFutureSkew   time.Duration
	maxConsoleBytes int
	maxLineBytes    int
	clock           func() time.Time
}

var _ fleet.AgentSource = (*Source)(nil)

func New(reader ConsoleReader, options Options) (*Source, error) {
	if reader == nil {
		return nil, ErrInvalidConfiguration
	}

	lines := options.Lines
	if lines < 0 || lines > maxConfiguredLines {
		return nil, ErrInvalidConfiguration
	}
	if lines == 0 {
		lines = DefaultLines
	}

	maxAge := options.MaxAge
	if maxAge < 0 || maxAge > maxConfiguredAge {
		return nil, ErrInvalidConfiguration
	}
	if maxAge == 0 {
		maxAge = DefaultMaxAge
	}

	maxFutureSkew := options.MaxFutureSkew
	if maxFutureSkew < 0 || maxFutureSkew > maxConfiguredFutureSkew {
		return nil, ErrInvalidConfiguration
	}
	if maxFutureSkew == 0 {
		maxFutureSkew = DefaultMaxFutureSkew
	}

	maxConsoleBytes := options.MaxConsoleBytes
	if maxConsoleBytes < 0 || maxConsoleBytes > maxConfiguredConsoleBytes {
		return nil, ErrInvalidConfiguration
	}
	if maxConsoleBytes == 0 {
		maxConsoleBytes = DefaultMaxConsoleBytes
	}

	maxLineBytes := options.MaxLineBytes
	if maxLineBytes < 0 || maxLineBytes > maxConsoleBytes {
		return nil, ErrInvalidConfiguration
	}
	if maxLineBytes == 0 {
		maxLineBytes = min(DefaultMaxLineBytes, maxConsoleBytes)
	}

	clock := options.Clock
	if clock == nil {
		clock = func() time.Time { return time.Now().UTC() }
	}

	return &Source{
		reader:          reader,
		lines:           lines,
		maxAge:          maxAge,
		maxFutureSkew:   maxFutureSkew,
		maxConsoleBytes: maxConsoleBytes,
		maxLineBytes:    maxLineBytes,
		clock:           clock,
	}, nil
}

// Observe reads one bounded console tail and returns the newest structurally
// valid sample whose epoch is within the configured freshness window.
func (source *Source) Observe(ctx context.Context, instance fleet.Instance) (fleet.AgentSample, error) {
	if err := ctx.Err(); err != nil {
		return fleet.AgentSample{}, err
	}
	if source == nil || source.reader == nil {
		return fleet.AgentSample{}, ErrInvalidConfiguration
	}
	if !canonicalInstanceUUID.MatchString(instance.UUID) {
		return fleet.AgentSample{}, ErrInvalidInstanceUUID
	}

	now := source.clock().UTC()
	if now.IsZero() {
		return fleet.AgentSample{}, ErrInvalidClock
	}
	consoleOutput, err := source.reader.ReadConsole(ctx, instance.UUID, source.lines)
	if err != nil {
		if contextErr := ctx.Err(); contextErr != nil {
			return fleet.AgentSample{}, contextErr
		}
		// Reader errors can contain response bodies or provider details. Do not
		// propagate them across this package boundary.
		return fleet.AgentSample{}, ErrConsoleUnavailable
	}
	if err := ctx.Err(); err != nil {
		return fleet.AgentSample{}, err
	}
	if len(consoleOutput) > source.maxConsoleBytes {
		return fleet.AgentSample{}, ErrConsoleTooLarge
	}

	record, err := newestRecord(ctx, consoleOutput, now, source.maxAge, source.maxFutureSkew, source.maxLineBytes)
	// Drop the only package-local reference before constructing the result. Go
	// strings are immutable, so no substring of raw console output is retained.
	consoleOutput = ""
	if err != nil {
		return fleet.AgentSample{}, err
	}

	snapshot := snapshotFor(instance, record)
	return fleet.AgentSample{
		InstanceUUID: instance.UUID,
		Source:       fleet.TelemetrySourceExosphereConsole,
		ObservedAt:   record.sampledAt,
		Snapshot:     snapshot,
	}, nil
}

type gpuFieldState uint8

const (
	gpuFieldMissing gpuFieldState = iota
	gpuFieldNull
	gpuFieldValues
)

type consoleRecord struct {
	epoch       int64
	cpuPct      int
	memPct      int
	rootfsPct   int
	gpuState    gpuFieldState
	gpuPct      []int
	sampledAt   time.Time
	lineOrdinal int
}

func newestRecord(ctx context.Context, output string, now time.Time, maxAge, maxFutureSkew time.Duration, maxLineBytes int) (consoleRecord, error) {
	var latest consoleRecord
	foundFresh := false
	foundStale := false
	lineOrdinal := 0

	for remaining := output; ; lineOrdinal++ {
		if err := ctx.Err(); err != nil {
			return consoleRecord{}, err
		}
		line := remaining
		if newline := strings.IndexByte(remaining, '\n'); newline >= 0 {
			line = remaining[:newline]
			remaining = remaining[newline+1:]
		} else {
			remaining = ""
		}

		if len(line) <= maxLineBytes {
			if objectStart := strings.IndexByte(line, '{'); objectStart >= 0 {
				record, decodeErr := decodeRecord(line[objectStart:])
				if decodeErr == nil {
					record.lineOrdinal = lineOrdinal
					record.sampledAt = time.Unix(record.epoch, 0).UTC()
					switch {
					case record.sampledAt.After(now.Add(maxFutureSkew)):
						// Future-dated records cannot suppress a current sample.
					case record.sampledAt.Before(now.Add(-maxAge)):
						foundStale = true
					default:
						if !foundFresh || record.sampledAt.After(latest.sampledAt) ||
							(record.sampledAt.Equal(latest.sampledAt) && record.lineOrdinal > latest.lineOrdinal) {
							latest = record
							foundFresh = true
						}
					}
				}
			}
		}

		if remaining == "" {
			break
		}
	}

	if foundFresh {
		return latest, nil
	}
	if foundStale {
		return consoleRecord{}, ErrNoFreshSample
	}
	return consoleRecord{}, ErrNoValidSample
}

func decodeRecord(document string) (consoleRecord, error) {
	decoder := json.NewDecoder(strings.NewReader(document))
	start, err := decoder.Token()
	if err != nil || start != json.Delim('{') {
		return consoleRecord{}, ErrNoValidSample
	}

	record := consoleRecord{gpuState: gpuFieldMissing}
	seen := make(map[string]struct{}, 5)
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return consoleRecord{}, ErrNoValidSample
		}
		key, ok := keyToken.(string)
		if !ok {
			return consoleRecord{}, ErrNoValidSample
		}
		if _, duplicate := seen[key]; duplicate {
			return consoleRecord{}, ErrNoValidSample
		}
		seen[key] = struct{}{}

		switch key {
		case "epoch":
			if err := decoder.Decode(&record.epoch); err != nil {
				return consoleRecord{}, ErrNoValidSample
			}
		case "cpuPctUsed":
			if err := decoder.Decode(&record.cpuPct); err != nil {
				return consoleRecord{}, ErrNoValidSample
			}
		case "memPctUsed":
			if err := decoder.Decode(&record.memPct); err != nil {
				return consoleRecord{}, ErrNoValidSample
			}
		case "rootfsPctUsed":
			if err := decoder.Decode(&record.rootfsPct); err != nil {
				return consoleRecord{}, ErrNoValidSample
			}
		case "gpuPctUsed":
			var raw json.RawMessage
			if err := decoder.Decode(&raw); err != nil {
				return consoleRecord{}, ErrNoValidSample
			}
			trimmed := bytes.TrimSpace(raw)
			if bytes.Equal(trimmed, []byte("null")) {
				record.gpuState = gpuFieldNull
				continue
			}
			if len(trimmed) > 0 && trimmed[0] == '[' {
				if err := json.Unmarshal(trimmed, &record.gpuPct); err != nil || record.gpuPct == nil || len(record.gpuPct) > maxGPUs {
					return consoleRecord{}, ErrNoValidSample
				}
			} else {
				var utilization int
				if err := json.Unmarshal(trimmed, &utilization); err != nil {
					return consoleRecord{}, ErrNoValidSample
				}
				record.gpuPct = []int{utilization}
			}
			record.gpuState = gpuFieldValues
		default:
			// Exosphere's decoder ignores fields it does not recognize. Preserve
			// that forward compatibility while still decoding the value inside
			// the already-bounded console line and rejecting malformed JSON.
			var discarded json.RawMessage
			if err := decoder.Decode(&discarded); err != nil {
				return consoleRecord{}, ErrNoValidSample
			}
		}
	}
	end, err := decoder.Token()
	if err != nil || end != json.Delim('}') {
		return consoleRecord{}, ErrNoValidSample
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return consoleRecord{}, ErrNoValidSample
	}

	for _, required := range []string{"epoch", "cpuPctUsed", "memPctUsed", "rootfsPctUsed"} {
		if _, ok := seen[required]; !ok {
			return consoleRecord{}, ErrNoValidSample
		}
	}
	if record.epoch <= 0 || !validPercent(record.cpuPct) || !validPercent(record.memPct) || !validPercent(record.rootfsPct) {
		return consoleRecord{}, ErrNoValidSample
	}
	for _, utilization := range record.gpuPct {
		if !validPercent(utilization) {
			return consoleRecord{}, ErrNoValidSample
		}
	}
	return record, nil
}

func validPercent(value int) bool {
	return value >= 0 && value <= 100
}

func snapshotFor(instance fleet.Instance, record consoleRecord) model.Snapshot {
	gpus := make([]model.GPU, 0, len(record.gpuPct))
	for index, utilization := range record.gpuPct {
		gpuUUID := instance.UUID + "/gpu/" + strconv.Itoa(index)
		metrics := model.MetricSet{
			"gpu_activity": model.AvailableMetric(float64(utilization), "percent", model.SourceSynthetic, model.ScopePhysicalGPU, record.sampledAt),
			"sm_activity":  model.AvailableMetric(float64(utilization), "percent", model.SourceSynthetic, model.ScopePhysicalGPU, record.sampledAt),
			"memory_activity": model.UnavailableMetric(
				"percent", model.SourceSynthetic, model.ScopePhysicalGPU, record.sampledAt,
				model.StatusUnsupported, "GPU memory activity is not reported by Exosphere console telemetry",
			),
		}
		gpus = append(gpus, model.GPU{
			UUID:         gpuUUID,
			Index:        index,
			Name:         "NVIDIA GPU (model unavailable)",
			Memory:       model.UnavailableMemory(model.SourceSynthetic, model.ScopePhysicalGPU, record.sampledAt, model.StatusUnsupported, "GPU memory is not reported by Exosphere console telemetry"),
			Metrics:      metrics,
			GPUInstances: []model.GPUInstance{},
		})
	}

	// Exosphere historically treated an omitted GPU field as an empty list.
	// Only an explicit null means that GPU utilization collection failed.
	consoleAvailable := record.gpuState != gpuFieldNull
	consoleStatus := model.StatusAvailable
	consoleMessage := "synthetic physical-GPU utilization from Exosphere console telemetry"
	if !consoleAvailable {
		consoleStatus = model.StatusUnsupported
		consoleMessage = "Exosphere explicitly reported GPU utilization as unavailable"
	}
	diagnostics := []model.Diagnostic{
		{
			Code:      "console_gpu_memory",
			Severity:  "warning",
			Component: "Exosphere console telemetry",
			Summary:   "GPU memory telemetry is unavailable",
			Remedy:    "install and connect a Leviathan agent for GPU memory telemetry",
			Status:    model.StatusUnsupported,
		},
		{
			Code:      "console_gpu_processes",
			Severity:  "warning",
			Component: "Exosphere console telemetry",
			Summary:   "GPU process inventory is unavailable",
			Remedy:    "install and connect a privileged Leviathan agent for process and user attribution",
			Status:    model.StatusUnsupported,
		},
	}
	if record.gpuState == gpuFieldNull {
		diagnostics = append(diagnostics, model.Diagnostic{
			Code:      "console_gpu_utilization",
			Severity:  "warning",
			Component: "Exosphere console telemetry",
			Summary:   "GPU utilization telemetry is unavailable",
			Remedy:    "verify that nvidia-smi works in the instance or install a Leviathan agent",
			Status:    model.StatusUnsupported,
		})
	}

	hostname := instance.Name
	if hostname == "" {
		hostname = instance.UUID
	}
	return model.Snapshot{
		SchemaVersion: "v1",
		SampledAt:     record.sampledAt,
		Host:          model.Host{Hostname: hostname},
		GPUs:          gpus,
		Processes:     []model.Process{},
		Capabilities: model.Capabilities{
			NVML: model.ProviderState{
				Name:      "exosphere-console",
				Available: consoleAvailable,
				Status:    consoleStatus,
				Message:   consoleMessage,
			},
			GPM:  model.ProviderState{Name: "gpm", Available: false, Status: model.StatusUnsupported, Message: "profiling metrics are unavailable from console telemetry"},
			DCGM: model.ProviderState{Name: "dcgm", Available: false, Status: model.StatusUnsupported, Message: "DCGM metrics are unavailable from console telemetry"},
			Proc: model.ProviderState{Name: "proc", Available: false, Status: model.StatusUnsupported, Message: "process inventory is unavailable from console telemetry"},
		},
		Diagnostics: diagnostics,
	}
}
