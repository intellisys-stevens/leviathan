//go:build linux

package updater

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	p "github.com/intellisys-stevens/leviathan/internal/updateprotocol"
)

// These are later updates of the newly generated installer, not an adoption
// through the older packaged/bootstrap units. No shorter health window is used.
func automaticSetupUpdates(t *testing.T, setup *setupFixture, installed setupRecord, certificate string, key ed25519.PrivateKey, workloadPID string) (*hostFixtureControl, map[string]any) {
	t.Helper()
	control := &hostFixtureControl{t: t, machine: installed.Config.Machine, observed: installed.Installation,
		cert: p.CertificateResponse{CertificatePEM: certificate}, completed: make(chan p.ReportRequest, 8),
		reports: map[string]p.ReportRequest{}, seen: map[string]bool{}}
	setup.mu.Lock()
	for nonce, seen := range setup.seen {
		control.seen[nonce] = seen
	}
	setup.updateControl = control
	setup.mu.Unlock()
	systemd := NewSystemdService(installed.Config)
	initial, err := systemd.Probe(context.Background())
	if err != nil {
		t.Fatal("generated monitor initial probe", err)
	}
	recoveryStart := hostCommand(t, "systemctl", "show", "leviathan-updater-recover.service", "--property=ExecMainStartTimestampMonotonic", "--value")
	if recoveryStart == "0" || hostCommand(t, "systemctl", "is-active", "leviathan-updater-recover.service") != "active" {
		t.Fatal("generated recovery unit did not remain active after initial setup")
	}
	configBefore, err := os.ReadFile(installed.Config.AgentConfigFile)
	if err != nil {
		t.Fatal(err)
	}
	outcome := func(id string, status p.Status) p.ReportRequest {
		t.Helper()
		select {
		case result := <-control.completed:
			if result.JobID != id || result.Status != status || !result.InstallationVerified {
				t.Fatalf("unexpected generated-installer outcome: %+v", result)
			}
			waitHost(t, 45*time.Second, func() bool {
				_, err := os.Stat(filepath.Join(installed.Config.StateDirectory, "transaction.json"))
				return os.IsNotExist(err)
			})
			probe, err := systemd.Probe(context.Background())
			if err != nil || probe.RunningSHA256 != result.Installation.BinarySHA256 || probe.Build.Version != result.Installation.Version ||
				(initial.SystemAvailable && !probe.SystemAvailable) || (initial.GPUAvailable && !probe.GPUAvailable) {
				t.Fatalf("live generated-installer result did not retain its exact build and domains: %+v %v", probe, err)
			}
			if hostCommand(t, "systemctl", "show", "leviathan-update-unrelated-workload.service", "--property=MainPID", "--value") != workloadPID {
				t.Fatal("generated-installer update restarted unrelated workload")
			}
			if hostCommand(t, "systemctl", "show", "leviathan-updater-recover.service", "--property=ExecMainStartTimestampMonotonic", "--value") != recoveryStart {
				t.Fatal("monitor restart re-executed boot recovery inside a live updater transaction")
			}
			configAfter, err := os.ReadFile(installed.Config.AgentConfigFile)
			fingerprint, fingerprintErr := ConfigurationFingerprint(installed.Config)
			if err != nil || !bytes.Equal(configBefore, configAfter) || fingerprintErr != nil || fingerprint != installed.Installation.ConfigSHA256 {
				t.Fatal("generated-installer update changed approved configuration")
			}
			return result
		case <-time.After(4 * time.Minute):
			t.Fatal("generated-installer update outcome timed out")
			return p.ReportRequest{}
		}
	}
	started := time.Now()
	enqueueGeneratedUpdate(t, control, key, "generated-success", "agent-next", "0.4.2", strings.Repeat("2", 40))
	success := outcome("generated-success", p.Succeeded)
	if time.Since(started) < time.Minute {
		t.Fatal("generated-installer update bypassed sustained verification")
	}
	t.Log("generated-installer signed update verified", success.Installation.BinarySHA256)
	enqueueGeneratedUpdate(t, control, key, "generated-bad-start", "agent-setup-broken", "0.4.3", strings.Repeat("3", 40))
	rollback := outcome("generated-bad-start", p.RolledBack)
	if rollback.Installation != success.Installation {
		t.Fatal("bad candidate did not restore the previous exact installation")
	}
	t.Log("generated-installer failed candidate rolled back and verified")
	enqueueGeneratedUpdate(t, control, key, "generated-crash", "agent-setup-future", "0.4.4", strings.Repeat("4", 40))
	waitHost(t, 60*time.Second, func() bool {
		var j journal
		return readJSON(filepath.Join(installed.Config.StateDirectory, "transaction.json"), &j) == nil && j.Job.ID == "generated-crash" && j.Phase == "verifying"
	})
	hostCommand(t, "systemctl", "kill", "--kill-whom=main", "--signal=KILL", "leviathan-updater.service")
	crash := outcome("generated-crash", p.RolledBack)
	if crash.Installation != success.Installation {
		t.Fatal("crash recovery did not restore the previous exact installation")
	}
	t.Log("generated-installer SIGKILL recovered with required domains and workload intact")
	return control, map[string]any{"success": success, "failedCandidate": rollback, "crashRecovery": crash,
		"requiredSystem": initial.SystemAvailable, "requiredGPU": initial.GPUAvailable,
		"recoveryUnitHeldActive": true, "configurationPreserved": true, "unrelatedWorkloadPreserved": true}
}

func enqueueGeneratedUpdate(t *testing.T, control *hostFixtureControl, key ed25519.PrivateKey, id, file, version, commit string) {
	t.Helper()
	binary, err := os.ReadFile(filepath.Join("/root/updater-package", file))
	if err != nil {
		t.Fatal(err)
	}
	archive := tarball(t, version, runtime.GOARCH, binary, nil)
	manifest := p.Manifest{Schema: p.ManifestSchema, Version: version, Commit: commit, OS: "linux", Arch: runtime.GOARCH,
		MinimumGlibc: "2.34", MinimumUpdater: 1, ConfigProfile: p.ConfigProfile, StateProfile: p.StateProfile,
		ArchiveSHA256: sum(archive), BinarySHA256: sum(binary), ArchiveBytes: int64(len(archive)), BinaryBytes: int64(len(binary))}
	signed, err := p.SignManifest(manifest, key)
	if err != nil {
		t.Fatal(err)
	}
	control.Lock()
	defer control.Unlock()
	if control.job != nil {
		t.Fatal("cannot replace a pending fixture job")
	}
	now := time.Now()
	control.job = &p.Job{ID: id, Machine: control.machine, Release: signed, Expected: control.observed,
		Status: p.Downloading, RequestedBy: "fixture-admin", CreatedAt: now, UpdatedAt: now, ExpiresAt: now.Add(30 * time.Minute)}
	control.archive = archive
}
