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
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	p "github.com/intellisys-stevens/leviathan/internal/updateprotocol"
)

type setupFixture struct {
	t                                                                   *testing.T
	root                                                                string
	h                                                                   *setupHost
	opts                                                                SetupOptions
	server                                                              *httptest.Server
	manifest                                                            p.Manifest
	signed                                                              p.SignedManifest
	archive, binary                                                     []byte
	machine                                                             p.MachineKey
	calls                                                               []string
	builds                                                              map[string]BuildInfo
	mu                                                                  sync.Mutex
	csr                                                                 string
	seen                                                                map[string]bool
	reports                                                             []p.SetupReportRequest
	deny, loseRedeem, loseReport, failStart, failPoll, existing, active bool
	authorized                                                          *p.SetupAuthorizeRequest
	beforeAuthorize                                                     func()
	probes, redemptions                                                 int
	strictInstalling, installing                                        bool
	leaseUntil                                                          time.Time
	artifactCalls                                                       int
	ticket                                                              string
	setupStatus                                                         p.SetupState
	allowPreview                                                        bool
	probeGPU                                                            bool
	beforeProbe                                                         func()
}

func newSetupFixture(t *testing.T) *setupFixture {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	f := &setupFixture{t: t, root: root, binary: []byte("verified release executable"), machine: p.MachineKey{PlatformID: "fixture", ScopeID: "setup-test", MachineID: "host"}, seen: map[string]bool{}, builds: map[string]BuildInfo{}, ticket: "yst1_fixture_private_ticket", setupStatus: p.SetupRedeemed, allowPreview: true}
	f.archive = tarball(t, "0.4.1", "arm64", f.binary, nil)
	keyPublic, key, _ := ed25519.GenerateKey(rand.Reader)
	f.manifest = p.Manifest{Schema: p.ManifestSchema, Version: "0.4.1", Commit: strings.Repeat("1", 40), OS: "linux", Arch: "arm64", MinimumGlibc: "2.34", MinimumUpdater: 1, ConfigProfile: p.ConfigProfile, StateProfile: p.StateProfile, ArchiveSHA256: sum(f.archive), BinarySHA256: sum(f.binary), ArchiveBytes: int64(len(f.archive)), BinaryBytes: int64(len(f.binary))}
	f.signed, err = p.SignManifest(f.manifest, key)
	if err != nil {
		t.Fatal(err)
	}
	f.builds[sum(f.binary)] = BuildInfo{Version: f.manifest.Version, Commit: f.manifest.Commit}
	self := filepath.Join(root, "verified-updater")
	if err = os.WriteFile(self, []byte("verified updater executable"), 0755); err != nil {
		t.Fatal(err)
	}
	f.h = &setupHost{root: root, arch: "arm64", run: f.run, executable: func() (string, error) { return self, nil }, service: func(c Config) Service { return &setupFixtureService{f: f, c: c} }, verifyWindow: time.Millisecond, timeLimit: 3 * time.Second}
	f.server = httptest.NewTLSServer(f)
	t.Cleanup(f.server.Close)
	f.opts = SetupOptions{Version: f.manifest.Version, Commit: f.manifest.Commit, ArchiveURL: f.server.URL + "/leviathan_linux_arm64.tar.gz", ArchiveSHA256: f.manifest.ArchiveSHA256, ControlOrigin: f.server.URL, TicketStdin: true, host: f.h, http: f.server.Client(), keys: map[string]ed25519.PublicKey{p.KeyID(keyPublic): keyPublic}}
	t.Setenv("CODEX_SECRETS_DIR", filepath.Join(root, "secrets"))
	return f
}
func (f *setupFixture) run(ctx context.Context, name string, args ...string) ([]byte, error) {
	f.calls = append(f.calls, name+" "+strings.Join(args, " "))
	if name == "getconf" {
		return []byte("glibc 2.36\n"), nil
	}
	if name == "systemctl" {
		switch args[0] {
		case "list-units":
			if f.existing {
				return []byte("leviathan@root.service loaded active running Monitor\n"), nil
			}
			return nil, nil
		case "list-unit-files":
			for _, argument := range args {
				if argument == "leviathan@*.service" {
					return nil, errors.New("real systemctl returns exit 1 for an unmatched unit pattern")
				}
			}
			return []byte("ssh.service enabled enabled\nunrelated.service static -\n"), nil
		case "show":
			return []byte("User=root\nActiveState=active\nFragmentPath=" + f.h.path("/etc/systemd/system/leviathan@root.service") + "\nEnvironmentFiles=\nExecStart={ path=" + f.h.path("/usr/local/bin/leviathan") + " ; argv[]=" + f.h.path("/usr/local/bin/leviathan") + " --config " + f.h.path("/etc/leviathan/config.toml") + " --listen 127.0.0.1:1397 serve ; }\n"), nil
		case "enable":
			if args[len(args)-1] == "leviathan-updater.service" {
				if f.failPoll {
					return nil, errors.New("fixture interruption before polling")
				}
			} else {
				if f.failStart {
					return nil, errors.New("fixture failed start")
				}
				f.active = true
			}
			return nil, nil
		case "stop":
			f.active = false
			return nil, nil
		default:
			return nil, nil
		}
	}
	if len(args) > 0 && args[0] == "version" {
		body, err := os.ReadFile(name)
		if err != nil {
			return nil, err
		}
		build, ok := f.builds[sum(body)]
		if !ok {
			return nil, ErrConfiguration
		}
		return json.Marshal(build)
	}
	return nil, errors.New("unexpected fixture command")
}
func (f *setupFixture) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	if r.Method == http.MethodGet {
		if strings.HasSuffix(r.URL.Path, ".manifest.json") {
			json.NewEncoder(w).Encode(f.signed)
		} else {
			w.Header().Set("Content-Type", "application/gzip")
			w.Write(f.archive)
		}
		return
	}
	if r.URL.Path == p.SetupRedeemPath {
		var in p.SetupRedeemRequest
		if p.DecodeStrict(r.Body, p.MaxBodyBytes, &in) != nil {
			f.t.Error("invalid redeem")
			w.WriteHeader(400)
			return
		}
		if in.Ticket != f.ticket || in.Arch != f.manifest.Arch {
			f.t.Error("wrong ticket or arch")
		}
		if f.csr != "" && f.csr != in.CSRPEM {
			f.t.Error("CSR changed across retry")
		}
		f.csr = in.CSRPEM
		f.redemptions++
		block, _ := pem.Decode([]byte(in.CSRPEM))
		csr, err := x509.ParseCertificateRequest(block.Bytes)
		if err != nil || csr.CheckSignature() != nil {
			f.t.Fatal("invalid CSR")
		}
		cert := testCertificate(f.t, csr.PublicKey.(ed25519.PublicKey), f.machine, time.Now(), 1, "updater", time.Hour)
		if f.loseRedeem {
			f.loseRedeem = false
			w.WriteHeader(503)
			return
		}
		json.NewEncoder(w).Encode(p.SetupRedeemResponse{Schema: p.Schema, SetupID: "fixture-setup", Machine: f.machine, ExpiresAt: time.Now().Add(10 * time.Minute), Release: f.signed, Certificate: cert, AllowPreview: f.allowPreview})
		return
	}
	var signed p.SignedRequest
	if p.DecodeStrict(r.Body, p.MaxBodyBytes, &signed) != nil {
		f.t.Error("invalid signed request")
		w.WriteHeader(400)
		return
	}
	block, _ := pem.Decode([]byte(signed.CertificatePEM))
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		f.t.Fatal(err)
	}
	digest := sha256.Sum256(signed.Payload)
	frame := fmt.Sprintf("yggdrasil-node-control-v1\nPOST\n%s\n%s\n%s\n%s\n%s\n", r.URL.Path, cert.SerialNumber.Text(16), signed.Timestamp.Format(time.RFC3339Nano), signed.Nonce, base64.RawURLEncoding.EncodeToString(digest[:]))
	signature, _ := base64.RawURLEncoding.DecodeString(signed.Signature)
	if f.seen[signed.Nonce] || !ed25519.Verify(cert.PublicKey.(ed25519.PublicKey), []byte(frame), signature) {
		f.t.Error("invalid or replayed setup signature")
	}
	f.seen[signed.Nonce] = true
	switch r.URL.Path {
	case p.SetupArtifactPath:
		if f.strictInstalling && f.installing {
			w.WriteHeader(409)
			return
		}
		f.artifactCalls++
		w.Header().Set("Content-Type", "application/gzip")
		w.Write(f.archive)
	case p.SetupAuthorizePath:
		var in p.SetupAuthorizeRequest
		json.Unmarshal(signed.Payload, &in)
		if f.strictInstalling && f.installing && !time.Now().Before(f.leaseUntil) {
			w.WriteHeader(409)
			return
		}
		if !f.installing {
			f.leaseUntil = time.Now().Add(45 * time.Second)
		}
		f.installing = true
		f.authorized = &in
		if f.beforeAuthorize != nil {
			f.beforeAuthorize()
		}
		json.NewEncoder(w).Encode(p.SetupAuthorizeResponse{Schema: p.Schema, SetupID: in.SetupID, Allowed: !f.deny, AllowPreview: f.allowPreview, InstallBefore: f.leaseUntil})
	case p.SetupStatusPath:
		var in p.SetupStatusRequest
		json.Unmarshal(signed.Payload, &in)
		json.NewEncoder(w).Encode(p.SetupStatusResponse{Schema: p.Schema, Setup: p.SetupSummary{ID: in.SetupID, Machine: f.machine, Status: f.setupStatus}})
	case p.SetupReportPath:
		var in p.SetupReportRequest
		json.Unmarshal(signed.Payload, &in)
		f.reports = append(f.reports, in)
		if f.loseReport {
			w.WriteHeader(503)
			return
		}
		json.NewEncoder(w).Encode(p.ReportResponse{Schema: p.Schema, Accepted: true})
	case p.ClaimPath:
		json.NewEncoder(w).Encode(p.ClaimResponse{Schema: p.Schema, PollAfterSeconds: 15})
	case p.HeartbeatPath:
		json.NewEncoder(w).Encode(p.ReportResponse{Schema: p.Schema, Accepted: true})
	case p.RenewPath:
		var in p.RenewRequest
		json.Unmarshal(signed.Payload, &in)
		block, _ := pem.Decode([]byte(in.CSRPEM))
		csr, err := x509.ParseCertificateRequest(block.Bytes)
		if err != nil {
			w.WriteHeader(400)
			return
		}
		json.NewEncoder(w).Encode(testCertificate(f.t, csr.PublicKey.(ed25519.PublicKey), f.machine, time.Now(), 2, "updater", 90*24*time.Hour))
	default:
		f.t.Error("unexpected setup route", r.URL.Path)
		w.WriteHeader(404)
	}
}
func (f *setupFixture) apply() error {
	return Setup(context.Background(), f.opts, strings.NewReader(f.ticket+"\n"), &bytes.Buffer{})
}
func (f *setupFixture) write(name string, body []byte, mode os.FileMode) {
	f.t.Helper()
	path := f.h.path(name)
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		f.t.Fatal(err)
	}
	if err := os.WriteFile(path, body, mode); err != nil {
		f.t.Fatal(err)
	}
}

type setupFixtureService struct {
	f *setupFixture
	c Config
}

func (s *setupFixtureService) Build(ctx context.Context, path string) (BuildInfo, error) {
	return s.f.h.build(ctx, path)
}
func (s *setupFixtureService) Platform(context.Context) (string, string, string, error) {
	return "linux", "arm64", "2.36", nil
}
func (s *setupFixtureService) Preflight(_ context.Context, path string) error {
	if _, err := os.ReadFile(s.c.AgentConfigFile); err != nil {
		return err
	}
	return nil
}
func (s *setupFixtureService) Restart(context.Context) error {
	return errors.New("setup must never restart an existing service")
}
func (s *setupFixtureService) Probe(ctx context.Context) (Probe, error) {
	if s.f.beforeProbe != nil {
		s.f.beforeProbe()
	}
	s.f.probes++
	if !s.f.active {
		return Probe{}, errors.New("inactive")
	}
	path := s.f.h.path("/usr/local/bin/leviathan")
	if value, err := filepath.EvalSymlinks(path); err == nil {
		path = value
	}
	body, err := os.ReadFile(path)
	if err != nil {
		return Probe{}, err
	}
	build := s.f.builds[sum(body)]
	return Probe{Build: build, RunningSHA256: sum(body), SampledAt: time.Now(), SystemAvailable: true, GPUAvailable: s.f.probeGPU}, nil
}
func TestSetupFreshAuthorizationIdentityAndIdempotentRetry(t *testing.T) {
	f := newSetupFixture(t)
	f.beforeAuthorize = func() {
		for _, path := range []string{"/usr/local/bin/leviathan", "/usr/local/bin/leviathan-updater", "/etc/leviathan-updater/config.json", "/etc/systemd/system/leviathan@root.service"} {
			if _, err := os.Lstat(f.h.path(path)); !errors.Is(err, os.ErrNotExist) {
				t.Error("installation preceded final authorization", path)
			}
		}
	}
	if err := f.apply(); err != nil {
		t.Fatal(err)
	}
	if f.authorized == nil || f.authorized.Mode != p.SetupInstall || len(f.reports) != 2 || f.reports[0].Status != p.SetupVerifying || !f.reports[1].InstallationVerified {
		t.Fatal("missing exact authorization/result")
	}
	assertSetupFingerprint(t, f)
	key, err := os.ReadFile(filepath.Join(f.root, "secrets/identity.json"))
	if err != nil {
		t.Fatal(err)
	}
	probes := f.probes
	f.calls = nil
	f.beforeAuthorize = nil
	if err = f.apply(); err != nil {
		t.Fatal(err)
	}
	next, _ := os.ReadFile(filepath.Join(f.root, "secrets/identity.json"))
	if !bytes.Equal(key, next) || f.probes != probes || f.redemptions != 1 {
		t.Fatal("retry changed identity or revalidated baseline")
	}
	for _, call := range f.calls {
		if strings.Contains(call, "enable --now leviathan@root.service") || strings.Contains(call, "stop") {
			t.Fatal("retry disturbed monitor", call)
		}
	}
}
func TestSetupDeniedAuthorizationLeavesRuntimeAbsent(t *testing.T) {
	f := newSetupFixture(t)
	f.deny = true
	if f.apply() == nil {
		t.Fatal("accepted denied setup")
	}
	for _, path := range []string{"/usr/local/bin/leviathan", "/etc/leviathan-updater/config.json", "/etc/systemd/system/leviathan@root.service"} {
		if _, err := os.Lstat(f.h.path(path)); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("denied setup installed", path)
		}
	}
}
func TestSetupEnrollmentLossReusesCSR(t *testing.T) {
	f := newSetupFixture(t)
	f.loseRedeem = true
	if f.apply() == nil {
		t.Fatal("missing simulated enrollment loss")
	}
	first := f.csr
	if err := f.apply(); err != nil {
		t.Fatal(err)
	}
	if f.redemptions != 2 || f.csr != first {
		t.Fatal("enrollment retry changed CSR")
	}
}
func TestSetupCompletesBeforePollingAndPreservesNewerReleaseOnRetry(t *testing.T) {
	f := newSetupFixture(t)
	f.failPoll = true
	if f.apply() == nil {
		t.Fatal("missing polling interruption")
	}
	var record setupRecord
	if err := readSetupRecord(f.h.path("/var/lib/leviathan-updater/setup.json"), &record); err != nil || !record.Complete {
		t.Fatal("completion must precede polling", err)
	}
	newer := []byte("later approved release")
	hash := sum(newer)
	f.write("/opt/leviathan/releases/"+hash+"/leviathan", newer, 0755)
	f.builds[hash] = BuildInfo{Version: "0.5.0", Commit: strings.Repeat("2", 40)}
	if err := switchTarget(record.Config, releaseTarget(hash)); err != nil {
		t.Fatal(err)
	}
	f.failPoll = false
	f.calls = nil
	probes := f.probes
	if err := f.apply(); err != nil {
		t.Fatal(err)
	}
	actual, _ := os.ReadFile(f.h.path("/usr/local/bin/leviathan"))
	if !bytes.Equal(actual, newer) || f.probes != probes {
		t.Fatal("retry replaced/revalidated newer release")
	}
}
func TestSetupExistingPreviewIsAdoptedWithoutRestart(t *testing.T) {
	f := newSetupFixture(t)
	f.existing = true
	f.active = true
	old := []byte("existing preview")
	f.builds[sum(old)] = BuildInfo{Version: "0.5.0-preview.1", Commit: strings.Repeat("3", 40)}
	f.write("/usr/local/bin/leviathan", old, 0755)
	f.write("/etc/leviathan/config.toml", []byte("# existing\n"), 0644)
	f.write("/etc/systemd/system/leviathan@root.service", []byte("existing service"), 0644)
	if err := f.apply(); err != nil {
		t.Fatal(err)
	}
	if f.authorized.Mode != p.SetupAdopt || f.authorized.Installation.BinarySHA256 != sum(old) {
		t.Fatal("wrong adoption baseline")
	}
	assertSetupFingerprint(t, f)
	for _, call := range f.calls {
		if strings.Contains(call, "enable --now leviathan@root.service") || strings.Contains(call, "stop") || strings.Contains(call, "restart") {
			t.Fatal("adoption changed running service", call)
		}
	}
}

func assertSetupFingerprint(t *testing.T, f *setupFixture) {
	t.Helper()
	var record setupRecord
	if err := readSetupRecord(f.h.path("/var/lib/leviathan-updater/setup.json"), &record); err != nil {
		t.Fatal(err)
	}
	actual, err := ConfigurationFingerprint(record.Config)
	if err != nil || actual != record.Installation.ConfigSHA256 {
		t.Fatal("setup fingerprint differs from the normal updater", err)
	}
}

func fixtureSetupCrash(t *testing.T, run func() error) {
	t.Helper()
	defer func() {
		if value := recover(); value != "fixture power loss" {
			t.Fatalf("expected disposable power-loss fixture, got %v", value)
		}
	}()
	if err := run(); err != nil {
		t.Fatalf("setup failed before interruption: %v", err)
	}
}

func TestSetupInterruptedAuthorizationReusesCandidateWithinOriginalLease(t *testing.T) {
	f := newSetupFixture(t)
	f.strictInstalling = true
	original := f.h.run
	f.h.run = func(ctx context.Context, name string, args ...string) ([]byte, error) {
		var record setupRecord
		if len(args) > 0 && args[0] == "version" && readSetupRecord(f.h.path("/var/lib/leviathan-updater/setup.json"), &record) == nil && record.Authorized {
			panic("fixture power loss")
		}
		return original(ctx, name, args...)
	}
	fixtureSetupCrash(t, f.apply)
	f.h.run = original
	originalLease := f.leaseUntil
	if err := f.apply(); err != nil {
		t.Fatal("failed to resume with cached candidate", err)
	}
	if f.artifactCalls != 1 || !f.leaseUntil.Equal(originalLease) {
		t.Fatal("resume fetched an artifact after authorization or renewed its lease")
	}
}

func TestSetupExpiredUnstartedAuthorizationNeverInstalls(t *testing.T) {
	f := newSetupFixture(t)
	f.strictInstalling = true
	original := f.h.run
	f.h.run = func(ctx context.Context, name string, args ...string) ([]byte, error) {
		var record setupRecord
		if len(args) > 0 && args[0] == "version" && readSetupRecord(f.h.path("/var/lib/leviathan-updater/setup.json"), &record) == nil && record.Authorized {
			panic("fixture power loss")
		}
		return original(ctx, name, args...)
	}
	fixtureSetupCrash(t, f.apply)
	f.h.run = original
	f.mu.Lock()
	f.leaseUntil = time.Now().Add(-time.Minute)
	f.mu.Unlock()
	f.calls = nil
	if f.apply() == nil {
		t.Fatal("expired unstarted transaction was installed")
	}
	if _, err := os.Lstat(f.h.path("/usr/local/bin/leviathan")); !errors.Is(err, os.ErrNotExist) || f.active || f.artifactCalls != 1 {
		t.Fatal("expired transaction crossed activation boundary", err)
	}
	last := f.reports[len(f.reports)-1]
	if last.Status != p.SetupRecoveryRequired || last.InstallationVerified {
		t.Fatal("interrupted transaction did not report explicit recovery")
	}
}

func TestSetupStartedMonitorResumesOnlyVerificationAfterLeaseExpires(t *testing.T) {
	f := newSetupFixture(t)
	f.strictInstalling = true
	original := f.h.run
	f.h.run = func(ctx context.Context, name string, args ...string) ([]byte, error) {
		out, err := original(ctx, name, args...)
		if name == "systemctl" && strings.Join(args, " ") == "enable --now leviathan@root.service" {
			panic("fixture power loss")
		}
		return out, err
	}
	fixtureSetupCrash(t, f.apply)
	f.h.run = original
	f.mu.Lock()
	f.leaseUntil = time.Now().Add(-time.Minute)
	f.mu.Unlock()
	f.calls = nil
	if err := f.apply(); err != nil {
		t.Fatal("verification-only resume failed", err)
	}
	if f.artifactCalls != 1 {
		t.Fatal("resume retrieved an artifact")
	}
	for _, call := range f.calls {
		if strings.Contains(call, "daemon-reload") || strings.Contains(call, "enable --now leviathan@root.service") || strings.Contains(call, "stop") {
			t.Fatal("resume crossed installation boundary", call)
		}
	}
}

func TestSetupCompletedRetryStartsReportingServiceDespiteOfflineResult(t *testing.T) {
	f := newSetupFixture(t)
	f.loseReport = true
	f.failPoll = true
	if f.apply() == nil {
		t.Fatal("expected interruption before polling")
	}
	f.failPoll = false
	f.calls = nil
	if err := f.apply(); err != nil {
		t.Fatal("offline result prevented independent reporting service", err)
	}
	if len(f.calls) != 1 || f.calls[0] != "systemctl enable --now leviathan-updater.service" {
		t.Fatal("completed retry touched monitor or did not start reporter", f.calls)
	}
	var record setupRecord
	path := f.h.path("/var/lib/leviathan-updater/setup.json")
	if err := readSetupRecord(path, &record); err != nil || record.Report == nil || !record.Complete {
		t.Fatal("lost durable result", err)
	}
	f.mu.Lock()
	f.loseReport = false
	f.mu.Unlock()
	client, err := NewClient(record.Config, f.server.Client())
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if err = client.ReconcileSetup(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err = readSetupRecord(path, &record); err != nil || record.Report != nil {
		t.Fatal("result not reconciled", err)
	}
}

func TestSetupGPUAdoptionRequiresOriginalTelemetryAndRecoveryIsSticky(t *testing.T) {
	f := newSetupFixture(t)
	f.existing, f.active, f.probeGPU = true, true, true
	f.write("/usr/local/bin/leviathan", f.binary, 0755)
	f.write("/etc/leviathan/config.toml", []byte("# retained\n"), 0644)
	f.write("/etc/systemd/system/leviathan@root.service", []byte("existing service"), 0644)
	f.beforeAuthorize = func() { f.probeGPU = false }
	f.h.timeLimit = 20 * time.Millisecond
	if f.apply() == nil {
		t.Fatal("GPU adoption succeeded after GPU telemetry vanished")
	}
	if !f.active || f.reports[len(f.reports)-1].Status != p.SetupRecoveryRequired {
		t.Fatal("adoption disturbed the existing monitor or lost recovery status")
	}
	f.beforeAuthorize = nil
	f.probeGPU = true
	f.calls = nil
	if !errors.Is(f.apply(), ErrRecoveryRequired) || len(f.calls) != 0 {
		t.Fatal("operator-recovery state was automatically overwritten")
	}
}

func TestSetupExpiredTicketReplacementRetainsCSRAndKnownMachine(t *testing.T) {
	for _, receipt := range []bool{false, true} {
		t.Run(fmt.Sprint(receipt), func(t *testing.T) {
			f := newSetupFixture(t)
			f.loseRedeem = !receipt
			f.deny = receipt
			if f.apply() == nil {
				t.Fatal("expected retained pre-install state")
			}
			var pending identity
			keyPath := filepath.Join(f.root, "secrets/setup-identity.json")
			if err := readJSON(keyPath, &pending); err != nil {
				t.Fatal(err)
			}
			f.mu.Lock()
			f.ticket = "yst1_replacement_fixture_ticket"
			f.setupStatus = p.SetupExpired
			f.deny, f.installing = false, false
			f.mu.Unlock()
			if err := f.apply(); err != nil {
				t.Fatal("safe ticket replacement failed", err)
			}
			var after identity
			if err := readJSON(keyPath, &after); err != nil || after.CSRPEM != pending.CSRPEM || after.PrivateKey != pending.PrivateKey {
				t.Fatal("replacement changed host key", err)
			}
			assertSetupFingerprint(t, f)
		})
	}
}

func TestSetupActiveTicketCannotBeReplaced(t *testing.T) {
	f := newSetupFixture(t)
	f.deny = true
	if f.apply() == nil {
		t.Fatal("expected denied authorization")
	}
	f.mu.Lock()
	f.ticket = "yst1_replacement_fixture_ticket"
	f.mu.Unlock()
	if f.apply() == nil || f.redemptions != 1 {
		t.Fatal("active ticket was replaced")
	}
	if _, err := os.Lstat(f.h.path("/usr/local/bin/leviathan")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("replacement installed a monitor", err)
	}
}

func TestSetupHostUtilitiesIgnoreCallerPATH(t *testing.T) {
	path := t.TempDir()
	marker := filepath.Join(path, "executed")
	if err := os.WriteFile(filepath.Join(path, "getconf"), []byte("#!/bin/sh\ntouch '"+marker+"'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", path)
	if _, err := setupRun(context.Background(), "getconf", "ARG_MAX"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(marker); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("untrusted PATH command executed", err)
	}
}

func TestSetupUntrustedReleaseNeverPublishesRuntime(t *testing.T) {
	for _, failure := range []string{"signature", "archive", "architecture", "pinned_commit"} {
		t.Run(failure, func(t *testing.T) {
			f := newSetupFixture(t)
			switch failure {
			case "signature":
				f.signed.Signature = strings.Repeat("A", len(f.signed.Signature))
			case "archive":
				f.archive[len(f.archive)/2] ^= 1
			case "architecture":
				f.h.arch = "amd64"
				// An architecture mismatch is rejected before using a receipt.
				f.manifest.Arch = "amd64"
			case "pinned_commit":
				f.opts.Commit = strings.Repeat("9", 40)
			}
			if f.apply() == nil {
				t.Fatal("untrusted release accepted")
			}
			for _, name := range []string{"/usr/local/bin/leviathan", "/usr/local/bin/leviathan-updater", "/etc/leviathan-updater/config.json", "/etc/systemd/system/leviathan@root.service"} {
				if _, err := os.Lstat(f.h.path(name)); !errors.Is(err, os.ErrNotExist) {
					t.Fatal("untrusted release published runtime", name, err)
				}
			}
			if f.authorized != nil {
				t.Fatal("unverified artifact requested installation authorization")
			}
		})
	}
}

func TestSetupPreviewAdoptionNeedsExplicitPermission(t *testing.T) {
	f := newSetupFixture(t)
	f.allowPreview = false
	f.active, f.existing = true, true
	old := []byte("existing unapproved preview")
	f.builds[sum(old)] = BuildInfo{Version: "0.5.0-preview.1", Commit: strings.Repeat("3", 40)}
	f.write("/usr/local/bin/leviathan", old, 0755)
	f.write("/etc/leviathan/config.toml", []byte("# retained\n"), 0644)
	f.write("/etc/systemd/system/leviathan@root.service", []byte("existing service"), 0644)
	if f.apply() == nil {
		t.Fatal("preview adopted without explicit permission")
	}
	actual, err := os.ReadFile(f.h.path("/usr/local/bin/leviathan"))
	if err != nil || !bytes.Equal(actual, old) || f.authorized != nil {
		t.Fatal("preview changed or reached authorization", err)
	}
	for _, call := range f.calls {
		if strings.Contains(call, "enable") || strings.Contains(call, "stop") || strings.Contains(call, "restart") {
			t.Fatal("preview service changed", call)
		}
	}
}

func TestSetupStandaloneOlderReleasePreservesBothExecutables(t *testing.T) {
	for _, existing := range []string{"0.5.0", "0.5.0-preview.1"} {
		t.Run(existing, func(t *testing.T) {
			f := newSetupFixture(t)
			f.opts.ControlOrigin, f.opts.TicketStdin = "", false
			f.opts.InstallDirectory = filepath.Join(f.root, "bin")
			old := []byte("newer existing monitor")
			f.builds[sum(old)] = BuildInfo{Version: existing, Commit: strings.Repeat("3", 40)}
			f.write("/bin/leviathan", old, 0755)
			f.write("/bin/leviathan-updater", []byte("existing updater"), 0755)
			if f.apply() == nil {
				t.Fatal("standalone installer downgraded existing version")
			}
			monitor, _ := os.ReadFile(filepath.Join(f.root, "bin/leviathan"))
			updater, _ := os.ReadFile(filepath.Join(f.root, "bin/leviathan-updater"))
			if !bytes.Equal(monitor, old) || string(updater) != "existing updater" {
				t.Fatal("refused downgrade still changed executables")
			}
		})
	}
}

func TestSetupCompletedRetryPreservesRenewedCertificate(t *testing.T) {
	f := newSetupFixture(t)
	if err := f.apply(); err != nil {
		t.Fatal(err)
	}
	var record setupRecord
	if err := readSetupRecord(f.h.path("/var/lib/leviathan-updater/setup.json"), &record); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(record.Config.credentialDirectory(), "identity.json")
	var initial identity
	if err := readJSON(path, &initial); err != nil {
		t.Fatal(err)
	}
	client, err := NewClient(record.Config, f.server.Client())
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if err = client.Renew(context.Background()); err != nil {
		t.Fatal(err)
	}
	var renewed identity
	if err = readJSON(path, &renewed); err != nil || renewed.PrivateKey != initial.PrivateKey || renewed.CertificatePEM == initial.CertificatePEM {
		t.Fatal("fixture renewal did not replace only the certificate", err)
	}
	if err = f.apply(); err != nil {
		t.Fatal(err)
	}
	var after identity
	if err = readJSON(path, &after); err != nil || after != renewed {
		t.Fatal("repeated setup restored the old receipt certificate", err)
	}
}

func TestSetupRejectsWorldWritableInstallationAncestors(t *testing.T) {
	for _, path := range []string{"/opt", "/usr/local/bin"} {
		t.Run(path, func(t *testing.T) {
			f := newSetupFixture(t)
			parent := f.h.path(path)
			if err := os.MkdirAll(parent, 0755); err != nil {
				t.Fatal(err)
			}
			if err := os.Chmod(parent, 0777); err != nil {
				t.Fatal(err)
			}
			if err := f.apply(); !errors.Is(err, ErrConfiguration) && !errors.Is(err, ErrRecoveryRequired) {
				t.Fatal("accepted a world-writable installation ancestor", err)
			}
			if _, err := os.Lstat(f.h.path("/usr/local/bin/leviathan")); !errors.Is(err, os.ErrNotExist) || f.active {
				t.Fatal("unsafe ancestor reached monitor activation", err)
			}
			if info, err := os.Stat(parent); err != nil || info.Mode().Perm() != 0777 {
				t.Fatal("installer changed existing parent directory permissions", err)
			}
		})
	}
}
func TestSetupStandaloneBothOptOutAndManagedRefusal(t *testing.T) {
	for _, without := range []bool{false, true} {
		t.Run(fmt.Sprint(without), func(t *testing.T) {
			f := newSetupFixture(t)
			f.opts.ControlOrigin = ""
			f.opts.TicketStdin = false
			f.opts.InstallDirectory = filepath.Join(f.root, "bin")
			f.opts.WithoutUpdater = without
			if err := f.apply(); err != nil {
				t.Fatal(err)
			}
			if _, err := os.Stat(filepath.Join(f.root, "bin/leviathan-updater")); errors.Is(err, os.ErrNotExist) != without {
				t.Fatal("wrong updater install mode", err)
			}
			target := filepath.Join(f.root, "bin/leviathan")
			os.Remove(target)
			os.Symlink("/opt/leviathan/current/leviathan", target)
			if f.apply() == nil {
				t.Fatal("overwrote dangling managed symlink")
			}
		})
	}
}
