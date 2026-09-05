//go:build linux

package updater

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	p "github.com/intellisys-stevens/leviathan/internal/updateprotocol"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

type hostFixtureControl struct {
	sync.Mutex
	t          *testing.T
	machine    p.MachineKey
	job        *p.Job
	archive    []byte
	observed   p.Installation
	completed  chan p.ReportRequest
	reports    map[string]p.ReportRequest
	seen       map[string]bool
	heartbeats int
	reportDrop bool
	cert       p.CertificateResponse
}

func (s *hostFixtureControl) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.Lock()
	defer s.Unlock()
	w.Header().Set("Content-Type", "application/json")
	if r.URL.Path == p.EnrollPath {
		var in p.EnrollRequest
		if p.DecodeStrict(r.Body, p.MaxBodyBytes, &in) != nil || in.Token != "yenr1_disposable_host_test" {
			w.WriteHeader(401)
			return
		}
		block, _ := pem.Decode([]byte(in.CSRPEM))
		if block == nil {
			w.WriteHeader(400)
			return
		}
		csr, err := x509.ParseCertificateRequest(block.Bytes)
		if err != nil || csr.CheckSignature() != nil {
			w.WriteHeader(400)
			return
		}
		s.cert = testCertificate(s.t, csr.PublicKey.(ed25519.PublicKey), s.machine, time.Now(), 1, "updater", 90*24*time.Hour)
		json.NewEncoder(w).Encode(s.cert)
		return
	}
	var signed p.SignedRequest
	if p.DecodeStrict(r.Body, p.MaxBodyBytes, &signed) != nil {
		w.WriteHeader(400)
		return
	}
	block, _ := pem.Decode([]byte(signed.CertificatePEM))
	if block == nil {
		w.WriteHeader(401)
		return
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil || signed.CertificatePEM != s.cert.CertificatePEM || s.seen[signed.Nonce] {
		w.WriteHeader(401)
		return
	}
	digest := sha256.Sum256(signed.Payload)
	frame := fmt.Sprintf("yggdrasil-node-control-v1\nPOST\n%s\n%s\n%s\n%s\n%s\n", r.URL.Path, cert.SerialNumber.Text(16), signed.Timestamp.Format(time.RFC3339Nano), signed.Nonce, base64.RawURLEncoding.EncodeToString(digest[:]))
	sig, _ := base64.RawURLEncoding.DecodeString(signed.Signature)
	if !ed25519.Verify(cert.PublicKey.(ed25519.PublicKey), []byte(frame), sig) || time.Since(signed.Timestamp) > 30*time.Second {
		w.WriteHeader(401)
		return
	}
	s.seen[signed.Nonce] = true
	switch r.URL.Path {
	case p.ClaimPath:
		var in p.ClaimRequest
		if json.Unmarshal(signed.Payload, &in) != nil {
			w.WriteHeader(400)
			return
		}
		s.observed = in.Installation
		json.NewEncoder(w).Encode(p.ClaimResponse{Schema: p.Schema, Job: s.job, PollAfterSeconds: 15})
	case p.HeartbeatPath:
		s.heartbeats++
		json.NewEncoder(w).Encode(p.ReportResponse{Schema: p.Schema, Accepted: true})
	case p.AuthorizePath:
		var in p.AuthorizeRequest
		json.Unmarshal(signed.Payload, &in)
		if s.job == nil || in.JobID != s.job.ID || in.Installation != s.job.Expected {
			w.WriteHeader(403)
			return
		}
		s.job.Status = p.Installing
		json.NewEncoder(w).Encode(p.AuthorizeResponse{Schema: p.Schema, JobID: in.JobID, Allowed: true, InstallBefore: time.Now().Add(45 * time.Second)})
	case p.ArtifactPath:
		var in p.ArtifactRequest
		json.Unmarshal(signed.Payload, &in)
		if s.job == nil || in.JobID != s.job.ID || in.ArchiveSHA256 != sum(s.archive) {
			w.WriteHeader(403)
			return
		}
		w.Header().Set("Content-Type", "application/gzip")
		w.Write(s.archive)
	case p.ReportPath:
		var in p.ReportRequest
		if json.Unmarshal(signed.Payload, &in) != nil {
			w.WriteHeader(400)
			return
		}
		if previous, ok := s.reports[in.JobID]; ok && previous != in {
			w.WriteHeader(409)
			return
		}
		if in.Status.Terminal() {
			if _, ok := s.reports[in.JobID]; !ok {
				s.reports[in.JobID] = in
				s.completed <- in
			}
			s.observed = in.Installation
			s.job = nil
		}
		if s.reportDrop && in.Status.Terminal() {
			s.reportDrop = false
			w.WriteHeader(503)
			return
		}
		json.NewEncoder(w).Encode(p.ReportResponse{Schema: p.Schema, Accepted: true})
	default:
		w.WriteHeader(404)
	}
}
func hostCommand(t *testing.T, args ...string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, args[0], args[1:]...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("%s failed: %v\n%s", args[0], err, out)
	}
	return strings.TrimSpace(string(out))
}
func hostWrite(t *testing.T, path string, b []byte, mode os.FileMode) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, b, mode); err != nil {
		t.Fatal(err)
	}
}
func waitHost(t *testing.T, timeout time.Duration, f func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if f() {
			return
		}
		time.Sleep(250 * time.Millisecond)
	}
	t.Fatal("disposable host condition timed out")
}

// Run only on an explicitly marked disposable VM. This is the real updater
// executable, real systemd sandbox, real CPU telemetry and signed HTTPS control
// transport. The release/identity fixtures are public test material, not a
// published stable release or production enrollment.
func TestSystemdManagedUpdateAcceptance(t *testing.T) {
	if os.Getenv("LEVIATHAN_UPDATER_DISPOSABLE_HOST") != "1" {
		t.Skip("requires dedicated disposable systemd host")
	}
	if os.Geteuid() != 0 {
		t.Fatal("requires root in disposable VM")
	}
	marker, err := os.ReadFile("/run/leviathan-updater-disposable-test")
	if err != nil || string(marker) != "per-host-update-acceptance\n" {
		t.Fatal("refusing unmarked host")
	}
	pkg := "/root/updater-package"
	for _, name := range []string{"agent-old", "agent-new", "agent-future", "agent-broken", "leviathan-updater"} {
		if _, err = os.Stat(filepath.Join(pkg, name)); err != nil {
			t.Fatal(err)
		}
	}
	for _, path := range []string{"/usr/local/bin/leviathan", "/etc/leviathan-updater/config.json", "/etc/systemd/system/leviathan@nobody.service"} {
		if _, err = os.Lstat(path); !os.IsNotExist(err) {
			t.Fatal("refusing existing managed installation", path)
		}
	}
	old, _ := os.ReadFile(filepath.Join(pkg, "agent-old"))
	hostWrite(t, "/usr/local/bin/leviathan", old, 0755)
	configBody := []byte("provider = \"auto\"\ninterval = \"1s\"\n")
	hostWrite(t, "/etc/leviathan/config.toml", configBody, 0644)
	unit := `[Unit]
Description=Disposable updater acceptance monitor
[Service]
Type=simple
User=nobody
ExecStart=/usr/local/bin/leviathan --config /etc/leviathan/config.toml --listen 127.0.0.1:1397 serve
Restart=on-failure
RestartSec=2s
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
[Install]
WantedBy=multi-user.target
`
	hostWrite(t, "/etc/systemd/system/leviathan@nobody.service", []byte(unit), 0644)
	hostWrite(t, "/etc/systemd/system/leviathan-update-unrelated-workload.service", []byte("[Service]\nUser=nobody\nExecStart=/usr/bin/sleep infinity\n"), 0644)
	t.Cleanup(func() {
		exec.Command("systemctl", "stop", "leviathan-updater.service", "leviathan@nobody.service", "leviathan-update-unrelated-workload.service").Run()
	})
	hostCommand(t, "systemctl", "daemon-reload")
	hostCommand(t, "systemctl", "start", "leviathan@nobody.service", "leviathan-update-unrelated-workload.service")
	initialPID := hostCommand(t, "systemctl", "show", "leviathan@nobody.service", "--property=MainPID", "--value")
	workloadPID := hostCommand(t, "systemctl", "show", "leviathan-update-unrelated-workload.service", "--property=MainPID", "--value")
	_, key, _ := ed25519.GenerateKey(rand.Reader)
	pub := key.Public().(ed25519.PublicKey)
	der, _ := x509.MarshalPKIXPublicKey(pub)
	hostWrite(t, "/etc/leviathan-updater/release-public.pem", pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}), 0644)
	machine := p.MachineKey{PlatformID: "test", ScopeID: "disposable", MachineID: runtime.GOARCH}
	server := &hostFixtureControl{t: t, machine: machine, completed: make(chan p.ReportRequest, 8), reports: map[string]p.ReportRequest{}, seen: map[string]bool{}}
	tlsServer := httptest.NewTLSServer(server)
	defer tlsServer.Close()
	hostWrite(t, "/usr/local/share/ca-certificates/leviathan-disposable-control.crt", pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: tlsServer.Certificate().Raw}), 0644)
	hostCommand(t, "update-ca-certificates")
	cfg := Config{Schema: configSchema, ControlPlaneURL: tlsServer.URL, Machine: machine, RootDirectory: "/opt/leviathan", StateDirectory: "/var/lib/leviathan-updater", Service: "leviathan@nobody.service", APIURL: "http://127.0.0.1:1397", AgentConfigFile: "/etc/leviathan/config.toml", TrustedReleaseKeyFiles: []string{"/etc/leviathan-updater/release-public.pem"}}
	body, _ := json.Marshal(cfg)
	hostWrite(t, "/root/bootstrap.json", body, 0600)
	hostWrite(t, "/root/enrollment.token", []byte("yenr1_disposable_host_test"), 0600)
	hostCommand(t, filepath.Join(pkg, "scripts/bootstrap-updater.sh"), "--config", "/root/bootstrap.json", "--updater-binary", filepath.Join(pkg, "leviathan-updater"), "--token-file", "/root/enrollment.token", "--yggdrasil-cidr", "127.0.0.1/32", "--enable-managed-updates")
	if hostCommand(t, "systemctl", "show", cfg.Service, "--property=MainPID", "--value") != initialPID {
		t.Fatal("bootstrap restarted monitor")
	}
	waitHost(t, 35*time.Second, func() bool { server.Lock(); defer server.Unlock(); return server.observed.Managed })
	systemd := NewSystemdService(cfg)
	enqueue := func(id, file, version, commit string) {
		t.Helper()
		binary, err := os.ReadFile(filepath.Join(pkg, file))
		if err != nil {
			t.Fatal(err)
		}
		archive := tarball(t, version, runtime.GOARCH, binary, nil)
		manifest := p.Manifest{Schema: p.ManifestSchema, Version: version, Commit: commit, OS: "linux", Arch: runtime.GOARCH, MinimumGlibc: "2.34", MinimumUpdater: 1, ConfigProfile: p.ConfigProfile, StateProfile: p.StateProfile, ArchiveSHA256: sum(archive), BinarySHA256: sum(binary), ArchiveBytes: int64(len(archive)), BinaryBytes: int64(len(binary))}
		signed, err := p.SignManifest(manifest, key)
		if err != nil {
			t.Fatal(err)
		}
		server.Lock()
		defer server.Unlock()
		now := time.Now()
		server.job = &p.Job{ID: id, Machine: machine, Release: signed, Expected: server.observed, Status: p.Downloading, RequestedBy: "fixture-admin", CreatedAt: now, UpdatedAt: now, ExpiresAt: now.Add(30 * time.Minute)}
		server.archive = archive
	}
	outcome := func(want p.Status, id string) p.ReportRequest {
		t.Helper()
		select {
		case result := <-server.completed:
			if result.JobID != id || result.Status != want || !result.InstallationVerified {
				t.Fatalf("unexpected result %+v", result)
			}
			waitHost(t, 45*time.Second, func() bool {
				_, err := os.Stat(filepath.Join(cfg.StateDirectory, "transaction.json"))
				return os.IsNotExist(err)
			})
			probe, err := systemd.Probe(context.Background())
			if err != nil || probe.RunningSHA256 != result.Installation.BinarySHA256 || probe.Build.Version != result.Installation.Version || !probe.SystemAvailable {
				t.Fatalf("live process/telemetry mismatch %+v %v", probe, err)
			}
			if hostCommand(t, "systemctl", "show", "leviathan-update-unrelated-workload.service", "--property=MainPID", "--value") != workloadPID {
				t.Fatal("unrelated workload restarted")
			}
			after, _ := os.ReadFile(cfg.AgentConfigFile)
			if !bytes.Equal(after, configBody) {
				t.Fatal("config changed")
			}
			return result
		case <-time.After(4 * time.Minute):
			t.Fatal("update outcome timeout")
			return p.ReportRequest{}
		}
	}
	start := time.Now()
	server.Lock()
	server.reportDrop = true
	server.Unlock()
	enqueue("success", "agent-new", "0.4.1", strings.Repeat("1", 40))
	success := outcome(p.Succeeded, "success")
	if time.Since(start) < 60*time.Second {
		t.Fatal("health window bypassed")
	}
	t.Log("exact stable fixture update passed, lost report reconciled", success.Installation.BinarySHA256)
	if os.Getenv("LEVIATHAN_UPDATER_ACCEPTANCE_SUCCESS_ONLY") == "1" {
		return
	}
	enqueue("failed-start", "agent-broken", "0.4.2", strings.Repeat("2", 40))
	rolled := outcome(p.RolledBack, "failed-start")
	if rolled.Installation != success.Installation {
		t.Fatal("rollback changed previous installation")
	}
	t.Log("failed startup restored verified previous release")
	enqueue("crash", "agent-future", "0.4.3", strings.Repeat("3", 40))
	waitHost(t, 60*time.Second, func() bool {
		var j journal
		return readJSON(filepath.Join(cfg.StateDirectory, "transaction.json"), &j) == nil && j.Phase == "verifying"
	})
	hostCommand(t, "systemctl", "kill", "--kill-whom=main", "--signal=KILL", "leviathan-updater.service")
	outcome(p.RolledBack, "crash")
	t.Log("SIGKILL during verification recovered and rolled back after supervisor restart")
	server.Lock()
	heartbeats := server.heartbeats
	server.Unlock()
	if heartbeats < 3 {
		t.Fatal("long operations did not heartbeat")
	}
	t.Log("non-root CPU service and unrelated workload remained healthy; heartbeats", heartbeats)
}
