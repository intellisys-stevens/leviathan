//go:build linux

package updater

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	p "github.com/intellisys-stevens/leviathan/internal/updateprotocol"
)

// This exercises real local installation, signature verification, HTTPS
// enrollment and systemd. GitHub publication/attestation responses are fixtures,
// so it does not establish official-release provenance or production readiness.
func TestSystemdFreshInstallAcceptance(t *testing.T) {
	if os.Getenv("LEVIATHAN_UPDATER_DISPOSABLE_HOST") != "1" {
		t.Skip("requires dedicated disposable systemd host")
	}
	marker, err := os.ReadFile("/run/leviathan-updater-disposable-test")
	if os.Geteuid() != 0 || err != nil || string(marker) != "per-host-update-acceptance\n" {
		t.Fatal("refusing unmarked or non-root host")
	}
	for _, path := range []string{"/usr/local/bin/leviathan", "/etc/leviathan-updater/config.json", "/etc/systemd/system/leviathan@nobody.service", "/root/managed-install-fixture"} {
		if _, err = os.Lstat(path); !os.IsNotExist(err) {
			t.Fatal("refusing existing installation or fixture", path)
		}
	}
	const pkg = "/root/updater-package"
	const fixtureRoot = "/root/managed-install-fixture"
	const version = "0.4.1"
	commit := strings.Repeat("1", 40)
	binary, err := os.ReadFile(filepath.Join(pkg, "agent-new"))
	if err != nil {
		t.Fatal(err)
	}
	archiveName := "leviathan_linux_" + runtime.GOARCH + ".tar.gz"
	manifestName := "leviathan_linux_" + runtime.GOARCH + ".manifest.json"
	stageName := "leviathan_" + version + "_linux_" + runtime.GOARCH
	stage := filepath.Join(fixtureRoot, "stage", stageName)
	hostWrite(t, filepath.Join(stage, "leviathan"), binary, 0755)
	for _, name := range []string{"leviathan-updater", "scripts/bootstrap-updater.py", "contrib/systemd/leviathan@.service", "contrib/systemd/leviathan-updater.service", "contrib/systemd/leviathan-updater-recover.service"} {
		data, err := os.ReadFile(filepath.Join(pkg, name))
		if err != nil {
			t.Fatal(err)
		}
		hostWrite(t, filepath.Join(stage, name), data, 0755)
	}
	hostCommand(t, "tar", "-czf", filepath.Join(fixtureRoot, archiveName), "-C", filepath.Dir(stage), stageName)
	archive, err := os.ReadFile(filepath.Join(fixtureRoot, archiveName))
	if err != nil {
		t.Fatal(err)
	}
	pub, key, _ := ed25519.GenerateKey(rand.Reader)
	manifest := p.Manifest{Schema: p.ManifestSchema, Version: version, Commit: commit, OS: "linux", Arch: runtime.GOARCH, MinimumGlibc: "2.34", MinimumUpdater: 1, ConfigProfile: p.ConfigProfile, StateProfile: p.StateProfile, ArchiveSHA256: sum(archive), BinarySHA256: sum(binary), ArchiveBytes: int64(len(archive)), BinaryBytes: int64(len(binary))}
	signed, err := p.SignManifest(manifest, key)
	if err != nil {
		t.Fatal(err)
	}
	document, _ := json.Marshal(signed)
	hostWrite(t, filepath.Join(fixtureRoot, manifestName), document, 0644)
	der, _ := x509.MarshalPKIXPublicKey(pub)
	hostWrite(t, "/etc/leviathan-updater/release-public.pem", pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}), 0644)

	// Only the GitHub transport is replaced. The installer's signature, archive,
	// bootstrap, systemd and updater executables are the actual implementations.
	ghFixture := `#!/usr/bin/python3
import json, pathlib, shutil, sys
args = sys.argv[1:]
base = pathlib.Path("/root/managed-install-fixture")
with (base / "github-calls.jsonl").open("a") as out:
    out.write(json.dumps(args) + "\n")
if args[:2] == ["release", "view"]:
    print(json.dumps({"tagName": "v0.4.1", "isDraft": False, "isPrerelease": False}))
elif args[:2] == ["release", "download"]:
    dest = pathlib.Path(args[args.index("--dir") + 1])
    for i, arg in enumerate(args):
        if arg == "--pattern":
            shutil.copyfile(base / args[i + 1], dest / args[i + 1])
elif args[:2] != ["attestation", "verify"]:
    sys.exit(2)
`
	hostWrite(t, filepath.Join(fixtureRoot, "bin/gh"), []byte(ghFixture), 0755)
	t.Setenv("PATH", filepath.Join(fixtureRoot, "bin")+":"+os.Getenv("PATH"))
	machine := p.MachineKey{PlatformID: "test", ScopeID: "disposable-fresh", MachineID: runtime.GOARCH}
	server := &hostFixtureControl{t: t, machine: machine, completed: make(chan p.ReportRequest, 8), reports: map[string]p.ReportRequest{}, seen: map[string]bool{}}
	tlsServer := httptest.NewTLSServer(server)
	defer tlsServer.Close()
	hostWrite(t, "/usr/local/share/ca-certificates/leviathan-disposable-control.crt", pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: tlsServer.Certificate().Raw}), 0644)
	hostCommand(t, "update-ca-certificates")
	configBody := []byte("provider = \"auto\"\ninterval = \"1s\"\n")
	hostWrite(t, "/etc/leviathan/config.toml", configBody, 0644)
	cfg := Config{Schema: configSchema, ControlPlaneURL: tlsServer.URL, Machine: machine, RootDirectory: "/opt/leviathan", StateDirectory: "/var/lib/leviathan-updater", Service: "leviathan@nobody.service", APIURL: "http://127.0.0.1:1397", AgentConfigFile: "/etc/leviathan/config.toml", TrustedReleaseKeyFiles: []string{"/etc/leviathan-updater/release-public.pem"}}
	body, _ := json.Marshal(cfg)
	hostWrite(t, "/root/bootstrap.json", body, 0600)
	hostWrite(t, "/root/enrollment.token", []byte("yenr1_disposable_host_test"), 0600)
	hostWrite(t, "/etc/systemd/system/leviathan-update-unrelated-workload.service", []byte("[Service]\nUser=nobody\nExecStart=/usr/bin/sleep infinity\n"), 0644)
	t.Cleanup(func() {
		exec.Command("systemctl", "stop", "leviathan-updater.service", cfg.Service, "leviathan-update-unrelated-workload.service").Run()
	})
	hostCommand(t, "systemctl", "daemon-reload")
	hostCommand(t, "systemctl", "start", "leviathan-update-unrelated-workload.service")
	workloadPID := hostCommand(t, "systemctl", "show", "leviathan-update-unrelated-workload.service", "--property=MainPID", "--value")
	command := []string{"/bin/sh", filepath.Join(pkg, "scripts/install.sh"), "--with-updater", "--version", "v" + version, "--commit", commit, "--updater-config", "/root/bootstrap.json", "--token-file", "/root/enrollment.token", "--release-public-key", cfg.TrustedReleaseKeyFiles[0], "--yggdrasil-cidr", "127.0.0.1/32"}
	hostCommand(t, append(append([]string{}, command...), "--dry-run")...)
	for _, path := range []string{"/usr/local/bin/leviathan", "/var/lib/leviathan-updater/identity.json", "/etc/systemd/system/leviathan@nobody.service"} {
		if _, err := os.Lstat(path); !os.IsNotExist(err) {
			t.Fatal("dry run mutated host", path)
		}
	}
	server.Lock()
	enrolled := server.cert.CertificatePEM != ""
	server.Unlock()
	if enrolled {
		t.Fatal("dry run enrolled host")
	}
	hostCommand(t, command...)
	pid := hostCommand(t, "systemctl", "show", cfg.Service, "--property=MainPID", "--value")
	identity, err := os.ReadFile(filepath.Join(cfg.StateDirectory, "identity.json"))
	if err != nil {
		t.Fatal(err)
	}
	probe, err := NewSystemdService(cfg).Probe(context.Background())
	if err != nil || probe.Build.Version != version || probe.Build.Commit != commit || probe.RunningSHA256 != manifest.BinarySHA256 || !probe.SystemAvailable {
		t.Fatalf("fresh service differs from signed baseline: %+v %v", probe, err)
	}
	waitHost(t, 35*time.Second, func() bool { server.Lock(); defer server.Unlock(); return server.observed.Managed })
	hostCommand(t, command...)
	if hostCommand(t, "systemctl", "show", cfg.Service, "--property=MainPID", "--value") != pid {
		t.Fatal("identical rerun restarted fresh monitor")
	}
	afterIdentity, _ := os.ReadFile(filepath.Join(cfg.StateDirectory, "identity.json"))
	afterConfig, _ := os.ReadFile(cfg.AgentConfigFile)
	if !bytes.Equal(identity, afterIdentity) || !bytes.Equal(configBody, afterConfig) || hostCommand(t, "systemctl", "show", "leviathan-update-unrelated-workload.service", "--property=MainPID", "--value") != workloadPID {
		t.Fatal("rerun changed enrollment identity, configuration or unrelated workload")
	}
	t.Log("combined installer verified: side-effect-free dry run, exact fresh non-root service, HTTPS enrollment, identical rerun and unrelated workload preservation")
}
