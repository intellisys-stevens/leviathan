// Package hostmetrics reads bounded, host-local CPU and memory telemetry for
// outbound Uplink snapshots. Failure never prevents GPU telemetry delivery.
package hostmetrics

import (
	"bytes"
	"errors"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/intellisys-stevens/leviathan/internal/model"
)

const (
	cpuMetricName = "cpu_activity"
	kibibyte      = uint64(1024)
)

type fileReader func(string) ([]byte, error)

// Options exposes only a test seam. Production callers use the zero value.
type Options struct {
	ReadFile func(string) ([]byte, error)
}

type cpuCounters struct {
	total uint64
	idle  uint64
}

// Sampler retains only the previous aggregate CPU counters. It never retains
// process, command-line, or filesystem contents.
type Sampler struct {
	mu       sync.Mutex
	readFile fileReader
	previous cpuCounters
	haveCPU  bool
}

func New(options Options) *Sampler {
	reader := options.ReadFile
	if reader == nil {
		reader = os.ReadFile
	}
	return &Sampler{readFile: reader}
}

// Enrich adds optional host telemetry to a snapshot. GPU collection and Uplink
// transport remain authoritative even when host telemetry is unavailable.
func (sampler *Sampler) Enrich(snapshot *model.Snapshot) {
	if sampler == nil || snapshot == nil {
		return
	}
	at := snapshot.SampledAt.UTC()
	if at.IsZero() {
		at = time.Now().UTC()
	}
	cpu, memory := sampler.sample(at)
	snapshot.HostTelemetry = &model.HostTelemetry{
		Metrics: model.MetricSet{cpuMetricName: cpu},
		Memory:  memory,
	}
}

func (sampler *Sampler) sample(at time.Time) (model.Metric, model.Memory) {
	sampler.mu.Lock()
	defer sampler.mu.Unlock()

	cpu := model.UnavailableMetric("percent", model.SourceProc, model.ScopeHost, at, model.StatusUnsupported, "host CPU telemetry is unavailable")
	if document, err := sampler.readFile("/proc/stat"); err == nil {
		if current, parseErr := parseCPUCounters(document); parseErr == nil {
			if sampler.haveCPU && current.total > sampler.previous.total && current.idle >= sampler.previous.idle {
				totalDelta := current.total - sampler.previous.total
				idleDelta := current.idle - sampler.previous.idle
				if idleDelta <= totalDelta {
					activity := float64(totalDelta-idleDelta) * 100 / float64(totalDelta)
					cpu = model.AvailableMetric(activity, "percent", model.SourceProc, model.ScopeHost, at)
				}
			}
			sampler.previous = current
			sampler.haveCPU = true
		}
	}

	memory := model.UnavailableMemory(model.SourceProc, model.ScopeHost, at, model.StatusUnsupported, "system memory telemetry is unavailable")
	if document, err := sampler.readFile("/proc/meminfo"); err == nil {
		if total, available, parseErr := parseMemory(document); parseErr == nil {
			used := total - available
			memory = model.Memory{
				TotalBytes: model.Uint64(total),
				UsedBytes:  model.Uint64(used),
				FreeBytes:  model.Uint64(available),
				Source:     model.SourceProc,
				Scope:      model.ScopeHost,
				SampledAt:  at,
				Status:     model.StatusAvailable,
			}
		}
	}
	return cpu, memory
}

func parseCPUCounters(document []byte) (cpuCounters, error) {
	line, _, _ := bytes.Cut(document, []byte{'\n'})
	fields := bytes.Fields(line)
	if len(fields) < 5 || string(fields[0]) != "cpu" {
		return cpuCounters{}, errors.New("aggregate CPU counters are unavailable")
	}
	values := make([]uint64, len(fields)-1)
	for index, field := range fields[1:] {
		value, err := strconv.ParseUint(string(field), 10, 64)
		if err != nil {
			return cpuCounters{}, errors.New("aggregate CPU counters are invalid")
		}
		values[index] = value
	}
	var total uint64
	for _, value := range values {
		if ^uint64(0)-total < value {
			return cpuCounters{}, errors.New("aggregate CPU counters overflow")
		}
		total += value
	}
	idle := values[3]
	if len(values) > 4 {
		if ^uint64(0)-idle < values[4] {
			return cpuCounters{}, errors.New("aggregate CPU idle counters overflow")
		}
		idle += values[4]
	}
	if total == 0 || idle > total {
		return cpuCounters{}, errors.New("aggregate CPU counters are invalid")
	}
	return cpuCounters{total: total, idle: idle}, nil
}

func parseMemory(document []byte) (uint64, uint64, error) {
	values := map[string]uint64{}
	for _, line := range strings.Split(string(document), "\n") {
		fields := strings.Fields(line)
		if len(fields) != 3 || fields[2] != "kB" {
			continue
		}
		name := strings.TrimSuffix(fields[0], ":")
		if name != "MemTotal" && name != "MemAvailable" {
			continue
		}
		value, err := strconv.ParseUint(fields[1], 10, 64)
		if err != nil || value > ^uint64(0)/kibibyte {
			return 0, 0, errors.New("system memory counters are invalid")
		}
		values[name] = value * kibibyte
	}
	total, totalOK := values["MemTotal"]
	available, availableOK := values["MemAvailable"]
	if !totalOK || !availableOK || total == 0 || available > total {
		return 0, 0, errors.New("system memory counters are unavailable")
	}
	return total, available, nil
}
