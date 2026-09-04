// Package system collects provider-independent Linux host telemetry.
package system

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/sys/unix"

	"github.com/intellisys-stevens/leviathan/internal/model"
)

const (
	defaultDiscoveryInterval  = 10 * time.Second
	defaultMaximumFilesystems = 256
	diskSectorBytes           = uint64(512)
)

// Sampler is the provider-independent host telemetry boundary used by the
// collector. Implementations must not retain or expose device paths.
type Sampler interface {
	Sample(context.Context, time.Time) (model.System, []model.Diagnostic, error)
}

type StatfsFunc func(string, *unix.Statfs_t) error

type Options struct {
	ProcRoot           string
	MountInfoPath      string
	DiscoveryInterval  time.Duration
	MaximumFilesystems int
	Statfs             StatfsFunc
}

type counterSample struct {
	total uint64
	idle  uint64
	at    time.Time
}

type diskSample struct {
	counters map[string]deviceCounters
	devices  string
	at       time.Time
}

type deviceCounters struct {
	readBytes  uint64
	writeBytes uint64
}

type mount struct {
	majorMinor string
	mountPoint string
	fsType     string
}

// ProcSampler reads Linux procfs and statfs. Parsing is intentionally kept
// independent of GOOS so fixture tests can run on development machines.
type ProcSampler struct {
	options Options

	mu           sync.Mutex
	previousCPU  *counterSample
	previousDisk *diskSample
	logicalCPUs  int
	mounts       []mount
	mountsAt     time.Time
}

func New(options Options) *ProcSampler {
	if options.ProcRoot == "" {
		options.ProcRoot = "/proc"
	}
	if options.MountInfoPath == "" {
		options.MountInfoPath = filepath.Join(options.ProcRoot, "self", "mountinfo")
	}
	if options.DiscoveryInterval <= 0 {
		options.DiscoveryInterval = defaultDiscoveryInterval
	}
	if options.MaximumFilesystems <= 0 {
		options.MaximumFilesystems = defaultMaximumFilesystems
	}
	if options.Statfs == nil {
		options.Statfs = unix.Statfs
	}
	return &ProcSampler{options: options}
}

func Default() *ProcSampler { return New(Options{}) }

func (s *ProcSampler) Sample(ctx context.Context, at time.Time) (model.System, []model.Diagnostic, error) {
	at = at.UTC()
	if err := ctx.Err(); err != nil {
		return model.System{}, nil, err
	}

	cpu, cpuErr := s.sampleCPU(at)
	if err := ctx.Err(); err != nil {
		return model.System{}, nil, err
	}
	memory, memoryErr := s.sampleMemory(at)
	if err := ctx.Err(); err != nil {
		return model.System{}, nil, err
	}
	storage, storageErr := s.sampleStorage(at)

	diagnostics := make([]model.Diagnostic, 0, 3)
	components := []struct {
		name    string
		status  model.MetricStatus
		message string
		err     error
	}{
		{name: "cpu", status: cpu.Status, message: cpu.Message, err: cpuErr},
		{name: "memory", status: memory.Status, message: memory.Message, err: memoryErr},
		{name: "storage", status: storage.Status, message: storage.Message, err: storageErr},
	}
	available := 0
	messages := make([]string, 0, len(components))
	for _, component := range components {
		if component.err == nil {
			available++
			if component.status == model.StatusStale {
				detail := component.message
				if detail == "" {
					detail = component.name + " telemetry is partially unavailable"
				}
				messages = append(messages, component.name+": "+detail)
				diagnostics = append(diagnostics, model.Diagnostic{
					Code: "system_" + component.name + "_partial", Severity: "warning", Component: "system",
					Summary: "Host " + component.name + " telemetry is partially unavailable", Detail: detail,
					Remedy: "verify that procfs and the service mount namespace are readable", Status: model.StatusStale,
				})
			}
			continue
		}
		messages = append(messages, component.name+": "+component.err.Error())
		diagnostics = append(diagnostics, model.Diagnostic{
			Code: "system_" + component.name, Severity: "warning", Component: "system",
			Summary: "Host " + component.name + " telemetry is unavailable", Detail: component.err.Error(),
			Remedy: "verify that procfs and the service mount namespace are readable", Status: statusForError(component.err),
		})
	}

	result := model.System{CPU: cpu, Memory: memory, Storage: storage, SampledAt: at}
	if available == 0 {
		result.Status = model.StatusError
		result.Message = strings.Join(messages, "; ")
		return result, diagnostics, errors.New(result.Message)
	}
	result.Status = model.StatusAvailable
	if memory.Status == model.StatusEstimated {
		result.Status = model.StatusEstimated
	}
	if available != len(components) || len(messages) > 0 {
		result.Status = model.StatusStale
		result.Message = strings.Join(messages, "; ")
	}
	return result, diagnostics, nil
}

func (s *ProcSampler) sampleCPU(at time.Time) (model.CPU, error) {
	result := model.CPU{Source: model.SourceProcFS, SampledAt: at, Status: model.StatusError}
	stat, err := os.ReadFile(filepath.Join(s.options.ProcRoot, "stat"))
	if err != nil {
		result.Message = err.Error()
		result.Utilization = unavailable("percent", at, statusForError(err), "cannot read aggregate CPU counters")
		result.Load1, result.Load5, result.Load15 = unavailableLoads(at, statusForError(err), "cannot read aggregate CPU counters")
		return result, err
	}
	total, idle, logical, err := parseCPUStat(string(stat))
	if err != nil {
		result.Message = err.Error()
		result.Utilization = unavailable("percent", at, model.StatusError, err.Error())
		result.Load1, result.Load5, result.Load15 = unavailableLoads(at, model.StatusError, err.Error())
		return result, err
	}

	if info, readErr := os.ReadFile(filepath.Join(s.options.ProcRoot, "cpuinfo")); readErr == nil {
		result.Model, result.LogicalProcessors = parseCPUInfo(string(info))
	}
	if result.LogicalProcessors == 0 {
		result.LogicalProcessors = logical
	}
	if result.LogicalProcessors == 0 {
		result.LogicalProcessors = runtime.NumCPU()
	}

	load, loadErr := os.ReadFile(filepath.Join(s.options.ProcRoot, "loadavg"))
	if loadErr != nil {
		result.Load1, result.Load5, result.Load15 = unavailableLoads(at, statusForError(loadErr), "cannot read load averages")
	} else if values, parseErr := parseLoadAverage(string(load)); parseErr != nil {
		loadErr = parseErr
		result.Load1, result.Load5, result.Load15 = unavailableLoads(at, model.StatusError, parseErr.Error())
	} else {
		result.Load1 = model.AvailableMetric(values[0], "load", model.SourceProcFS, model.ScopeHost, at)
		result.Load5 = model.AvailableMetric(values[1], "load", model.SourceProcFS, model.ScopeHost, at)
		result.Load15 = model.AvailableMetric(values[2], "load", model.SourceProcFS, model.ScopeHost, at)
	}

	s.mu.Lock()
	previous := s.previousCPU
	previousLogical := s.logicalCPUs
	if previous == nil || at.After(previous.at) {
		s.previousCPU = &counterSample{total: total, idle: idle, at: at}
		s.logicalCPUs = result.LogicalProcessors
	}
	s.mu.Unlock()
	result.Utilization = unavailable("percent", at, model.StatusStale, "waiting for a second CPU counter sample")
	if previous != nil && previousLogical != result.LogicalProcessors {
		result.Utilization.Message = "logical CPU topology changed; waiting for a new baseline"
	} else if previous != nil && !at.After(previous.at) {
		result.Utilization.Message = "CPU sample time did not advance; waiting for a valid interval"
	} else if previous != nil && (total < previous.total || idle < previous.idle) {
		result.Utilization.Message = "CPU counters reset; waiting for a new baseline"
	} else if previous != nil {
		deltaTotal, deltaIdle := total-previous.total, idle-previous.idle
		if deltaTotal > 0 && deltaIdle <= deltaTotal {
			utilization := 100 * float64(deltaTotal-deltaIdle) / float64(deltaTotal)
			result.Utilization = model.AvailableMetric(math.Max(0, math.Min(100, utilization)), "percent", model.SourceProcFS, model.ScopeHost, at)
		} else {
			result.Utilization.Message = "CPU counters did not advance; waiting for a new baseline"
		}
	}

	result.Status = model.StatusAvailable
	if loadErr != nil {
		result.Status = model.StatusStale
		result.Message = loadErr.Error()
	}
	return result, nil
}

func unavailableLoads(at time.Time, status model.MetricStatus, message string) (model.Metric, model.Metric, model.Metric) {
	return unavailable("load", at, status, message), unavailable("load", at, status, message), unavailable("load", at, status, message)
}

func unavailable(unit string, at time.Time, status model.MetricStatus, message string) model.Metric {
	return model.UnavailableMetric(unit, model.SourceProcFS, model.ScopeHost, at, status, message)
}

func parseCPUStat(data string) (total, idle uint64, logical int, err error) {
	scanner := bufio.NewScanner(strings.NewReader(data))
	found := false
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) == 0 {
			continue
		}
		if fields[0] == "cpu" {
			if len(fields) < 5 {
				return 0, 0, 0, errors.New("aggregate CPU row has too few counters")
			}
			limit := len(fields)
			if limit > 9 {
				limit = 9 // user through steal; guest counters are already included in user/nice.
			}
			values := make([]uint64, limit-1)
			for index := 1; index < limit; index++ {
				value, parseErr := strconv.ParseUint(fields[index], 10, 64)
				if parseErr != nil {
					return 0, 0, 0, fmt.Errorf("parse CPU counter %q: %w", fields[index], parseErr)
				}
				values[index-1] = value
				total += value
			}
			idle = values[3]
			if len(values) > 4 {
				idle += values[4]
			}
			found = true
			continue
		}
		if strings.HasPrefix(fields[0], "cpu") && len(fields[0]) > 3 {
			if _, parseErr := strconv.Atoi(fields[0][3:]); parseErr == nil {
				logical++
			}
		}
	}
	if scanErr := scanner.Err(); scanErr != nil {
		return 0, 0, 0, scanErr
	}
	if !found {
		return 0, 0, 0, errors.New("aggregate CPU row is missing")
	}
	return total, idle, logical, nil
}

func parseCPUInfo(data string) (string, int) {
	modelName := ""
	logical := 0
	for _, line := range strings.Split(data, "\n") {
		key, value, found := strings.Cut(line, ":")
		if !found {
			continue
		}
		switch strings.TrimSpace(key) {
		case "processor":
			logical++
		case "model name", "Hardware", "Processor":
			if modelName == "" {
				modelName = strings.TrimSpace(value)
			}
		}
	}
	return modelName, logical
}

func parseLoadAverage(data string) ([3]float64, error) {
	var result [3]float64
	fields := strings.Fields(data)
	if len(fields) < 3 {
		return result, errors.New("loadavg has too few fields")
	}
	for index := range result {
		value, err := strconv.ParseFloat(fields[index], 64)
		if err != nil {
			return result, fmt.Errorf("parse load average %q: %w", fields[index], err)
		}
		result[index] = value
	}
	return result, nil
}

func (s *ProcSampler) sampleMemory(at time.Time) (model.SystemMemory, error) {
	result := model.SystemMemory{
		Source: model.SourceProcFS, Scope: model.ScopeHost, SampledAt: at, Status: model.StatusError,
		Utilization: unavailable("percent", at, model.StatusError, "memory capacity is unavailable"),
	}
	data, err := os.ReadFile(filepath.Join(s.options.ProcRoot, "meminfo"))
	if err != nil {
		result.Message = err.Error()
		return result, err
	}
	values, err := parseMemInfo(string(data))
	if err != nil {
		result.Message = err.Error()
		return result, err
	}
	total := values["MemTotal"]
	available, exact := values["MemAvailable"]
	if !exact {
		available = saturatingAdd(values["MemFree"], values["Buffers"], values["Cached"], values["SReclaimable"])
		if shmem := values["Shmem"]; shmem < available {
			available -= shmem
		} else {
			available = 0
		}
	}
	if available > total {
		available = total
	}
	used := total - available
	result.TotalBytes, result.AvailableBytes, result.UsedBytes = model.Uint64(total), model.Uint64(available), model.Uint64(used)
	result.Utilization = model.AvailableMetric(100*float64(used)/float64(total), "percent", model.SourceProcFS, model.ScopeHost, at)
	result.Status = model.StatusAvailable
	if !exact {
		result.Status = model.StatusEstimated
		result.Message = "MemAvailable is absent; estimated from free, buffers, cache, and reclaimable slab"
		result.Utilization.Status = model.StatusEstimated
		result.Utilization.Message = result.Message
	}
	return result, nil
}

func parseMemInfo(data string) (map[string]uint64, error) {
	values := make(map[string]uint64)
	scanner := bufio.NewScanner(strings.NewReader(data))
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 2 {
			continue
		}
		key := strings.TrimSuffix(fields[0], ":")
		value, err := strconv.ParseUint(fields[1], 10, 64)
		if err != nil {
			continue
		}
		if len(fields) >= 3 && fields[2] == "kB" {
			if value > math.MaxUint64/1024 {
				value = math.MaxUint64
			} else {
				value *= 1024
			}
		}
		values[key] = value
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	if values["MemTotal"] == 0 {
		return nil, errors.New("MemTotal is missing or zero")
	}
	return values, nil
}

func (s *ProcSampler) sampleStorage(at time.Time) (model.Storage, error) {
	result := model.Storage{
		Source: model.SourceStatFS, Scope: model.ScopeHost, SampledAt: at, Status: model.StatusError,
		Filesystems:         []model.Filesystem{},
		ReadBytesPerSecond:  unavailable("bytes_per_second", at, model.StatusStale, "waiting for a second disk counter sample"),
		WriteBytesPerSecond: unavailable("bytes_per_second", at, model.StatusStale, "waiting for a second disk counter sample"),
	}
	mounts, discoveryErr := s.discoverMounts(at)
	if discoveryErr != nil && len(mounts) == 0 {
		result.Message = discoveryErr.Error()
		return result, discoveryErr
	}

	var total, used, available uint64
	availableCount := 0
	for _, mounted := range mounts {
		filesystem := model.Filesystem{
			ID: filesystemID(mounted.majorMinor, mounted.fsType), MountPoint: mounted.mountPoint, FSType: mounted.fsType,
			Source: model.SourceStatFS, Scope: model.ScopeHost, SampledAt: at, Status: model.StatusError,
		}
		var stat unix.Statfs_t
		if err := s.options.Statfs(mounted.mountPoint, &stat); err != nil {
			filesystem.Status, filesystem.Message = statusForError(err), err.Error()
			result.Filesystems = append(result.Filesystems, filesystem)
			continue
		}
		blockSize := uint64(stat.Bsize)
		fsTotal := saturatingMultiply(uint64(stat.Blocks), blockSize)
		fsFree := saturatingMultiply(uint64(stat.Bfree), blockSize)
		fsAvailable := saturatingMultiply(uint64(stat.Bavail), blockSize)
		fsUsed := uint64(0)
		if fsFree < fsTotal {
			fsUsed = fsTotal - fsFree
		}
		filesystem.TotalBytes, filesystem.UsedBytes, filesystem.AvailableBytes = model.Uint64(fsTotal), model.Uint64(fsUsed), model.Uint64(fsAvailable)
		filesystem.Status = model.StatusAvailable
		result.Filesystems = append(result.Filesystems, filesystem)
		total, used, available = saturatingAdd(total, fsTotal), saturatingAdd(used, fsUsed), saturatingAdd(available, fsAvailable)
		availableCount++
	}
	if availableCount == 0 {
		result.Message = "no persistent local filesystem capacity is readable"
		return result, errors.New(result.Message)
	}
	result.TotalBytes, result.UsedBytes, result.AvailableBytes = model.Uint64(total), model.Uint64(used), model.Uint64(available)
	result.Status = model.StatusAvailable
	if discoveryErr != nil {
		result.Status = model.StatusStale
		result.Message = "mount discovery failed; retained the previous topology: " + discoveryErr.Error()
	}
	if availableCount != len(mounts) {
		result.Status = model.StatusStale
		result.Message = appendMessage(result.Message, fmt.Sprintf("capacity unavailable for %d of %d persistent local filesystems", len(mounts)-availableCount, len(mounts)))
	}

	devices := make(map[string]struct{}, len(mounts))
	for _, mounted := range mounts {
		devices[mounted.majorMinor] = struct{}{}
	}
	counters, deviceSignature, diskErr := readDiskCounters(filepath.Join(s.options.ProcRoot, "diskstats"), devices)
	if diskErr != nil {
		status := statusForError(diskErr)
		result.ReadBytesPerSecond = unavailable("bytes_per_second", at, status, diskErr.Error())
		result.WriteBytesPerSecond = unavailable("bytes_per_second", at, status, diskErr.Error())
		result.Status = model.StatusStale
		result.Message = appendMessage(result.Message, "aggregate disk throughput unavailable: "+diskErr.Error())
		return result, nil
	}
	s.mu.Lock()
	previous := s.previousDisk
	if previous == nil || at.After(previous.at) {
		s.previousDisk = &diskSample{counters: counters, devices: deviceSignature, at: at}
	}
	s.mu.Unlock()
	if previous != nil && previous.devices == deviceSignature && at.After(previous.at) && !diskCountersReset(previous.counters, counters) {
		seconds := at.Sub(previous.at).Seconds()
		if seconds > 0 {
			readDelta, writeDelta := diskCounterDeltas(previous.counters, counters)
			result.ReadBytesPerSecond = model.AvailableMetric(float64(readDelta)/seconds, "bytes_per_second", model.SourceProcFS, model.ScopeHost, at)
			result.WriteBytesPerSecond = model.AvailableMetric(float64(writeDelta)/seconds, "bytes_per_second", model.SourceProcFS, model.ScopeHost, at)
		}
	} else if previous != nil && previous.devices != deviceSignature {
		result.ReadBytesPerSecond.Message = "mounted block-device topology changed; waiting for a new baseline"
		result.WriteBytesPerSecond.Message = result.ReadBytesPerSecond.Message
	} else if previous != nil && !at.After(previous.at) {
		result.ReadBytesPerSecond.Message = "disk sample time did not advance; waiting for a valid interval"
		result.WriteBytesPerSecond.Message = result.ReadBytesPerSecond.Message
	} else if previous != nil {
		result.ReadBytesPerSecond.Message = "disk counters reset; waiting for a new baseline"
		result.WriteBytesPerSecond.Message = result.ReadBytesPerSecond.Message
	}
	return result, nil
}

func appendMessage(current, next string) string {
	if current == "" {
		return next
	}
	return current + "; " + next
}

func (s *ProcSampler) discoverMounts(at time.Time) ([]mount, error) {
	s.mu.Lock()
	cached := append([]mount(nil), s.mounts...)
	cachedAt := s.mountsAt
	s.mu.Unlock()
	if len(cached) > 0 && at.Sub(cachedAt) < s.options.DiscoveryInterval {
		return cached, nil
	}
	data, err := os.ReadFile(s.options.MountInfoPath)
	if err != nil {
		return cached, err
	}
	mounts, err := parseMountInfo(string(data), s.options.MaximumFilesystems)
	if err != nil {
		return cached, err
	}
	s.mu.Lock()
	s.mounts = append([]mount(nil), mounts...)
	s.mountsAt = at
	s.mu.Unlock()
	return mounts, nil
}

func parseMountInfo(data string, maximum int) ([]mount, error) {
	byDevice := make(map[string]mount)
	scanner := bufio.NewScanner(strings.NewReader(data))
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		separator := -1
		for index, field := range fields {
			if field == "-" {
				separator = index
				break
			}
		}
		if separator < 6 || separator+2 >= len(fields) {
			continue
		}
		fsType := fields[separator+1]
		if excludedFilesystem(fsType) {
			continue
		}
		majorMinor := fields[2]
		if _, _, ok := strings.Cut(majorMinor, ":"); !ok {
			continue
		}
		mountPoint := filepath.Clean(decodeMountInfo(fields[4]))
		if !filepath.IsAbs(mountPoint) {
			continue
		}
		candidate := mount{majorMinor: majorMinor, mountPoint: mountPoint, fsType: fsType}
		current, exists := byDevice[majorMinor]
		if !exists || preferredMount(candidate.mountPoint, current.mountPoint) {
			byDevice[majorMinor] = candidate
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	result := make([]mount, 0, len(byDevice))
	for _, mounted := range byDevice {
		result = append(result, mounted)
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].mountPoint == result[j].mountPoint {
			return result[i].majorMinor < result[j].majorMinor
		}
		return result[i].mountPoint < result[j].mountPoint
	})
	if maximum > 0 && len(result) > maximum {
		result = result[:maximum]
	}
	return result, nil
}

func preferredMount(candidate, current string) bool {
	if candidate == "/" {
		return current != "/"
	}
	if current == "/" {
		return false
	}
	candidateDepth := strings.Count(candidate, string(filepath.Separator))
	currentDepth := strings.Count(current, string(filepath.Separator))
	return candidateDepth < currentDepth || (candidateDepth == currentDepth && candidate < current)
}

func decodeMountInfo(value string) string {
	var builder strings.Builder
	for index := 0; index < len(value); index++ {
		if value[index] == '\\' && index+3 < len(value) {
			decoded, err := strconv.ParseUint(value[index+1:index+4], 8, 8)
			if err == nil {
				builder.WriteByte(byte(decoded))
				index += 3
				continue
			}
		}
		builder.WriteByte(value[index])
	}
	return builder.String()
}

func excludedFilesystem(fsType string) bool {
	if strings.HasPrefix(fsType, "fuse.") {
		return true
	}
	_, excluded := excludedFilesystems[fsType]
	return excluded
}

var excludedFilesystems = map[string]struct{}{
	"9p": {}, "afs": {}, "aufs": {}, "autofs": {}, "binfmt_misc": {}, "bpf": {}, "ceph": {},
	"cgroup": {}, "cgroup2": {}, "cifs": {}, "coda": {}, "configfs": {}, "davfs": {}, "davfs2": {},
	"debugfs": {}, "devpts": {}, "devtmpfs": {}, "efivarfs": {}, "fuse": {}, "fusectl": {},
	"gfs2": {}, "glusterfs": {}, "hostfs": {}, "hugetlbfs": {}, "lustre": {}, "mqueue": {},
	"nfs": {}, "nfs4": {}, "nsfs": {}, "ocfs2": {}, "overlay": {}, "panfs": {}, "proc": {},
	"pstore": {}, "ramfs": {}, "rootfs": {}, "rpc_pipefs": {}, "securityfs": {}, "selinuxfs": {},
	"smb3": {}, "squashfs": {}, "sshfs": {}, "sysfs": {}, "tmpfs": {}, "tracefs": {}, "virtiofs": {},
}

func filesystemID(majorMinor, fsType string) string {
	digest := sha256.Sum256([]byte(majorMinor + "\x00" + fsType))
	return "fs_" + base64.RawURLEncoding.EncodeToString(digest[:12])
}

func readDiskCounters(path string, selected map[string]struct{}) (map[string]deviceCounters, string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, "", err
	}
	keys := make([]string, 0, len(selected))
	for key := range selected {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	found := make(map[string]bool, len(selected))
	counters := make(map[string]deviceCounters, len(selected))
	scanner := bufio.NewScanner(strings.NewReader(string(data)))
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 10 {
			continue
		}
		key := fields[0] + ":" + fields[1]
		if _, ok := selected[key]; !ok || found[key] {
			continue
		}
		readSectors, readErr := strconv.ParseUint(fields[5], 10, 64)
		writeSectors, writeErr := strconv.ParseUint(fields[9], 10, 64)
		if readErr != nil || writeErr != nil {
			continue
		}
		counters[key] = deviceCounters{
			readBytes:  saturatingMultiply(readSectors, diskSectorBytes),
			writeBytes: saturatingMultiply(writeSectors, diskSectorBytes),
		}
		found[key] = true
	}
	if err := scanner.Err(); err != nil {
		return nil, "", err
	}
	if len(found) != len(selected) {
		return nil, "", fmt.Errorf("disk counters are unavailable for %d of %d persistent local filesystems", len(selected)-len(found), len(selected))
	}
	active := make([]string, 0, len(found))
	for _, key := range keys {
		if found[key] {
			active = append(active, key)
		}
	}
	return counters, strings.Join(active, ","), nil
}

func diskCountersReset(previous, current map[string]deviceCounters) bool {
	for device, counters := range current {
		prior, ok := previous[device]
		if !ok || counters.readBytes < prior.readBytes || counters.writeBytes < prior.writeBytes {
			return true
		}
	}
	return false
}

func diskCounterDeltas(previous, current map[string]deviceCounters) (uint64, uint64) {
	var read, write uint64
	for device, counters := range current {
		prior := previous[device]
		read = saturatingAdd(read, counters.readBytes-prior.readBytes)
		write = saturatingAdd(write, counters.writeBytes-prior.writeBytes)
	}
	return read, write
}

func statusForError(err error) model.MetricStatus {
	if errors.Is(err, os.ErrPermission) {
		return model.StatusPermissionDenied
	}
	if errors.Is(err, os.ErrNotExist) {
		return model.StatusUnsupported
	}
	return model.StatusError
}

func saturatingAdd(values ...uint64) uint64 {
	var result uint64
	for _, value := range values {
		if math.MaxUint64-result < value {
			return math.MaxUint64
		}
		result += value
	}
	return result
}

func saturatingMultiply(left, right uint64) uint64 {
	if left != 0 && right > math.MaxUint64/left {
		return math.MaxUint64
	}
	return left * right
}
