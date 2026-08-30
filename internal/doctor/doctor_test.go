package doctor

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	gonvml "github.com/NVIDIA/go-nvml/pkg/nvml"
	"github.com/intellisys-stevens/miglens/internal/model"
)

func TestCurrentPIDNamespaceReportsProcAvailable(t *testing.T) {
	diagnostics := checkProc()
	found := false
	for _, diagnostic := range diagnostics {
		if diagnostic.Code == "host_pid_namespace" {
			t.Fatalf("doctor reported the removed host PID namespace diagnostic: %+v", diagnostic)
		}
		if diagnostic.Code != "proc" {
			continue
		}
		if diagnostic.Status != model.StatusAvailable {
			t.Fatalf("current PID namespace status = %q, want %q: %+v", diagnostic.Status, model.StatusAvailable, diagnostic)
		}
		found = true
	}
	if !found {
		t.Fatalf("current PID namespace was not reported available: %+v", diagnostics)
	}
}

func TestNVMLStatus(t *testing.T) {
	if got := nvmlStatus(gonvml.ERROR_NO_PERMISSION); got != model.StatusPermissionDenied {
		t.Fatalf("permission status = %q", got)
	}
	if got := nvmlStatus(gonvml.ERROR_NOT_SUPPORTED); got != model.StatusUnsupported {
		t.Fatalf("unsupported status = %q", got)
	}
}

func TestGPUProcessCheckTreatsZeroClientsAsHealthy(t *testing.T) {
	root, uvm := doctorProcessFixture(t)
	diagnostics := checkProcessVisibility(root, uvm, 1)
	for _, diagnostic := range diagnostics {
		if diagnostic.Severity != "info" {
			t.Fatalf("healthy empty inventory produced a warning: %+v", diagnostics)
		}
	}
	found := false
	for _, diagnostic := range diagnostics {
		if diagnostic.Code == "gpu_processes" && diagnostic.Status == model.StatusAvailable && strings.Contains(diagnostic.Summary, "0 GPU-connected") {
			found = true
		}
	}
	if !found {
		t.Fatalf("healthy zero-client result missing: %+v", diagnostics)
	}
}

func TestGPUProcessCheckReportsMissingUVMSeparatelyFromProc(t *testing.T) {
	root, _ := doctorProcessFixture(t)
	diagnostics := checkProcessVisibility(root, filepath.Join(t.TempDir(), "missing-uvm"), 1)
	var procAvailable, uvmMissing bool
	for _, diagnostic := range diagnostics {
		procAvailable = procAvailable || diagnostic.Code == "proc" && diagnostic.Status == model.StatusAvailable
		uvmMissing = uvmMissing || diagnostic.Code == "nvidia_uvm" && diagnostic.Status == model.StatusUnsupported
	}
	if !procAvailable || !uvmMissing {
		t.Fatalf("proc and UVM statuses were conflated: %+v", diagnostics)
	}
}

func doctorProcessFixture(t *testing.T) (string, string) {
	t.Helper()
	root := t.TempDir()
	pidRoot := filepath.Join(root, "1")
	if err := os.MkdirAll(filepath.Join(pidRoot, "fd"), 0o700); err != nil {
		t.Fatal(err)
	}
	for name, contents := range map[string]string{
		"comm":   "fixture-init\n",
		"status": "Name:\tfixture\nUid:\t0\t0\t0\t0\n",
		"stat":   "1 (fixture) S 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 100 0\n",
	} {
		if err := os.WriteFile(filepath.Join(pidRoot, name), []byte(contents), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "stat"), []byte("cpu 0 0 0 0\nbtime 1000\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	uvm := filepath.Join(t.TempDir(), "nvidia-uvm")
	if err := os.WriteFile(uvm, []byte("fixture"), 0o600); err != nil {
		t.Fatal(err)
	}
	return root, uvm
}
