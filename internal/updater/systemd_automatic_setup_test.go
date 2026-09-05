//go:build linux

package updater

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/json"
	"encoding/pem"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"

	p "github.com/intellisys-stevens/leviathan/internal/updateprotocol"
)

// TestSystemdAutomaticSetupAcceptance uses the unchanged release installer
// template, actual compiled Go CLI, real systemd/HTTPS, and signed native
// archives. A fixture curl substitutes only the official helper download; all
// control-plane transport remains HTTPS. No Python/gh is on the install PATH.
// Build /root/updater-package/leviathan-updater with Version=0.4.1 and
// updater.ReleasePublicKeys=eZRrIVpuolPS/SjQVWmCnGqOZHMZlp/iHGR2Uku9WlI.
// /root/updater-package/agent-new must be 0.4.1, commit 111... (40 chars).
// /root/updater-package/install.sh must be the current source installer template.
func TestSystemdAutomaticSetupAcceptance(t *testing.T) {
	if os.Getenv("LEVIATHAN_UPDATER_DISPOSABLE_HOST") != "1" {
		t.Skip("requires an isolated disposable systemd host")
	}
	marker, err := os.ReadFile("/run/leviathan-updater-disposable-test")
	if os.Geteuid() != 0 || err != nil || string(marker) != "per-host-update-acceptance\n" {
		t.Fatal("refusing an unmarked/non-root host")
	}
	for _, path := range []string{"/usr/local/bin/leviathan", "/usr/local/bin/leviathan-updater", "/etc/leviathan-updater/config.json", "/var/lib/leviathan-updater/setup.json", "/etc/systemd/system/leviathan@root.service"} {
		if _, err := os.Lstat(path); !os.IsNotExist(err) {
			t.Fatal("refusing existing installation", path)
		}
	}
	f := newSetupFixture(t)
	t.Setenv("CODEX_SECRETS_DIR", "")
	binary, err := os.ReadFile("/root/updater-package/agent-new")
	if err != nil {
		t.Fatal(err)
	}
	f.binary = binary
	f.archive = tarball(t, "0.4.1", runtime.GOARCH, binary, nil)
	f.manifest.Arch = runtime.GOARCH
	f.manifest.ArchiveBytes = int64(len(f.archive))
	f.manifest.BinaryBytes = int64(len(binary))
	f.manifest.ArchiveSHA256 = sum(f.archive)
	f.manifest.BinarySHA256 = sum(binary)
	seed := sha256.Sum256([]byte("Leviathan automatic setup acceptance fixture"))
	key := ed25519.NewKeyFromSeed(seed[:])
	defer clear(key)
	f.signed, err = p.SignManifest(f.manifest, key)
	if err != nil {
		t.Fatal(err)
	}
	hostWrite(t, "/usr/local/share/ca-certificates/leviathan-disposable-control.crt", pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: f.server.Certificate().Raw}), 0644)
	hostCommand(t, "update-ca-certificates")
	hostWrite(t, "/etc/systemd/system/leviathan-update-unrelated-workload.service", []byte("[Service]\nUser=nobody\nExecStart=/usr/bin/sleep infinity\n"), 0644)
	t.Cleanup(func() {
		exec.Command("systemctl", "stop", "leviathan-updater.service", "leviathan@root.service", "leviathan-update-unrelated-workload.service").Run()
	})
	hostCommand(t, "systemctl", "daemon-reload")
	hostCommand(t, "systemctl", "start", "leviathan-update-unrelated-workload.service")
	workloadPID := hostCommand(t, "systemctl", "show", "leviathan-update-unrelated-workload.service", "--property=MainPID", "--value")
	helper := "/root/updater-package/leviathan-updater"
	installer, installPATH := fixtureAutomaticInstaller(t, helper, f.manifest)
	launch := func() *exec.Cmd {
		command := exec.Command("/bin/sh", installer, "--yggdrasil", f.server.URL, "--ticket-stdin")
		command.Stdin = strings.NewReader("yst1_fixture_private_ticket\n")
		command.Env = []string{"PATH=" + installPATH, "HOME=/root", "CODEX_SECRETS_DIR="}
		command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
		return command
	}
	first := launch()
	var firstLog bytes.Buffer
	first.Stdout = &firstLog
	first.Stderr = &firstLog
	if err = first.Start(); err != nil {
		t.Fatal(err)
	}
	started := false
	for until := time.Now().Add(40 * time.Second); time.Now().Before(until); {
		var record setupRecord
		if readSetupRecord("/var/lib/leviathan-updater/setup.json", &record) == nil && record.Started {
			state, _ := exec.Command("systemctl", "is-active", "leviathan@root.service").Output()
			if strings.TrimSpace(string(state)) == "active" {
				started = true
				break
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	if !started {
		_ = syscall.Kill(-first.Process.Pid, syscall.SIGKILL)
		first.Wait()
		t.Fatalf("fresh setup did not start monitor: %s", firstLog.String())
	}
	if err = syscall.Kill(-first.Process.Pid, syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	_ = first.Wait()
	initialPID := hostCommand(t, "systemctl", "show", "leviathan@root.service", "--property=MainPID", "--value")
	var interrupted setupRecord
	if err = readSetupRecord("/var/lib/leviathan-updater/setup.json", &interrupted); err != nil || interrupted.Complete {
		t.Fatal("expected interrupted uncompleted verification", err)
	}
	// Model the backend's non-extendable lease as expired. A started monitor may
	// resume verification/reporting, but artifact or install authorization retry
	// is forbidden. This avoids a 45-second sleep in the acceptance harness.
	interrupted.InstallBefore = time.Now().Add(-time.Minute)
	if err = atomicJSON("/var/lib/leviathan-updater/setup.json", interrupted); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	f.strictInstalling = true
	f.installing = true
	f.leaseUntil = time.Now().Add(-time.Minute)
	f.mu.Unlock()
	second := launch()
	if output, err := second.CombinedOutput(); err != nil {
		t.Fatalf("interrupted verification resume failed: %v\n%s", err, output)
	}
	finalPID := hostCommand(t, "systemctl", "show", "leviathan@root.service", "--property=MainPID", "--value")
	if initialPID != finalPID {
		t.Fatal("resumed setup restarted the already-running monitor")
	}
	var completed setupRecord
	if err = readSetupRecord("/var/lib/leviathan-updater/setup.json", &completed); err != nil || !completed.Complete {
		t.Fatal("setup completion missing", err)
	}
	identityPath := filepath.Join(completed.Config.credentialDirectory(), "identity.json")
	var installedIdentity identity
	if err = readJSON(identityPath, &installedIdentity); err != nil {
		t.Fatal(err)
	}
	// The deliberately short initial fixture certificate triggers normal
	// renewal immediately when polling starts. Renewal retains the Ed25519 key;
	// comparing the whole identity file here would race that valid operation.
	var renewedIdentity identity
	var renewedSerial string
	for until := time.Now().Add(25 * time.Second); time.Now().Before(until); {
		if err = readJSON(identityPath, &renewedIdentity); err == nil {
			key, cert, identityErr := parseIdentity(renewedIdentity, completed.Config.Machine, time.Now())
			clear(key)
			if identityErr == nil && cert.NotAfter.After(time.Now().Add(30*24*time.Hour)) {
				renewedSerial = cert.SerialNumber.Text(16)
				break
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	if renewedSerial == "" || installedIdentity.PrivateKey != renewedIdentity.PrivateKey {
		t.Fatal("fixture certificate renewal did not retain its host key")
	}
	if sha, err := ConfigurationFingerprint(completed.Config); err != nil || sha != completed.Installation.ConfigSHA256 {
		t.Fatal("authorized setup fingerprint differs from normal updater", err)
	}
	third := launch()
	if output, err := third.CombinedOutput(); err != nil {
		t.Fatalf("identical retry failed: %v %s", err, output)
	}
	if next := hostCommand(t, "systemctl", "show", "leviathan@root.service", "--property=MainPID", "--value"); next != finalPID {
		t.Fatal("completed retry changed PID")
	}
	var nextIdentity identity
	if err = readJSON(identityPath, &nextIdentity); err != nil || nextIdentity.PrivateKey != installedIdentity.PrivateKey {
		t.Fatal("retry rotated the host key", err)
	}
	nextKey, nextCert, err := parseIdentity(nextIdentity, completed.Config.Machine, time.Now())
	clear(nextKey)
	if err != nil || nextCert.SerialNumber.Text(16) != renewedSerial {
		t.Fatal("retry restored a stale receipt certificate", err)
	}
	if next := hostCommand(t, "systemctl", "show", "leviathan-update-unrelated-workload.service", "--property=MainPID", "--value"); next != workloadPID {
		t.Fatal("setup disturbed unrelated workload")
	}
	unit, err := os.ReadFile("/etc/systemd/system/leviathan-updater.service")
	if err != nil || bytes.Contains(unit, []byte("IPAddressDeny=")) {
		t.Fatal("normal polling unexpectedly requires static CIDRs", err)
	}
	receipt := map[string]any{"architecture": runtime.GOARCH, "version": completed.Installation.Version, "commit": completed.Installation.Commit, "runningPIDPreservedAcrossResume": true, "identityPreserved": true, "renewedCertificatePreserved": true, "unrelatedWorkloadPreserved": true, "expiredLeaseVerificationResume": true, "releasePinnedShellVerifiedRealHelper": true, "helperDownloadFixtureOnly": true, "normalPathPythonOrGH": false}
	data, _ := json.MarshalIndent(receipt, "", "  ")
	hostWrite(t, "/root/automatic-setup-receipt.json", append(data, '\n'), 0600)
}

func fixtureAutomaticInstaller(t *testing.T, helper string, m p.Manifest) (string, string) {
	t.Helper()
	body, err := os.ReadFile("/root/updater-package/install.sh")
	if err != nil {
		t.Fatal("copy the current installer template into the disposable package", err)
	}
	helperBytes, err := os.ReadFile(helper)
	if err != nil {
		t.Fatal(err)
	}
	// These six release-only assignments are exactly the mutable pin block used
	// by stamp-installer.py. The shell's executable logic is kept unchanged.
	values := map[string]string{"release_version": m.Version, "release_commit": m.Commit, "release_amd64_archive_sha256": m.ArchiveSHA256, "release_arm64_archive_sha256": m.ArchiveSHA256, "release_amd64_updater_sha256": sum(helperBytes), "release_arm64_updater_sha256": sum(helperBytes)}
	for name, value := range values {
		old := name + "=''"
		if bytes.Count(body, []byte(old)) != 1 {
			t.Fatal("unexpected installer template pin", name)
		}
		body = bytes.Replace(body, []byte(old), []byte(name+"='"+value+"'"), 1)
	}
	dir, err := os.MkdirTemp("/run", "leviathan-shell-fixture-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	installer := filepath.Join(dir, "install.sh")
	hostWrite(t, installer, body, 0700)
	bin := filepath.Join(dir, "bin")
	if err = os.Mkdir(bin, 0700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"awk", "chmod", "env", "getconf", "grep", "id", "mktemp", "readlink", "rm", "sha256sum", "sh", "uname", "cp"} {
		path, err := exec.LookPath(name)
		if err != nil {
			t.Fatal(err)
		}
		if err = os.Symlink(path, filepath.Join(bin, name)); err != nil {
			t.Fatal(err)
		}
	}
	// Fixture only: accept the single pinned official helper URL and copy the
	// exact native helper. Unexpected downloads fail; no general network shim.
	url := "https://github.com/intellisys-stevens/leviathan/releases/download/v" + m.Version + "/leviathan-updater_linux_" + runtime.GOARCH
	curl := "#!/bin/sh\nset -eu\noutput=\nurl=\nwhile [ \"$#\" -gt 0 ]; do\n case \"$1\" in\n --output) output=$2; shift 2;;\n --proto|--tls-max) shift 2;;\n --*) shift;;\n *) url=$1; shift;;\n esac\ndone\n[ \"$url\" = '" + url + "' ] || exit 91\ncase \"$output\" in /run/leviathan-install.*/leviathan-updater) ;; *) exit 92;; esac\ncp '" + helper + "' \"$output\"\n"
	hostWrite(t, filepath.Join(bin, "curl"), []byte(curl), 0700)
	for _, forbidden := range []string{"python", "python3", "gh"} {
		if _, err = os.Lstat(filepath.Join(bin, forbidden)); !os.IsNotExist(err) {
			t.Fatal("unexpected setup dependency", forbidden)
		}
	}
	return installer, bin
}
