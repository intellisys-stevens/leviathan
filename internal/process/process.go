// Package process collects process identity from the caller's current Linux
// PID namespace. It deliberately does not cross namespace or cgroup boundaries.
package process

import (
	"bufio"
	"errors"
	"fmt"
	"math"
	"os"
	"os/user"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/intellisys-stevens/leviathan/internal/attribution"
	"github.com/intellisys-stevens/leviathan/internal/model"
)

var podUIDInCgroup = regexp.MustCompile(`pod([[:xdigit:]]{8}[-_][[:xdigit:]]{4}[-_][[:xdigit:]]{4}[-_][[:xdigit:]]{4}[-_][[:xdigit:]]{12})`)

type Inventory struct {
	Processes   []model.Process
	Capability  model.ProviderState
	Diagnostics []model.Diagnostic
}

type Scanner struct {
	Root            string
	UVMPath         string
	SelfPID         uint32
	ShowCommandLine bool
	Attribution     bool

	mu        sync.Mutex
	userNames map[string]string
}

func NewScanner(showCommandLine bool) *Scanner {
	return NewScannerWithAttribution(showCommandLine, false)
}

func NewScannerWithAttribution(showCommandLine, attributionEnabled bool) *Scanner {
	return &Scanner{
		Root: "/proc", UVMPath: "/dev/nvidia-uvm", SelfPID: uint32(os.Getpid()),
		ShowCommandLine: showCommandLine, Attribution: attributionEnabled, userNames: make(map[string]string),
	}
}

func (s *Scanner) Scan() Inventory {
	root := s.Root
	if root == "" {
		root = "/proc"
	}
	uvmPath := s.UVMPath
	if uvmPath == "" {
		uvmPath = "/dev/nvidia-uvm"
	}
	uvm, err := readDeviceIdentity(uvmPath)
	if err != nil {
		status := statusFor(err)
		if errors.Is(err, os.ErrNotExist) {
			status = model.StatusUnsupported
		}
		return Inventory{
			Processes:  []model.Process{},
			Capability: model.ProviderState{Name: "/proc GPU clients (current PID namespace)", Available: false, Status: status, Message: err.Error()},
			Diagnostics: []model.Diagnostic{{
				Code: "gpu_process_detection", Severity: "warning", Component: uvmPath,
				Summary: "GPU-connected process detection is unavailable", Detail: err.Error(),
				Remedy: "expose the NVIDIA UVM device in the current workspace; no host PID namespace or MIG monitor capability is required", Status: status,
			}},
		}
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		status := statusFor(err)
		return Inventory{
			Processes:  []model.Process{},
			Capability: model.ProviderState{Name: "/proc GPU clients (current PID namespace)", Available: false, Status: status, Message: err.Error()},
			Diagnostics: []model.Diagnostic{{
				Code: "gpu_processes", Severity: "warning", Component: root,
				Summary: "GPU-connected process inventory is unavailable", Detail: err.Error(),
				Remedy: "make the current process namespace's /proc filesystem readable by Leviathan", Status: status,
			}},
		}
	}

	pids := make([]uint32, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		value, err := strconv.ParseUint(entry.Name(), 10, 32)
		if err == nil && value > 0 && value <= math.MaxUint32 {
			pids = append(pids, uint32(value))
		}
	}
	sort.Slice(pids, func(i, j int) bool { return pids[i] < pids[j] })

	boot, bootErr := readBootTime(root)
	processes := make([]model.Process, 0, len(pids))
	uninspectable := 0
	uninspectableStatus := model.StatusAvailable
	incomplete := 0
	incompleteStatus := model.StatusAvailable
	for _, pid := range pids {
		if pid == s.SelfPID {
			continue
		}
		connected, vanished, inspectErr := processHasDevice(root, pid, uvm)
		if vanished {
			continue
		}
		if inspectErr != nil {
			uninspectable++
			uninspectableStatus = worseStatus(uninspectableStatus, statusFor(inspectErr))
			continue
		}
		if !connected {
			continue
		}
		processRoot := filepath.Join(root, strconv.FormatUint(uint64(pid), 10))
		identityTicks, identityErr := processStartTicks(processRoot)
		resolved, vanished := s.resolve(root, pid, boot, bootErr)
		if vanished {
			continue
		}
		stillConnected, vanished, verifyErr := processHasDevice(root, pid, uvm)
		if vanished || verifyErr != nil || !stillConnected {
			continue
		}
		identityUnchanged, identityVerified := processIdentityUnchanged(processRoot, identityTicks, identityErr)
		if !identityUnchanged {
			// The PID was reused while this record was being resolved.
			continue
		}
		if !identityVerified {
			// Process telemetry remains useful, but an unverified PID identity
			// must not be joined to a workload.
			resolved.ScopeRef = ""
		}
		if resolved.Status != model.StatusAvailable {
			incomplete++
			incompleteStatus = worseStatus(incompleteStatus, resolved.Status)
		}
		processes = append(processes, resolved)
	}

	message := fmt.Sprintf("%d GPU-connected process(es) visible in the current PID namespace", len(processes))
	if uninspectable > 0 {
		message += fmt.Sprintf("; %d process(es) could not be inspected", uninspectable)
	}
	diagnostics := []model.Diagnostic{}
	if uninspectable > 0 {
		remedy := "run Leviathan in the workload's PID namespace as the same user; a host-level service cannot inspect other users' processes without broader /proc privileges"
		diagnostics = append(diagnostics, model.Diagnostic{
			Code: "gpu_process_fds", Severity: "warning", Component: root,
			Summary: fmt.Sprintf("%d process(es) could not be checked for GPU device access", uninspectable),
			Detail:  "Leviathan only identifies GPU-connected processes by inspecting file-descriptor metadata in the current PID namespace.",
			Remedy:  remedy, Status: uninspectableStatus,
		})
	}
	if incomplete > 0 {
		remedy := "processes can exit while a snapshot is collected; persistent errors should be checked against /proc mount permissions"
		if incompleteStatus == model.StatusPermissionDenied {
			remedy = "run Leviathan as the same workspace user when process identity fields must be readable"
		}
		diagnostics = append(diagnostics, model.Diagnostic{
			Code: "gpu_process_fields", Severity: "warning", Component: root,
			Summary: fmt.Sprintf("%d GPU process record(s) are incomplete", incomplete),
			Detail:  "Processes can exit or restrict individual /proc fields while a snapshot is collected.",
			Remedy:  remedy, Status: incompleteStatus,
		})
	}
	if bootErr != nil {
		diagnostics = append(diagnostics, model.Diagnostic{
			Code: "gpu_process_start_time", Severity: "warning", Component: filepath.Join(root, "stat"),
			Summary: "GPU process start times are unavailable", Detail: bootErr.Error(),
			Remedy: "make the current process namespace's /proc/stat readable by Leviathan", Status: statusFor(bootErr),
		})
	}
	return Inventory{
		Processes: processes,
		Capability: model.ProviderState{
			Name: "/proc GPU clients (current PID namespace)", Available: true, Status: model.StatusAvailable, Message: message,
		},
		Diagnostics: diagnostics,
	}
}

type deviceIdentity struct {
	mode os.FileMode
	rdev uint64
	dev  uint64
	ino  uint64
}

func readDeviceIdentity(path string) (deviceIdentity, error) {
	info, err := os.Stat(path)
	if err != nil {
		return deviceIdentity{}, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return deviceIdentity{}, fmt.Errorf("%s has no Linux device identity", path)
	}
	return deviceIdentity{mode: info.Mode(), rdev: uint64(stat.Rdev), dev: uint64(stat.Dev), ino: stat.Ino}, nil
}

func sameDevice(info os.FileInfo, expected deviceIdentity) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return false
	}
	if expected.mode&os.ModeCharDevice != 0 {
		return info.Mode()&os.ModeCharDevice != 0 && uint64(stat.Rdev) == expected.rdev
	}
	// The regular-file branch makes the detector testable without mknod while
	// production always compares the character-device major/minor identity.
	return uint64(stat.Dev) == expected.dev && stat.Ino == expected.ino
}

func processHasDevice(root string, pid uint32, expected deviceIdentity) (connected bool, vanished bool, err error) {
	base := filepath.Join(root, strconv.FormatUint(uint64(pid), 10))
	fdRoot := filepath.Join(base, "fd")
	entries, err := os.ReadDir(fdRoot)
	if err != nil {
		if _, statErr := os.Stat(base); errors.Is(statErr, os.ErrNotExist) {
			return false, true, nil
		}
		return false, false, fmt.Errorf("PID %d file descriptors: %w", pid, err)
	}
	for _, entry := range entries {
		info, statErr := os.Stat(filepath.Join(fdRoot, entry.Name()))
		if statErr != nil {
			// File descriptors can close between directory enumeration and stat.
			continue
		}
		if sameDevice(info, expected) {
			return true, false, nil
		}
	}
	if _, statErr := os.Stat(base); errors.Is(statErr, os.ErrNotExist) {
		return false, true, nil
	}
	return false, false, nil
}

func (s *Scanner) resolve(root string, pid uint32, boot time.Time, bootErr error) (model.Process, bool) {
	base := filepath.Join(root, strconv.FormatUint(uint64(pid), 10))
	result := model.Process{PID: pid, Status: model.StatusAvailable}
	fieldErrors := []error{}

	executable, exeErr := os.Readlink(filepath.Join(base, "exe"))
	if exeErr == nil {
		result.Executable = executable
	} else {
		comm, commErr := os.ReadFile(filepath.Join(base, "comm"))
		if commErr == nil {
			result.Executable = strings.TrimSpace(string(comm))
			fieldErrors = append(fieldErrors, fmt.Errorf("executable path: %w", exeErr))
		} else {
			fieldErrors = append(fieldErrors, fmt.Errorf("executable: %w", errors.Join(exeErr, commErr)))
		}
	}

	status, statusErr := os.ReadFile(filepath.Join(base, "status"))
	if statusErr == nil {
		uid := uidFromStatus(string(status))
		if uid == "" {
			fieldErrors = append(fieldErrors, errors.New("user: Uid is absent from status"))
		} else {
			result.User = s.userName(uid)
		}
	} else {
		fieldErrors = append(fieldErrors, fmt.Errorf("user: %w", statusErr))
	}

	if bootErr == nil {
		started, err := processStartTime(base, boot)
		if err == nil {
			result.StartTime = &started
		} else {
			fieldErrors = append(fieldErrors, fmt.Errorf("start time: %w", err))
		}
	}

	if s.ShowCommandLine {
		data, err := os.ReadFile(filepath.Join(base, "cmdline"))
		if err == nil {
			parts := strings.Split(strings.TrimRight(string(data), "\x00"), "\x00")
			result.CommandLine = strings.Join(parts, " ")
		} else {
			fieldErrors = append(fieldErrors, fmt.Errorf("command line: %w", err))
		}
	}
	if s.Attribution {
		if data, err := os.ReadFile(filepath.Join(base, "cgroup")); err == nil {
			result.ScopeRef, _ = scopeRefFromCgroup(string(data))
		}
	}

	if len(fieldErrors) == 0 {
		return result, false
	}
	if _, err := os.Stat(base); errors.Is(err, os.ErrNotExist) {
		return model.Process{}, true
	}
	joined := errors.Join(fieldErrors...)
	result.Status = statusFor(joined)
	result.Message = joined.Error()
	return result, false
}

func scopeRefFromCgroup(data string) (string, bool) {
	resolved := ""
	for _, line := range strings.Split(data, "\n") {
		fields := strings.SplitN(line, ":", 3)
		if len(fields) != 3 {
			continue
		}
		path := fields[2]
		for _, match := range podUIDInCgroup.FindAllStringSubmatchIndex(path, -1) {
			if len(match) != 4 || (match[0] > 0 && !cgroupPathBoundary(path[match[0]-1])) || (match[1] < len(path) && !cgroupPathBoundary(path[match[1]])) {
				continue
			}
			scopeRef, ok := attribution.ScopeRefForPodUID(path[match[2]:match[3]])
			if !ok {
				continue
			}
			if resolved != "" && resolved != scopeRef {
				return "", false
			}
			resolved = scopeRef
		}
	}
	return resolved, resolved != ""
}

func cgroupPathBoundary(character byte) bool {
	return character == '/' || character == '_' || character == '.' || character == '-'
}

func uidFromStatus(data string) string {
	for _, line := range strings.Split(data, "\n") {
		if strings.HasPrefix(line, "Uid:") {
			fields := strings.Fields(line)
			if len(fields) > 1 {
				return fields[1]
			}
		}
	}
	return ""
}

func (s *Scanner) userName(uid string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if name, ok := s.userNames[uid]; ok {
		return name
	}
	name := uid
	if entry, err := user.LookupId(uid); err == nil && entry.Username != "" {
		name = entry.Username
	}
	s.userNames[uid] = name
	return name
}

func readBootTime(root string) (time.Time, error) {
	file, err := os.Open(filepath.Join(root, "stat"))
	if err != nil {
		return time.Time{}, err
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		if !strings.HasPrefix(scanner.Text(), "btime ") {
			continue
		}
		seconds, err := strconv.ParseInt(strings.TrimSpace(strings.TrimPrefix(scanner.Text(), "btime ")), 10, 64)
		if err != nil {
			return time.Time{}, err
		}
		return time.Unix(seconds, 0).UTC(), nil
	}
	if err := scanner.Err(); err != nil {
		return time.Time{}, err
	}
	return time.Time{}, errors.New("btime is absent from proc stat")
}

func processStartTime(processRoot string, boot time.Time) (time.Time, error) {
	ticks, err := processStartTicks(processRoot)
	if err != nil {
		return time.Time{}, err
	}
	// Linux exposes USER_HZ as 100 on the supported amd64 and arm64 targets.
	return boot.Add(time.Duration(ticks) * (time.Second / 100)).UTC(), nil
}

func processStartTicks(processRoot string) (uint64, error) {
	stat, err := os.ReadFile(filepath.Join(processRoot, "stat"))
	if err != nil {
		return 0, err
	}
	closeParen := strings.LastIndexByte(string(stat), ')')
	if closeParen < 0 {
		return 0, errors.New("malformed process stat")
	}
	fields := strings.Fields(string(stat)[closeParen+1:])
	// fields begins at process state (field 3); starttime is field 22.
	if len(fields) <= 19 {
		return 0, errors.New("malformed process stat")
	}
	ticks, err := strconv.ParseUint(fields[19], 10, 64)
	if err != nil {
		return 0, err
	}
	return ticks, nil
}

func processIdentityUnchanged(processRoot string, before uint64, beforeErr error) (unchanged, verified bool) {
	after, afterErr := processStartTicks(processRoot)
	if beforeErr != nil || afterErr != nil {
		return true, false
	}
	return before == after, true
}

func IdentityKey(process model.Process) string {
	if process.StartTime == nil {
		return strconv.FormatUint(uint64(process.PID), 10)
	}
	return fmt.Sprintf("%d:%d", process.PID, process.StartTime.UnixNano())
}

func statusFor(err error) model.MetricStatus {
	if errors.Is(err, os.ErrPermission) || strings.Contains(strings.ToLower(err.Error()), "permission denied") {
		return model.StatusPermissionDenied
	}
	if errors.Is(err, os.ErrNotExist) {
		return model.StatusStale
	}
	return model.StatusError
}

func worseStatus(current, candidate model.MetricStatus) model.MetricStatus {
	rank := map[model.MetricStatus]int{
		model.StatusAvailable: 0, model.StatusStale: 1, model.StatusUnsupported: 2,
		model.StatusPermissionDenied: 3, model.StatusError: 4,
	}
	if rank[candidate] > rank[current] {
		return candidate
	}
	return current
}
