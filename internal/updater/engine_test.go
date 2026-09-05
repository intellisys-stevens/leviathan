package updater

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	p "github.com/intellisys-stevens/leviathan/internal/updateprotocol"
)

func sum(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }
func tarball(t *testing.T, version, arch string, body []byte, extra *tar.Header) []byte {
	t.Helper()
	var b bytes.Buffer
	gz := gzip.NewWriter(&b)
	tw := tar.NewWriter(gz)
	if extra != nil {
		if err := tw.WriteHeader(extra); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.WriteHeader(&tar.Header{Name: "leviathan_" + version + "_linux_" + arch + "/leviathan", Size: int64(len(body)), Mode: 0755}); err != nil {
		t.Fatal(err)
	}
	if _, err := tw.Write(body); err != nil {
		t.Fatal(err)
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

type fakeControl struct {
	job                                   *p.Job
	archive                               []byte
	now                                   *time.Time
	denied                                bool
	authCalls, claims, reports, artifacts int
	reportFailures                        int
	results                               []p.ReportRequest
	progress                              []p.ReportRequest
	onArtifact                            func()
	onAuthorize                           func()
}

func (c *fakeControl) Claim(_ context.Context, in p.ClaimRequest) (p.ClaimResponse, error) {
	c.claims++
	return p.ClaimResponse{Schema: p.Schema, Job: c.job, PollAfterSeconds: 15}, nil
}
func (c *fakeControl) Authorize(_ context.Context, in p.AuthorizeRequest) (p.AuthorizeResponse, error) {
	c.authCalls++
	if c.onAuthorize != nil {
		c.onAuthorize()
	}
	return p.AuthorizeResponse{Schema: p.Schema, JobID: in.JobID, Allowed: !c.denied, InstallBefore: c.now.Add(45 * time.Second)}, nil
}
func (c *fakeControl) Report(_ context.Context, in p.ReportRequest) error {
	if !in.Status.Terminal() {
		c.progress = append(c.progress, in)
		return nil
	}
	c.reports++
	c.results = append(c.results, in)
	if c.reportFailures > 0 {
		c.reportFailures--
		return ErrControl
	}
	if in.Status.Terminal() {
		c.job = nil
	}
	return nil
}
func (c *fakeControl) Artifact(_ context.Context, in p.ArtifactRequest) (io.ReadCloser, error) {
	c.artifacts++
	if c.onArtifact != nil {
		c.onArtifact()
	}
	return io.NopCloser(bytes.NewReader(c.archive)), nil
}

type fakeService struct {
	config         Config
	now            *time.Time
	builds         map[string]BuildInfo
	running        string
	restarts       int
	failStart      map[string]bool
	preflightError bool
	gpu            bool
	loseGPU        string
	frozen         bool
	initialSample  time.Time
}

func (s *fakeService) Build(_ context.Context, path string) (BuildInfo, error) {
	b, e := os.ReadFile(path)
	if e != nil {
		return BuildInfo{}, e
	}
	v, ok := s.builds[sum(b)]
	if !ok {
		return v, ErrConfiguration
	}
	return v, nil
}
func (s *fakeService) Platform(context.Context) (string, string, string, error) {
	return "linux", "arm64", "2.36", nil
}
func (s *fakeService) Preflight(context.Context, string) error {
	if s.preflightError {
		return ErrConfiguration
	}
	return nil
}
func (s *fakeService) Restart(context.Context) error {
	s.restarts++
	target, e := currentTarget(s.config)
	if e != nil {
		return e
	}
	h, e := binaryDigest(filepath.Join(s.config.RootDirectory, target, "leviathan"))
	if e != nil {
		return e
	}
	if s.failStart[h] {
		s.running = ""
		return errors.New("startup failed")
	}
	s.running = h
	return nil
}
func (s *fakeService) Probe(context.Context) (Probe, error) {
	if s.running == "" {
		return Probe{}, errors.New("offline")
	}
	sample := *s.now
	if s.frozen {
		sample = s.initialSample
	}
	return Probe{Build: s.builds[s.running], SampledAt: sample, SystemAvailable: true, GPUAvailable: s.gpu && s.running != s.loseGPU, RunningSHA256: s.running}, nil
}

type fixture struct {
	e         *Engine
	c         *fakeControl
	s         *fakeService
	now       *time.Time
	old, next []byte
	manifest  p.Manifest
	key       ed25519.PrivateKey
	installed p.Installation
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	cfg := Config{Schema: configSchema, ControlPlaneURL: "https://updates.example.test", Machine: p.MachineKey{PlatformID: "test", ScopeID: "scope", MachineID: "host1"}, RootDirectory: filepath.Join(dir, "opt"), StateDirectory: filepath.Join(dir, "state"), Service: "leviathan@root.service", APIURL: "http://127.0.0.1:1397", TrustedReleaseKeyFiles: []string{filepath.Join(dir, "trust.pem")}, AgentConfigFile: filepath.Join(dir, "config.toml")}
	if err := os.WriteFile(cfg.AgentConfigFile, []byte("[server]\n"), 0600); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 5, 12, 0, 0, 0, time.UTC)
	old, next := []byte("old stable fixture"), []byte("new stable fixture")
	key := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{9}, 32))
	pub := key.Public().(ed25519.PublicKey)
	ctl := &fakeControl{now: &now}
	svc := &fakeService{config: cfg, now: &now, builds: map[string]BuildInfo{sum(old): {Version: "0.4.0", Commit: strings.Repeat("0", 40)}, sum(next): {Version: "0.4.1", Commit: strings.Repeat("1", 40)}}, running: sum(old), failStart: map[string]bool{}, initialSample: now}
	engine, err := NewEngine(cfg, ctl, svc, Options{Now: func() time.Time { return now }, Sleep: func(ctx context.Context, d time.Duration) error {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		now = now.Add(d)
		return nil
	}, VerifyWindow: 2 * time.Second, VerifyTimeout: 5 * time.Second, ProbeInterval: time.Second, Keys: map[string]ed25519.PublicKey{p.KeyID(pub): pub}})
	if err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(dir, "leviathan")
	if err = os.WriteFile(source, old, 0755); err != nil {
		t.Fatal(err)
	}
	if err = engine.Adopt(context.Background(), source, false); err != nil {
		t.Fatal(err)
	}
	installed, err := engine.Observe(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	f := &fixture{engine, ctl, svc, &now, old, next, p.Manifest{}, key, installed}
	f.setRelease(t, next, nil)
	return f
}
func (f *fixture) setRelease(t *testing.T, body []byte, extra *tar.Header) {
	t.Helper()
	archive := tarball(t, "0.4.1", "arm64", body, extra)
	m := p.Manifest{Schema: p.ManifestSchema, Version: "0.4.1", Commit: strings.Repeat("1", 40), OS: "linux", Arch: "arm64", MinimumGlibc: "2.34", MinimumUpdater: 1, ConfigProfile: p.ConfigProfile, StateProfile: p.StateProfile, ArchiveSHA256: sum(archive), BinarySHA256: sum(body), ArchiveBytes: int64(len(archive)), BinaryBytes: int64(len(body))}
	signed, err := p.SignManifest(m, f.key)
	if err != nil {
		t.Fatal(err)
	}
	f.manifest = m
	f.c.archive = archive
	f.c.job = &p.Job{ID: "job1", Machine: f.e.config.Machine, Release: signed, Expected: f.installed, Status: p.Downloading, RequestedBy: "admin", CreatedAt: *f.now, ExpiresAt: f.now.Add(30 * time.Minute), UpdatedAt: *f.now}
}
func (f *fixture) last(t *testing.T) p.ReportRequest {
	t.Helper()
	if len(f.c.results) == 0 {
		t.Fatal("missing report")
	}
	return f.c.results[len(f.c.results)-1]
}
func (f *fixture) assertCurrent(t *testing.T, want []byte) {
	t.Helper()
	target, e := currentTarget(f.e.config)
	if e != nil || target != releaseTarget(sum(want)) {
		t.Fatalf("unexpected active target %s %v", target, e)
	}
}
func TestSuccessfulUpdatePreservesConfigurationAndUnrelatedPersistentFiles(t *testing.T) {
	f := newFixture(t)
	cfg, _ := os.ReadFile(f.e.config.AgentConfigFile)
	history := filepath.Join(filepath.Dir(f.e.config.RootDirectory), "history.sqlite")
	os.WriteFile(history, []byte("compatible history"), 0600)
	if err := f.e.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	f.assertCurrent(t, f.next)
	result := f.last(t)
	if result.Status != p.Succeeded || !result.InstallationVerified || result.Installation.BinarySHA256 != sum(f.next) || result.Installation.Commit != f.manifest.Commit {
		t.Fatalf("unexpected receipt %+v", result)
	}
	if len(f.c.progress) != 1 || f.c.progress[0].Status != p.Verifying || f.c.progress[0].Installation != result.Installation {
		t.Fatal("missing exact-build verification progress")
	}
	if f.s.restarts != 1 || f.c.authCalls != 1 {
		t.Fatal("must restart only the selected local service once")
	}
	after, _ := os.ReadFile(f.e.config.AgentConfigFile)
	h, _ := os.ReadFile(history)
	if !bytes.Equal(cfg, after) || string(h) != "compatible history" {
		t.Fatal("configuration/history changed")
	}
	for _, dir := range []string{f.e.config.RootDirectory, filepath.Join(f.e.config.RootDirectory, releaseTarget(sum(f.next)))} {
		info, _ := os.Stat(dir)
		if info.Mode().Perm() != 0755 {
			t.Fatal("service user cannot traverse release directory")
		}
	}
	if _, err := os.Stat(f.e.journalPath()); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("completed journal retained")
	}
}
func TestRejectBeforeSwitch(t *testing.T) {
	tests := []struct {
		name   string
		change func(*fixture)
		code   string
	}{
		{"revoked", func(f *fixture) { f.c.denied = true }, "authorization_failed"},
		{"tampered archive", func(f *fixture) { f.c.archive[10] ^= 1 }, "preflight_failed"},
		{"configuration rejected", func(f *fixture) { f.s.preflightError = true }, "preflight_failed"},
		{"expired", func(f *fixture) { f.c.job.ExpiresAt = *f.now }, "expired"},
		{"unknown signing key", func(f *fixture) { f.c.job.Release.KeyID = strings.Repeat("0", 32) }, "untrusted_release"},
		{"preview downgrade", func(f *fixture) {
			f.installed.Version = "0.5.0-preview.boards"
			f.s.builds[sum(f.old)] = BuildInfo{Version: f.installed.Version, Commit: f.installed.Commit}
			atomicJSON(filepath.Join(f.e.config.StateDirectory, "installed.json"), f.installed)
			f.c.job.Expected = f.installed
		}, "not_a_newer_stable_release"},
		{"configuration changed during download", func(f *fixture) {
			f.c.onArtifact = func() { os.WriteFile(f.e.config.AgentConfigFile, []byte("changed"), 0600) }
		}, "installation_changed"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			f := newFixture(t)
			test.change(f)
			err := f.e.Tick(context.Background())
			if err != nil && !errors.Is(err, ErrRecoveryRequired) {
				t.Fatal(err)
			}
			f.assertCurrent(t, f.old)
			if f.s.restarts != 0 {
				t.Fatal("restarted on rejected request")
			}
			if f.last(t).Code != test.code {
				t.Fatal(f.last(t))
			}
		})
	}
}
func TestWrongHostAndUnmatchedInstallationNeverTouchDisk(t *testing.T) {
	for _, change := range []func(*fixture){func(f *fixture) { f.c.job.Machine.MachineID = "other" }, func(f *fixture) { f.c.job.Expected.ConfigSHA256 = strings.Repeat("8", 64) }} {
		f := newFixture(t)
		change(f)
		if f.e.Tick(context.Background()) == nil {
			t.Fatal("invalid request accepted")
		}
		f.assertCurrent(t, f.old)
		if f.c.artifacts != 0 || f.c.authCalls != 0 || f.s.restarts != 0 {
			t.Fatal("unsafe operation attempted")
		}
	}
}
func TestStartupFailureRollsBackAndVerifies(t *testing.T) {
	f := newFixture(t)
	f.s.failStart[sum(f.next)] = true
	if err := f.e.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	f.assertCurrent(t, f.old)
	if f.last(t).Status != p.RolledBack || !f.last(t).InstallationVerified || f.s.restarts != 2 {
		t.Fatal(f.last(t))
	}
}
func TestFailedRollbackNeverClaimsVerifiedInstallation(t *testing.T) {
	f := newFixture(t)
	f.s.failStart[sum(f.next)] = true
	f.s.failStart[sum(f.old)] = true
	if !errors.Is(f.e.Tick(context.Background()), ErrRecoveryRequired) {
		t.Fatal("expected intervention")
	}
	if f.last(t).Status != p.RecoveryRequired || f.last(t).InstallationVerified {
		t.Fatal("unverified rollback reported as known", f.last(t))
	}
	before := f.s.restarts
	f.e.Tick(context.Background())
	if f.s.restarts != before || f.c.claims != 1 {
		t.Fatal("blocked transaction attempted a new update")
	}
	if !errors.Is(f.e.RecoverOffline(context.Background()), ErrRecoveryRequired) {
		t.Fatal("unsafe boot gate allowed startup")
	}
}
func TestLostReportResponseReconcilesWithoutReinstall(t *testing.T) {
	f := newFixture(t)
	f.c.reportFailures = 1
	if !errors.Is(f.e.Tick(context.Background()), ErrControl) {
		t.Fatal("expected unavailable report")
	}
	f.assertCurrent(t, f.next)
	if err := f.e.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if f.s.restarts != 1 || f.c.claims != 1 || f.c.reports != 2 {
		t.Fatal("retry caused duplicate installation")
	}
	if f.c.results[0] != f.c.results[1] {
		t.Fatal("retry changed immutable receipt")
	}
}
func TestCrashRecoveryAcrossSwitchBoundaries(t *testing.T) {
	for _, phase := range []string{"preparing", "prepared", "installing", "verifying", "rollback_pending"} {
		t.Run(phase, func(t *testing.T) {
			f := newFixture(t)
			target, err := f.e.stage(context.Background(), *f.c.job, f.manifest)
			if err != nil {
				t.Fatal(err)
			}
			j := journal{Schema: p.Schema, Job: *f.c.job, Phase: phase, Previous: f.installed, PreviousTarget: releaseTarget(sum(f.old)), Target: target, Baseline: Probe{SystemAvailable: true}}
			if phase == "verifying" || phase == "rollback_pending" {
				if err = switchTarget(f.e.config, target); err != nil {
					t.Fatal(err)
				}
				next := f.installed
				next.Version = "0.4.1"
				next.Commit = f.manifest.Commit
				next.BinarySHA256 = sum(f.next)
				atomicJSON(filepath.Join(f.e.config.StateDirectory, "installed.json"), next)
				f.s.running = sum(f.next)
			}
			if err = f.e.save(&j); err != nil {
				t.Fatal(err)
			}
			if err = f.e.RecoverOffline(context.Background()); err != nil {
				t.Fatal(err)
			}
			f.assertCurrent(t, f.old)
			if f.s.restarts != 0 || f.c.reports != 0 {
				t.Fatal("offline boot recovery contacted control plane or restarted service")
			}
			if err = f.e.Tick(context.Background()); err != nil {
				t.Fatal(err)
			}
			want := p.RolledBack
			if phase == "preparing" || phase == "prepared" {
				want = p.Failed
			}
			if f.last(t).Status != want || f.c.reports != 1 {
				t.Fatalf("recovery outcome %+v reports=%d", f.last(t), f.c.reports)
			}
		})
	}
}
func TestGPURegressionRollsBackButCPUOnlySucceeds(t *testing.T) {
	f := newFixture(t)
	f.s.gpu = true
	f.s.loseGPU = sum(f.next)
	if err := f.e.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if f.last(t).Status != p.RolledBack {
		t.Fatal("lost baseline GPU ignored")
	}
	f.assertCurrent(t, f.old)
}
func TestFrozenTelemetryCannotPassSustainedHealth(t *testing.T) {
	f := newFixture(t)
	f.s.frozen = true
	if err := f.e.Tick(context.Background()); !errors.Is(err, ErrRecoveryRequired) {
		t.Fatal("frozen samples must fail candidate and rollback verification", err)
	}
	if f.last(t).InstallationVerified {
		t.Fatal("frozen sample claimed verified")
	}
}
func TestLocalLockPreventsConcurrentOperations(t *testing.T) {
	f := newFixture(t)
	unlock, err := lockState(filepath.Join(f.e.config.StateDirectory, "lock"))
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	if f.e.Tick(context.Background()) == nil {
		t.Fatal("second process acquired lock")
	}
	if f.c.claims != 0 {
		t.Fatal("second process issued claim")
	}
}
func TestUnsafeArchiveEntriesRejected(t *testing.T) {
	for _, header := range []*tar.Header{{Name: "../escape", Mode: 0600}, {Name: "/absolute", Mode: 0600}, {Name: "linked", Typeflag: tar.TypeSymlink, Linkname: "/etc/passwd"}, {Name: "hard", Typeflag: tar.TypeLink, Linkname: "/etc/passwd"}} {
		t.Run(header.Name, func(t *testing.T) {
			f := newFixture(t)
			f.setRelease(t, f.next, header)
			if err := f.e.Tick(context.Background()); err != nil {
				t.Fatal(err)
			}
			f.assertCurrent(t, f.old)
			if f.c.authCalls != 0 {
				t.Fatal("unsafe archive reached authorization")
			}
		})
	}
}
func TestAdoptRetriesInterruptedBootstrap(t *testing.T) {
	f := newFixture(t)
	source := filepath.Join(filepath.Dir(f.e.config.RootDirectory), "leviathan")
	if err := f.e.Adopt(context.Background(), source, false); err != nil {
		t.Fatal("idempotent adopt", err)
	}
	if err := os.Remove(filepath.Join(f.e.config.RootDirectory, "current")); err != nil {
		t.Fatal(err)
	}
	if err := f.e.Adopt(context.Background(), source, false); err != nil {
		t.Fatal("resume metadata-before-pointer", err)
	}
	f.assertCurrent(t, f.old)
}
func TestConfigAndFilesystemFailClosed(t *testing.T) {
	f := newFixture(t)
	for _, change := range []func(*Config){func(c *Config) { c.ControlPlaneURL = "http://evil.test" }, func(c *Config) { c.APIURL = "http://evil.test" }, func(c *Config) { c.Service = "other.service" }, func(c *Config) { c.RootDirectory = "/" }} {
		c := f.e.config
		change(&c)
		if c.Validate() == nil {
			t.Fatal("unsafe config accepted")
		}
	}
	link := filepath.Join(f.e.config.StateDirectory, "symlink")
	os.Symlink(f.e.config.AgentConfigFile, link)
	if _, err := safeRead(link, 4096, true); err == nil {
		t.Fatal("symlink credential accepted")
	}
	os.Chmod(f.e.config.AgentConfigFile, 0666)
	if _, err := ConfigurationFingerprint(f.e.config); err == nil {
		t.Fatal("writable config accepted")
	}
}
func TestEnvironmentParserNeverRunsShell(t *testing.T) {
	for _, body := range []string{"PATH=/evil", "LEVIATHAN_CONFIG=abc\\\nnext", "LEVIATHAN_A='unterminated", "LEVIATHAN_A=one\"two"} {
		if _, err := LiteralEnvironment([]byte(body)); err == nil {
			t.Fatal("unsupported syntax accepted")
		}
	}
	entries, err := LiteralEnvironment([]byte("# comment\nLEVIATHAN_TOKEN='$(touch /never-run)'\n"))
	if err != nil || len(entries) != 1 || entries[0] != "LEVIATHAN_TOKEN=$(touch /never-run)" {
		t.Fatal("literal env parsing", entries, err)
	}
}

func TestInterruptedPreparationWithChangedConfigNeedsIntervention(t *testing.T) {
	f := newFixture(t)
	j := journal{Schema: p.Schema, Job: *f.c.job, Phase: "prepared", Previous: f.installed, PreviousTarget: releaseTarget(sum(f.old))}
	if err := f.e.save(&j); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(f.e.config.AgentConfigFile, []byte("changed while updater was stopped"), 0600)
	if err := f.e.Tick(context.Background()); !errors.Is(err, ErrRecoveryRequired) {
		t.Fatal(err)
	}
	if f.last(t).InstallationVerified || f.last(t).Status != p.RecoveryRequired {
		t.Fatal("stale metadata claimed as confirmed")
	}
	if f.s.restarts != 0 {
		t.Fatal("changed installation restarted")
	}
}
