package updater

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	p "github.com/intellisys-stevens/leviathan/internal/updateprotocol"
)

type Options struct {
	Now           func() time.Time
	Sleep         func(context.Context, time.Duration) error
	VerifyWindow  time.Duration
	VerifyTimeout time.Duration
	ProbeInterval time.Duration
	Keys          map[string]ed25519.PublicKey
}
type Engine struct {
	config                    Config
	control                   Control
	service                   Service
	keys                      map[string]ed25519.PublicKey
	now                       func() time.Time
	sleep                     func(context.Context, time.Duration) error
	window, timeout, interval time.Duration
}
type journal struct {
	Schema         string           `json:"schema"`
	Job            p.Job            `json:"job"`
	Phase          string           `json:"phase"`
	Previous       p.Installation   `json:"previous"`
	PreviousTarget string           `json:"previousTarget"`
	Target         string           `json:"target"`
	Baseline       Probe            `json:"baseline"`
	Report         *p.ReportRequest `json:"report"`
}

var jobIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

func NewEngine(c Config, control Control, service Service, opts Options) (*Engine, error) {
	if c.Validate() != nil || service == nil {
		return nil, ErrConfiguration
	}
	keys := opts.Keys
	if len(keys) == 0 {
		var err error
		keys, err = LoadReleaseKeys(c.TrustedReleaseKeyFiles)
		if err != nil {
			return nil, err
		}
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.Sleep == nil {
		opts.Sleep = sleepContext
	}
	if opts.VerifyWindow == 0 {
		opts.VerifyWindow = 60 * time.Second
	}
	if opts.VerifyTimeout == 0 {
		opts.VerifyTimeout = 150 * time.Second
	}
	if opts.ProbeInterval == 0 {
		opts.ProbeInterval = time.Second
	}
	if opts.VerifyWindow < 0 || opts.VerifyTimeout < opts.VerifyWindow || opts.ProbeInterval < 0 {
		return nil, ErrConfiguration
	}
	return &Engine{config: c, control: control, service: service, keys: keys, now: opts.Now, sleep: opts.Sleep, window: opts.VerifyWindow, timeout: opts.VerifyTimeout, interval: opts.ProbeInterval}, nil
}
func sleepContext(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}
func (e *Engine) journalPath() string {
	return filepath.Join(e.config.StateDirectory, "transaction.json")
}
func (e *Engine) save(j *journal) error { return atomicJSON(e.journalPath(), j) }
func (e *Engine) load() (journal, error) {
	var j journal
	err := readJSON(e.journalPath(), &j)
	if err != nil {
		return j, err
	}
	if j.Schema != p.Schema || j.Job.Machine != e.config.Machine || !jobIDPattern.MatchString(j.Job.ID) || j.Previous.Validate() != nil {
		return j, ErrRecoveryRequired
	}
	if _, err = targetDigest(j.PreviousTarget); err != nil {
		return j, ErrRecoveryRequired
	}
	if j.PreviousTarget != releaseTarget(j.Previous.BinarySHA256) {
		return j, ErrRecoveryRequired
	}
	return j, nil
}

func (e *Engine) Observe(ctx context.Context) (p.Installation, error) {
	var installed p.Installation
	if err := readJSON(filepath.Join(e.config.StateDirectory, "installed.json"), &installed); err != nil {
		return installed, err
	}
	target, err := currentTarget(e.config)
	if err != nil {
		return installed, err
	}
	hash, err := binaryDigest(filepath.Join(e.config.RootDirectory, target, "leviathan"))
	if err != nil || hash != installed.BinarySHA256 || target != releaseTarget(hash) {
		return installed, ErrConfiguration
	}
	build, err := e.service.Build(ctx, filepath.Join(e.config.RootDirectory, target, "leviathan"))
	if err != nil || build.Version != installed.Version || !commitMatches(build.Commit, installed.Commit) {
		return installed, ErrConfiguration
	}
	osName, arch, glibc, err := e.service.Platform(ctx)
	if err != nil {
		return installed, err
	}
	installed.OS, installed.Arch, installed.Glibc, installed.UpdaterVersion = osName, arch, glibc, p.ProtocolVersion
	installed.ConfigSHA256, err = ConfigurationFingerprint(e.config)
	if err != nil {
		return installed, err
	}
	return installed, installed.Validate()
}
func (e *Engine) Adopt(ctx context.Context, source string, allowPreview bool) error {
	if err := prepareDirectories(e.config); err != nil {
		return err
	}
	unlock, err := lockState(filepath.Join(e.config.StateDirectory, "lock"))
	if err != nil {
		return err
	}
	defer unlock()
	if _, err = os.Lstat(e.journalPath()); err == nil {
		return ErrRecoveryRequired
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if !safeAbsolute(source) {
		return ErrConfiguration
	}
	resolved, err := filepath.EvalSymlinks(source)
	if err != nil || safeDirectory(filepath.Dir(resolved)) != nil {
		return ErrConfiguration
	}
	digest, err := binaryDigest(resolved)
	if err != nil {
		return err
	}
	build, err := e.service.Build(ctx, resolved)
	if err != nil {
		return err
	}
	if !p.StableVersion(build.Version) {
		base, pre, ok := strings.Cut(build.Version, "-")
		if !allowPreview || !ok || !p.StableVersion(base) || pre == "" {
			return errors.New("explicit adoption of a recognized preview is required")
		}
	}
	osName, arch, glibc, err := e.service.Platform(ctx)
	if err != nil {
		return err
	}
	fingerprint, err := ConfigurationFingerprint(e.config)
	if err != nil {
		return err
	}
	installed := p.Installation{Version: build.Version, Commit: build.Commit, BinarySHA256: digest, OS: osName, Arch: arch, Glibc: glibc, UpdaterVersion: p.ProtocolVersion, ConfigProfile: p.ConfigProfile, StateProfile: p.StateProfile, ConfigSHA256: fingerprint, Managed: true}
	if installed.Validate() != nil {
		return ErrConfiguration
	}
	if target, err := currentTarget(e.config); err == nil {
		if target != releaseTarget(digest) {
			return errors.New("a different managed release already exists")
		}
		var old p.Installation
		if readJSON(filepath.Join(e.config.StateDirectory, "installed.json"), &old) == nil && old == installed {
			return nil
		}
		return ErrRecoveryRequired
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	dest := filepath.Join(e.config.RootDirectory, releaseTarget(digest))
	if err = os.Mkdir(dest, 0755); err != nil && !errors.Is(err, os.ErrExist) {
		return err
	}
	if safeDirectory(dest) != nil {
		return ErrConfiguration
	}
	if err = os.Chmod(dest, 0755); err != nil {
		return err
	}
	path := filepath.Join(dest, "leviathan")
	if _, err = os.Lstat(path); errors.Is(err, os.ErrNotExist) {
		input, openErr := openNoFollow(resolved, os.O_RDONLY, 0)
		if openErr != nil {
			return openErr
		}
		defer input.Close()
		output, openErr := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0755)
		if openErr != nil {
			return openErr
		}
		if err = output.Chmod(0755); err != nil {
			output.Close()
			return err
		}
		_, copyErr := io.Copy(output, io.LimitReader(input, p.MaxBinaryBytes+1))
		syncErr := output.Sync()
		closeErr := output.Close()
		if copyErr != nil || syncErr != nil || closeErr != nil {
			return ErrConfiguration
		}
	} else if err != nil {
		return err
	}
	actual, err := binaryDigest(path)
	if err != nil || actual != digest {
		return ErrConfiguration
	}
	if err = syncDirectory(dest); err != nil {
		return err
	}
	if err = syncDirectory(filepath.Dir(dest)); err != nil {
		return err
	}
	// A bootstrap receipt makes interruption between metadata and symlink safe
	// to repeat. The original /usr/local/bin executable is still untouched.
	if err = atomicJSON(filepath.Join(e.config.StateDirectory, "installed.json"), installed); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return switchTarget(e.config, releaseTarget(digest))
}

// Tick performs at most one operation, retaining the lock across the complete
// transaction so a timer, manual process and service cannot update together.
func (e *Engine) Tick(ctx context.Context) error {
	if e.control == nil {
		return ErrControl
	}
	if err := prepareDirectories(e.config); err != nil {
		return err
	}
	unlock, err := lockState(filepath.Join(e.config.StateDirectory, "lock"))
	if err != nil {
		return err
	}
	defer unlock()
	if j, err := e.load(); err == nil {
		stopHeartbeat := e.keepAlive(j.Job.ID)
		defer stopHeartbeat()
		switch j.Phase {
		case "finished", "blocked":
			return e.deliver(ctx, &j)
		case "preparing", "prepared":
			if err = e.recover(ctx, &j, false); err != nil {
				return err
			}
			return e.deliver(ctx, &j)
		default:
			local, cancel := context.WithTimeout(context.Background(), e.timeout+40*time.Second)
			defer cancel()
			return e.recover(local, &j, false)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	installed, err := e.Observe(ctx)
	if err != nil {
		return err
	}
	response, err := e.control.Claim(ctx, p.ClaimRequest{Installation: installed})
	if err != nil {
		return err
	}
	if response.Schema != p.Schema {
		return ErrControl
	}
	if response.Job == nil {
		return nil
	}
	job := *response.Job
	if !jobIDPattern.MatchString(job.ID) || job.Machine != e.config.Machine || job.Expected != installed {
		return ErrControl
	}
	target, err := currentTarget(e.config)
	if err != nil {
		return err
	}
	j := journal{Schema: p.Schema, Job: job, Phase: "preparing", Previous: installed, PreviousTarget: target}
	if err = e.save(&j); err != nil {
		return err
	}
	stopHeartbeat := e.keepAlive(job.ID)
	defer stopHeartbeat()
	if job.Status != p.Queued && job.Status != p.Downloading {
		return e.finish(ctx, &j, p.RecoveryRequired, "unknown_prior_transaction", installed)
	}
	if !job.ExpiresAt.After(e.now()) || job.ExpiresAt.Sub(job.CreatedAt) > 30*time.Minute {
		return e.finish(ctx, &j, p.Failed, "expired", installed)
	}
	manifest, err := p.VerifyManifest(job.Release, e.keys)
	if err != nil {
		return e.finish(ctx, &j, p.Failed, "untrusted_release", installed)
	}
	if reason := p.Eligibility(manifest, installed); reason != "" {
		return e.finish(ctx, &j, p.Failed, reason, installed)
	}
	j.Baseline, err = e.service.Probe(ctx)
	if err != nil || j.Baseline.RunningSHA256 != installed.BinarySHA256 {
		return e.finish(ctx, &j, p.Failed, "baseline_unavailable", installed)
	}
	j.Target, err = e.stage(ctx, job, manifest)
	if err != nil {
		return e.finish(ctx, &j, p.Failed, "preflight_failed", installed)
	}
	j.Phase = "prepared"
	if err = e.save(&j); err != nil {
		return err
	}
	current, err := e.Observe(ctx)
	if err != nil || current != installed {
		return e.finish(ctx, &j, p.RecoveryRequired, "installation_changed", installed)
	}
	permission, err := e.control.Authorize(ctx, p.AuthorizeRequest{JobID: job.ID, Installation: current})
	if err != nil || permission.Schema != p.Schema || permission.JobID != job.ID || !permission.Allowed || !permission.InstallBefore.After(e.now()) || permission.InstallBefore.After(e.now().Add(2*time.Minute)) || !job.ExpiresAt.After(e.now()) {
		return e.finish(ctx, &j, p.Failed, "authorization_failed", installed)
	}
	j.Phase = "installing"
	if err = e.save(&j); err != nil {
		return err
	}
	// All subsequent recovery is local and gets its own bounded context; a lost
	// control-plane request or daemon shutdown cannot interrupt rollback.
	local, cancel := context.WithTimeout(context.Background(), 2*e.timeout+40*time.Second)
	defer cancel()
	if !permission.InstallBefore.After(e.now()) {
		return e.finish(ctx, &j, p.Failed, "authorization_expired", installed)
	}
	if err = switchTarget(e.config, j.Target); err != nil {
		return e.rollback(local, &j, "activation_failed")
	}
	next := installed
	next.Version, next.Commit, next.BinarySHA256 = manifest.Version, manifest.Commit, manifest.BinarySHA256
	next.ConfigProfile, next.StateProfile = manifest.ConfigProfile, manifest.StateProfile
	if err = atomicJSON(filepath.Join(e.config.StateDirectory, "installed.json"), next); err != nil {
		return e.rollback(local, &j, "metadata_failed")
	}
	j.Phase = "verifying"
	if err = e.save(&j); err != nil {
		return e.rollback(local, &j, "journal_failed")
	}
	if err = e.service.Restart(local); err != nil {
		return e.rollback(local, &j, "restart_failed")
	}
	if err = e.verify(local, next, j.Baseline, j.Job.ID); err != nil {
		return e.rollback(local, &j, "health_failed")
	}
	return e.finish(ctx, &j, p.Succeeded, "", next)
}
func (e *Engine) verify(ctx context.Context, want p.Installation, baseline Probe, jobID string) error {
	progressSent := false
	deadline := e.now().Add(e.timeout)
	var goodSince, timeSample time.Time
	for e.now().Before(deadline) {
		probe, err := e.service.Probe(ctx)
		now := e.now()
		fingerprint, fingerprintErr := ConfigurationFingerprint(e.config)
		valid := fingerprintErr == nil && fingerprint == want.ConfigSHA256 && err == nil && probe.RunningSHA256 == want.BinarySHA256 && probe.Build.Version == want.Version && commitMatches(probe.Build.Commit, want.Commit) && !probe.SampledAt.IsZero() && probe.SampledAt.After(now.Add(-120*time.Second)) && !probe.SampledAt.After(now.Add(5*time.Second)) && (probe.SystemAvailable || probe.GPUAvailable) && (!baseline.SystemAvailable || probe.SystemAvailable) && (!baseline.GPUAvailable || probe.GPUAvailable)
		if valid {
			if jobID != "" && !progressSent {
				progressSent = true
				reportContext, cancel := context.WithTimeout(ctx, 2*time.Second)
				_ = e.control.Report(reportContext, p.ReportRequest{JobID: jobID, Status: p.Verifying, Installation: want, InstallationVerified: true})
				cancel()
			}
			if goodSince.IsZero() {
				goodSince = now
				timeSample = probe.SampledAt
			}
			if now.Sub(goodSince) >= e.window && probe.SampledAt.After(timeSample) {
				return nil
			}
		} else {
			goodSince = time.Time{}
		}
		if err = e.sleep(ctx, e.interval); err != nil {
			return err
		}
	}
	return errors.New("new service failed sustained health verification")
}
func (e *Engine) finish(ctx context.Context, j *journal, status p.Status, code string, installed p.Installation) error {
	j.Phase = "finished"
	if status == p.RecoveryRequired {
		j.Phase = "blocked"
	}
	j.Report = &p.ReportRequest{JobID: j.Job.ID, Status: status, Installation: installed, Code: code, InstallationVerified: status != p.RecoveryRequired}
	if err := e.save(j); err != nil {
		return err
	}
	return e.deliver(ctx, j)
}
func (e *Engine) deliver(ctx context.Context, j *journal) error {
	if j.Report == nil {
		return ErrRecoveryRequired
	}
	if e.control == nil {
		return ErrControl
	}
	if err := e.control.Report(ctx, *j.Report); err != nil {
		return err
	}
	if err := atomicJSON(filepath.Join(e.config.StateDirectory, "last-result.json"), j.Report); err != nil {
		return err
	}
	if j.Phase == "blocked" {
		return ErrRecoveryRequired
	}
	return removeDurable(e.journalPath())
}
func (e *Engine) restore(j *journal) error {
	j.Phase = "rollback_pending"
	if err := e.save(j); err != nil {
		return err
	}
	if err := switchTarget(e.config, j.PreviousTarget); err != nil {
		return err
	}
	return atomicJSON(filepath.Join(e.config.StateDirectory, "installed.json"), j.Previous)
}
func (e *Engine) rollback(ctx context.Context, j *journal, code string) error {
	if err := e.restore(j); err != nil {
		return e.finish(ctx, j, p.RecoveryRequired, "restore_failed", j.Previous)
	}
	if err := e.service.Restart(ctx); err != nil {
		return e.finish(ctx, j, p.RecoveryRequired, "rollback_restart_failed", j.Previous)
	}
	if err := e.verify(ctx, j.Previous, j.Baseline, ""); err != nil {
		return e.finish(ctx, j, p.RecoveryRequired, "rollback_health_failed", j.Previous)
	}
	return e.finish(ctx, j, p.RolledBack, code, j.Previous)
}
func (e *Engine) recover(ctx context.Context, j *journal, offline bool) error {
	switch j.Phase {
	case "preparing", "prepared":
		observed, err := e.Observe(ctx)
		if err != nil || observed != j.Previous {
			j.Phase = "blocked"
			j.Report = &p.ReportRequest{JobID: j.Job.ID, Status: p.RecoveryRequired, Code: "installation_changed_during_recovery", Installation: j.Previous, InstallationVerified: false}
			return e.save(j)
		}
		j.Phase = "finished"
		j.Report = &p.ReportRequest{JobID: j.Job.ID, Status: p.Failed, Code: "interrupted_before_install", Installation: j.Previous, InstallationVerified: true}
		return e.save(j)
	case "installing", "verifying", "rollback_pending":
		if offline {
			return e.restore(j)
		}
		return e.rollback(ctx, j, "interrupted_update")
	case "finished":
		return nil
	case "blocked":
		return ErrRecoveryRequired
	default:
		return ErrRecoveryRequired
	}
}

// RecoverOffline is suitable for a Before=leviathan@... boot unit: it restores
// a known release without contacting Yggdrasil or trying to start the service.
func (e *Engine) RecoverOffline(ctx context.Context) error {
	if err := prepareDirectories(e.config); err != nil {
		return err
	}
	unlock, err := lockState(filepath.Join(e.config.StateDirectory, "lock"))
	if err != nil {
		return err
	}
	defer unlock()
	j, err := e.load()
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	return e.recover(ctx, &j, true)
}
func (e *Engine) Status(ctx context.Context, w io.Writer) error {
	installed, err := e.Observe(ctx)
	if err != nil {
		return err
	}
	var last p.ReportRequest
	_ = readJSON(filepath.Join(e.config.StateDirectory, "last-result.json"), &last)
	return json.NewEncoder(w).Encode(struct {
		Installation p.Installation  `json:"installation"`
		LastResult   p.ReportRequest `json:"lastResult"`
	}{installed, last})
}

// Connectivity is separate from installation evidence: a heartbeat cannot
// change the installed version, claim another job, or authorize a switch.
func (e *Engine) keepAlive(jobID string) func() {
	client, ok := e.control.(interface {
		Heartbeat(context.Context, string) error
	})
	if !ok {
		return func() {}
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for {
			request, cancelRequest := context.WithTimeout(ctx, 10*time.Second)
			_ = client.Heartbeat(request, jobID)
			cancelRequest()
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
	return func() { cancel(); <-done }
}
