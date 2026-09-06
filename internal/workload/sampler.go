package workload

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/intellisys-stevens/leviathan/internal/attribution"
	"github.com/intellisys-stevens/leviathan/internal/model"
)

type Sampler interface {
	Sample(context.Context, time.Time) (model.WorkloadTelemetry, error)
	Close() error
}
type Options struct {
	SocketPath string
	CgroupRoot string
	SysfsRoot  string
	// Now retains a monotonic component in production; tests may supply a clock.
	Now func() time.Time
}
type inventoryReader interface {
	Read(context.Context, time.Time) (Document, error)
	Close()
}
type Collector struct {
	mu             sync.Mutex
	options        Options
	client         inventoryReader
	inventory      *Document
	lastRead       time.Time
	inventoryError string
	previous       map[string]podSample
}
type podSample struct {
	at          time.Time
	clockAt     time.Time
	info        fs.FileInfo
	cpu         uint64
	cpuOK       bool
	read, write uint64
	ioOK        bool
	devices     string
	ioCounters  map[string]ioCounter
}

func NewSampler(options Options) (*Collector, error) {
	if options.Now == nil {
		options.Now = time.Now
	}
	if options.CgroupRoot == "" {
		options.CgroupRoot = "/sys/fs/cgroup"
	}
	if options.SysfsRoot == "" {
		options.SysfsRoot = "/sys"
	}
	for _, path := range []string{options.CgroupRoot, options.SysfsRoot} {
		if !filepath.IsAbs(path) || filepath.Clean(path) != path {
			return nil, errors.New("workload roots must be absolute clean paths")
		}
	}
	client, err := NewClient(options.SocketPath)
	if err != nil {
		return nil, err
	}
	return &Collector{options: options, client: client, previous: map[string]podSample{}}, nil
}
func (c *Collector) Close() error { c.mu.Lock(); defer c.mu.Unlock(); c.client.Close(); return nil }

var metricUnits = map[string]string{"cpu_cores": "cores", "memory_used_bytes": "bytes", "storage_read_bps": "B/s", "storage_write_bps": "B/s"}

func missingMetrics(at time.Time, status model.MetricStatus, message string) model.MetricSet {
	metrics := model.MetricSet{}
	for name, unit := range metricUnits {
		metrics[name] = model.UnavailableMetric(unit, model.SourceCgroupFS, model.ScopeWorkloadOwner, at, status, message)
	}
	return metrics
}

func (c *Collector) Sample(ctx context.Context, at time.Time) (model.WorkloadTelemetry, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return model.WorkloadTelemetry{}, err
	}
	now := time.Now() // retains monotonic freshness even when the wall clock changes
	if c.lastRead.IsZero() || now.Sub(c.lastRead) >= 5*time.Second {
		document, err := c.client.Read(ctx, at)
		c.lastRead = now
		if err != nil {
			c.inventoryError = err.Error()
		} else {
			c.inventory = &document
			c.inventoryError = ""
		}
	}
	result := model.WorkloadTelemetry{SampledAt: at, Status: model.WorkloadTelemetryUnavailable, Owners: []model.WorkloadOwnerTelemetry{}}
	if c.inventory == nil {
		result.Message = c.inventoryError
		if result.Message == "" {
			result.Message = "Waiting for workspace inventory"
		}
		return result, nil
	}
	document := c.inventory
	observed := document.ObservedAt
	result.ObservedAt = &observed
	result.Status = document.Status
	result.Message = document.Message
	for _, owner := range document.Owners {
		result.Owners = append(result.Owners, model.WorkloadOwnerTelemetry{Ref: owner.Ref, Name: owner.Name, Platform: owner.Platform, Workspaces: append([]model.WorkloadAttribution{}, owner.Workspaces...), SampledAt: at, Status: model.WorkloadTelemetryAvailable, Metrics: model.MetricSet{}})
	}
	unavailable := func(status model.WorkloadTelemetryStatus, metricStatus model.MetricStatus, message string) (model.WorkloadTelemetry, error) {
		result.Status = status
		result.Message = message
		c.previous = map[string]podSample{}
		for i := range result.Owners {
			result.Owners[i].Status = status
			result.Owners[i].Message = message
			result.Owners[i].Metrics = missingMetrics(at, metricStatus, message)
		}
		return result, nil
	}
	if c.inventoryError != "" {
		return unavailable(model.WorkloadTelemetryStale, model.StatusStale, c.inventoryError)
	}
	if now.Sub(c.lastRead) > 15*time.Second || at.Sub(document.ObservedAt) > 15*time.Second || document.ObservedAt.After(at.Add(5*time.Second)) {
		return unavailable(model.WorkloadTelemetryStale, model.StatusStale, "Workspace inventory is stale")
	}
	if document.Status != model.WorkloadTelemetryAvailable {
		status := model.StatusError
		if document.Status == model.WorkloadTelemetryStale {
			status = model.StatusStale
		}
		message := document.Message
		if message == "" {
			message = "Workspace ownership is unavailable"
		}
		return unavailable(document.Status, status, message)
	}
	if runtime.GOOS != "linux" {
		return unavailable(model.WorkloadTelemetryUnavailable, model.StatusUnsupported, "Cgroup v2 telemetry requires Linux")
	}
	root, err := os.OpenRoot(c.options.CgroupRoot)
	if err != nil {
		return unavailable(model.WorkloadTelemetryUnavailable, readStatus(err), "Cgroup telemetry is unavailable")
	}
	defer root.Close()
	if _, err = readBounded(root, "cgroup.controllers", 64<<10); err != nil {
		return unavailable(model.WorkloadTelemetryUnavailable, readStatus(err), "Cgroup v2 controllers are unavailable")
	}
	paths, err := discoverPods(ctx, c.options.CgroupRoot)
	if err != nil {
		return unavailable(model.WorkloadTelemetryUnavailable, readStatus(err), "Pod cgroup discovery is incomplete")
	}
	// Inventory requests and discovery may take time. Timestamp the actual
	// accounting pass after them instead of biasing every inventory-poll delta.
	if c.options.Now != nil {
		at = c.options.Now()
		result.SampledAt = at
		for i := range result.Owners {
			result.Owners[i].SampledAt = at
		}
	}
	byOwner := map[string][]Pod{}
	for _, pod := range document.Pods {
		byOwner[pod.OwnerRef] = append(byOwner[pod.OwnerRef], pod)
	}
	next := map[string]podSample{}
	for i := range result.Owners {
		owner := &result.Owners[i]
		pods := byOwner[owner.Ref]
		sums := map[string]float64{}
		valid := map[string]int{}
		reasons := map[string]model.Metric{}
		for _, pod := range pods {
			path, exists := paths[pod.ScopeRef]
			metrics := missingMetrics(at, model.StatusError, "Pod cgroup is pending, absent, or ambiguous")
			if exists && path != "" {
				var sample podSample
				metrics, sample = c.samplePod(root, path, pod.ScopeRef, at)
				next[pod.ScopeRef] = sample
			}
			for name, metric := range metrics {
				if metric.Status == model.StatusAvailable && metric.Value != nil {
					sums[name] += *metric.Value
					valid[name]++
				} else {
					reasons[name] = metric
				}
			}
		}
		for name, unit := range metricUnits {
			if len(pods) > 0 && valid[name] == len(pods) && !math.IsInf(sums[name], 0) {
				owner.Metrics[name] = model.AvailableMetric(sums[name], unit, model.SourceCgroupFS, model.ScopeWorkloadOwner, at)
			} else {
				status := model.StatusError
				message := "No observed Pod cgroup"
				if reason, ok := reasons[name]; ok {
					status = reason.Status
					message = reason.Message
				}
				if valid[name] > 0 {
					message = fmt.Sprintf("Partial: %d of %d Pod readings available", valid[name], len(pods))
					status = model.StatusError
				}
				owner.Metrics[name] = model.UnavailableMetric(unit, model.SourceCgroupFS, model.ScopeWorkloadOwner, at, status, message)
				owner.Status = model.WorkloadTelemetryPartial
			}
		}
		if owner.Status == model.WorkloadTelemetryPartial {
			owner.Message = "Partial: one or more resource measurements are unavailable"
			result.Status = model.WorkloadTelemetryPartial
		}
	}
	c.previous = next
	if result.Status == model.WorkloadTelemetryPartial {
		result.Message = "Some owner resource measurements are incomplete"
	}
	return result, nil
}

func (c *Collector) samplePod(root *os.Root, path, scope string, at time.Time) (model.MetricSet, podSample) {
	metrics := missingMetrics(at, model.StatusError, "Waiting for a second cgroup sample")
	info, err := root.Stat(path)
	if err != nil || !info.IsDir() {
		return missingMetrics(at, readStatus(err), "Pod cgroup is unavailable"), podSample{}
	}
	clockAt := at
	if c.options.Now != nil {
		clockAt = c.options.Now()
	}
	sample := podSample{at: at, clockAt: clockAt, info: info}
	previous := c.previous[scope]
	elapsed := clockAt.Sub(previous.clockAt).Seconds()
	continuous := previous.info != nil && os.SameFile(info, previous.info) && elapsed > 0 && elapsed <= 3*SamplingInterval.Seconds()
	if data, err := readBounded(root, filepath.Join(path, "cpu.stat"), 64<<10); err == nil {
		if value, ok := counterValue(string(data), "usage_usec"); ok {
			sample.cpu = value
			sample.cpuOK = true
			if continuous && previous.cpuOK && value >= previous.cpu {
				metrics["cpu_cores"] = model.AvailableMetric(float64(value-previous.cpu)/(elapsed*1e6), "cores", model.SourceCgroupFS, model.ScopeWorkloadOwner, at)
			}
		} else {
			metrics["cpu_cores"] = unavailableMetric("cpu_cores", at, model.StatusError, "CPU accounting is invalid")
		}
	} else {
		metrics["cpu_cores"] = unavailableMetric("cpu_cores", at, readStatus(err), "CPU accounting is unavailable")
	}
	if data, err := readBounded(root, filepath.Join(path, "memory.current"), 128); err == nil {
		if value, err := strconv.ParseUint(strings.TrimSpace(string(data)), 10, 64); err == nil && value <= 1<<53 {
			metrics["memory_used_bytes"] = model.AvailableMetric(float64(value), "bytes", model.SourceCgroupFS, model.ScopeWorkloadOwner, at)
		} else {
			metrics["memory_used_bytes"] = unavailableMetric("memory_used_bytes", at, model.StatusError, "Memory accounting is invalid")
		}
	} else {
		metrics["memory_used_bytes"] = unavailableMetric("memory_used_bytes", at, readStatus(err), "Memory accounting is unavailable")
	}
	data, err := readBounded(root, filepath.Join(path, "io.stat"), 512<<10)
	if err == nil {
		sample.ioCounters = map[string]ioCounter{}
		sample.read, sample.write, sample.devices, err = readIO(data, c.options.SysfsRoot, sample.ioCounters)
	}
	if err != nil {
		for _, name := range []string{"storage_read_bps", "storage_write_bps"} {
			metrics[name] = unavailableMetric(name, at, readStatus(err), "Partial: storage accounting or backing-device mapping is unavailable")
		}
	} else {
		sample.ioOK = true
		countersContinuous := len(sample.ioCounters) == len(previous.ioCounters)
		for id, counter := range sample.ioCounters {
			prior, exists := previous.ioCounters[id]
			if !exists || counter.read < prior.read || counter.write < prior.write {
				countersContinuous = false
			}
		}
		if continuous && previous.ioOK && countersContinuous && sample.devices == previous.devices && sample.read >= previous.read && sample.write >= previous.write {
			metrics["storage_read_bps"] = model.AvailableMetric(float64(sample.read-previous.read)/elapsed, "B/s", model.SourceCgroupFS, model.ScopeWorkloadOwner, at)
			metrics["storage_write_bps"] = model.AvailableMetric(float64(sample.write-previous.write)/elapsed, "B/s", model.SourceCgroupFS, model.ScopeWorkloadOwner, at)
		}
	}
	return metrics, sample
}

func unavailableMetric(name string, at time.Time, status model.MetricStatus, message string) model.Metric {
	return model.UnavailableMetric(metricUnits[name], model.SourceCgroupFS, model.ScopeWorkloadOwner, at, status, message)
}
func readStatus(err error) model.MetricStatus {
	if errors.Is(err, fs.ErrPermission) {
		return model.StatusPermissionDenied
	}
	if errors.Is(err, fs.ErrNotExist) {
		return model.StatusUnsupported
	}
	return model.StatusError
}
func counterValue(data, key string) (uint64, bool) {
	var value uint64
	found := false
	for line := range strings.Lines(data) {
		fields := strings.Fields(line)
		if len(fields) > 0 && fields[0] == key {
			if len(fields) != 2 || found {
				return 0, false
			}
			parsed, err := strconv.ParseUint(fields[1], 10, 64)
			if err != nil {
				return 0, false
			}
			value = parsed
			found = true
		}
	}
	return value, found
}
func readBounded(root *os.Root, path string, limit int64) ([]byte, error) {
	file, err := root.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("expected a regular accounting file")
	}
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, errors.New("accounting file exceeds limit")
	}
	return data, nil
}

var podDirectory = regexp.MustCompile(`pod([[:xdigit:]]{8}[-_][[:xdigit:]]{4}[-_][[:xdigit:]]{4}[-_][[:xdigit:]]{4}[-_][[:xdigit:]]{12})(?:\.slice)?$`)

func discoverPods(ctx context.Context, root string) (map[string]string, error) {
	paths := map[string]string{}
	visited := 0
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if err = ctx.Err(); err != nil {
			return err
		}
		visited++
		if visited > 32768 {
			return errors.New("cgroup discovery exceeds bound")
		}
		if !entry.IsDir() {
			return nil
		}
		match := podDirectory.FindStringSubmatch(entry.Name())
		if match == nil {
			return nil
		}
		scope, ok := attribution.ScopeRefForPodUID(match[1])
		if !ok {
			return filepath.SkipDir
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		if _, duplicate := paths[scope]; duplicate {
			paths[scope] = ""
		} else {
			paths[scope] = relative
		}
		return filepath.SkipDir
	})
	return paths, err
}

func sortedKeys[T any](values map[string]T) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
