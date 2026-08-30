package process

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/intellisys-stevens/miglens/internal/model"
)

func TestScannerEnumeratesSortedGPUProcesses(t *testing.T) {
	root := newProcRoot(t)
	writeProcess(t, root, 20, "/usr/bin/python3", "python3", "python3\x00train.py\x00", 200)
	writeProcess(t, root, 3, "/usr/bin/coder", "coder", "coder\x00agent\x00", 100)
	writeProcess(t, root, 11, "/usr/bin/bash", "bash", "", 150)
	if err := os.Mkdir(filepath.Join(root, "not-a-pid"), 0o755); err != nil {
		t.Fatal(err)
	}

	scanner, uvm := newGPUScanner(t, root, false)
	connectGPU(t, root, 20, uvm)
	connectGPU(t, root, 3, uvm)
	inventory := scanner.Scan()
	if !inventory.Capability.Available || len(inventory.Processes) != 2 {
		t.Fatalf("inventory = %+v", inventory)
	}
	if inventory.Processes[0].PID != 3 || inventory.Processes[1].PID != 20 {
		t.Fatalf("processes are not PID sorted: %+v", inventory.Processes)
	}
	if inventory.Processes[1].Executable != "/usr/bin/python3" || inventory.Processes[1].CommandLine != "" {
		t.Fatalf("redacted process = %+v", inventory.Processes[1])
	}

	withArguments, _ := newGPUScannerAt(t, root, uvm, true)
	processes := withArguments.Scan().Processes
	if processes[1].CommandLine != "python3 train.py" {
		t.Fatalf("command line = %q", processes[1].CommandLine)
	}
}

func TestScannerExcludesItself(t *testing.T) {
	root := newProcRoot(t)
	writeProcess(t, root, 3, "/usr/bin/miglens", "miglens", "", 100)
	writeProcess(t, root, 20, "/usr/bin/python3", "python3", "", 200)
	scanner, uvm := newGPUScanner(t, root, false)
	connectGPU(t, root, 3, uvm)
	connectGPU(t, root, 20, uvm)
	scanner.SelfPID = 3
	processes := scanner.Scan().Processes
	if len(processes) != 1 || processes[0].PID != 20 {
		t.Fatalf("self process was not excluded: %+v", processes)
	}
}

func TestScannerTreatsNoGPUClientsAsHealthy(t *testing.T) {
	root := newProcRoot(t)
	writeProcess(t, root, 7, "/usr/bin/coder", "coder", "", 100)
	scanner, _ := newGPUScanner(t, root, false)
	inventory := scanner.Scan()
	if !inventory.Capability.Available || inventory.Capability.Status != model.StatusAvailable || len(inventory.Processes) != 0 || len(inventory.Diagnostics) != 0 {
		t.Fatalf("empty GPU inventory = %+v", inventory)
	}
}

func TestScannerUsesCommWhenExecutableLinkIsUnavailable(t *testing.T) {
	root := newProcRoot(t)
	writeProcess(t, root, 7, "", "worker", "", 100)
	scanner, uvm := newGPUScanner(t, root, false)
	connectGPU(t, root, 7, uvm)
	processes := scanner.Scan().Processes
	if len(processes) != 1 || processes[0].Executable != "worker" {
		t.Fatalf("comm fallback = %+v", processes)
	}
	if processes[0].Status == model.StatusAvailable {
		t.Fatalf("fallback did not disclose the missing executable path: %+v", processes[0])
	}
}

func TestResolveSkipsProcessThatDisappeared(t *testing.T) {
	root := newProcRoot(t)
	base := filepath.Join(root, "9")
	if err := os.Mkdir(base, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(base); err != nil {
		t.Fatal(err)
	}
	scanner := NewScanner(false)
	if _, vanished := scanner.resolve(root, 9, time.Unix(1000, 0), nil); !vanished {
		t.Fatal("disappeared process was retained")
	}
}

func TestScannerPreservesPartiallyReadableProcess(t *testing.T) {
	root := newProcRoot(t)
	writeProcess(t, root, 11, "/usr/bin/worker", "worker", "", 100)
	scanner, uvm := newGPUScanner(t, root, false)
	connectGPU(t, root, 11, uvm)
	statusPath := filepath.Join(root, "11", "status")
	if err := os.Chmod(statusPath, 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(statusPath, 0o600) })
	inventory := scanner.Scan()
	if len(inventory.Processes) != 1 || inventory.Processes[0].Status != model.StatusPermissionDenied {
		t.Fatalf("partial process = %+v", inventory.Processes)
	}
	if len(inventory.Diagnostics) == 0 || inventory.Diagnostics[0].Code != "gpu_process_fields" {
		t.Fatalf("partial process diagnostic = %+v", inventory.Diagnostics)
	}
}

func TestScannerReportsUnreadableDescriptorDirectories(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root bypasses descriptor directory permissions")
	}
	root := newProcRoot(t)
	writeProcess(t, root, 11, "/usr/bin/worker", "worker", "", 100)
	scanner, _ := newGPUScanner(t, root, false)
	fdPath := filepath.Join(root, "11", "fd")
	if err := os.Chmod(fdPath, 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(fdPath, 0o700) })
	inventory := scanner.Scan()
	if len(inventory.Processes) != 0 || len(inventory.Diagnostics) != 1 || inventory.Diagnostics[0].Code != "gpu_process_fds" || inventory.Diagnostics[0].Status != model.StatusPermissionDenied {
		t.Fatalf("unreadable descriptor inventory = %+v", inventory)
	}
	if !strings.Contains(inventory.Diagnostics[0].Remedy, "PID namespace") || !strings.Contains(inventory.Diagnostics[0].Remedy, "host-level service") {
		t.Fatalf("unreadable descriptor remedy = %q", inventory.Diagnostics[0].Remedy)
	}
}

func TestIdentityKeyDetectsPIDReuse(t *testing.T) {
	a := time.Unix(100, 0)
	b := time.Unix(101, 0)
	if IdentityKey(model.Process{PID: 42, StartTime: &a}) == IdentityKey(model.Process{PID: 42, StartTime: &b}) {
		t.Fatal("same PID with a new start time must be a different identity")
	}
}

func TestMissingProcRootIsUnavailable(t *testing.T) {
	scanner, _ := newGPUScanner(t, filepath.Join(t.TempDir(), "missing"), false)
	inventory := scanner.Scan()
	if inventory.Capability.Available || len(inventory.Processes) != 0 || len(inventory.Diagnostics) != 1 {
		t.Fatalf("missing proc root = %+v", inventory)
	}
}

func TestMissingUVMDeviceIsUnsupported(t *testing.T) {
	root := newProcRoot(t)
	scanner := NewScanner(false)
	scanner.Root = root
	scanner.UVMPath = filepath.Join(t.TempDir(), "missing-nvidia-uvm")
	scanner.SelfPID = 0
	inventory := scanner.Scan()
	if inventory.Capability.Available || inventory.Capability.Status != model.StatusUnsupported || len(inventory.Processes) != 0 || len(inventory.Diagnostics) != 1 || inventory.Diagnostics[0].Code != "gpu_process_detection" {
		t.Fatalf("missing UVM inventory = %+v", inventory)
	}
}

func newProcRoot(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "stat"), []byte("cpu 0 0 0 0\nbtime 1000\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return root
}

func writeProcess(t *testing.T, root string, pid uint32, executable, comm, commandLine string, startTicks uint64) {
	t.Helper()
	base := filepath.Join(root, strconv.FormatUint(uint64(pid), 10))
	if err := os.Mkdir(base, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(base, "fd"), 0o700); err != nil {
		t.Fatal(err)
	}
	if executable != "" {
		if err := os.Symlink(executable, filepath.Join(base, "exe")); err != nil {
			t.Fatal(err)
		}
	}
	uid := strconv.Itoa(os.Getuid())
	files := map[string]string{
		"comm":    comm + "\n",
		"status":  "Name:\t" + comm + "\nUid:\t" + uid + "\t" + uid + "\t" + uid + "\t" + uid + "\n",
		"stat":    processStat(pid, comm, startTicks),
		"cmdline": commandLine,
	}
	for name, contents := range files {
		if err := os.WriteFile(filepath.Join(base, name), []byte(contents), 0o600); err != nil {
			t.Fatal(err)
		}
	}
}

func newGPUScanner(t *testing.T, root string, showCommandLine bool) (*Scanner, string) {
	t.Helper()
	uvm := filepath.Join(t.TempDir(), "nvidia-uvm")
	if err := os.WriteFile(uvm, []byte("test device"), 0o600); err != nil {
		t.Fatal(err)
	}
	return newGPUScannerAt(t, root, uvm, showCommandLine)
}

func newGPUScannerAt(t *testing.T, root, uvm string, showCommandLine bool) (*Scanner, string) {
	t.Helper()
	scanner := NewScanner(showCommandLine)
	scanner.Root = root
	scanner.UVMPath = uvm
	scanner.SelfPID = 0
	return scanner, uvm
}

func connectGPU(t *testing.T, root string, pid uint32, uvm string) {
	t.Helper()
	fd := filepath.Join(root, strconv.FormatUint(uint64(pid), 10), "fd", "7")
	if err := os.Symlink(uvm, fd); err != nil {
		t.Fatal(err)
	}
}

func processStat(pid uint32, name string, startTicks uint64) string {
	fields := make([]string, 20)
	fields[0] = "S"
	for index := 1; index < 19; index++ {
		fields[index] = "0"
	}
	fields[19] = strconv.FormatUint(startTicks, 10)
	return fmt.Sprintf("%d (%s) %s\n", pid, name, strings.Join(fields, " "))
}
