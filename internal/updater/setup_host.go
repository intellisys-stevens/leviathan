package updater

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	p "github.com/intellisys-stevens/leviathan/internal/updateprotocol"
)

type setupHost struct {
	root, arch              string
	run                     func(context.Context, string, ...string) ([]byte, error)
	executable              func() (string, error)
	service                 func(Config) Service
	verifyWindow, timeLimit time.Duration
}

func newSetupHost() *setupHost {
	return &setupHost{root: "/", arch: runtime.GOARCH, run: setupRun, executable: os.Executable, service: func(c Config) Service { return NewSystemdService(c) }, verifyWindow: 60 * time.Second, timeLimit: 150 * time.Second}
}
func setupRun(ctx context.Context, name string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	path := name
	if !filepath.IsAbs(path) {
		// Resolve privileged host utilities independently of the caller's PATH.
		// The executable's own environment does not affect Go's earlier lookup.
		if name != "systemctl" && name != "getconf" {
			return nil, ErrConfiguration
		}
		path = filepath.Join("/usr/bin", name)
	}
	command := exec.CommandContext(ctx, path, args...)
	command.Env = []string{"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "HOME=/nonexistent"}
	out := &boundedBuffer{max: 256 << 10}
	command.Stdout = out
	command.Stderr = io.Discard
	if err := command.Run(); err != nil {
		return nil, fmt.Errorf("local setup command failed: %s", filepath.Base(name))
	}
	return out.Bytes(), nil
}
func (h *setupHost) path(value string) string {
	return filepath.Join(h.root, strings.TrimPrefix(value, "/"))
}
func (h *setupHost) build(ctx context.Context, path string) (BuildInfo, error) {
	var out BuildInfo
	b, err := h.run(ctx, path, "version", "--format", "json")
	if err != nil || p.DecodeStrict(bytes.NewReader(b), 64<<10, &out) != nil {
		return out, ErrConfiguration
	}
	return out, nil
}
func (h *setupHost) compatible(ctx context.Context, m p.Manifest) error {
	b, err := h.run(ctx, "getconf", "GNU_LIBC_VERSION")
	if err != nil || !strings.HasPrefix(strings.TrimSpace(string(b)), "glibc ") || !p.GlibcAtLeast(strings.TrimSpace(strings.TrimPrefix(string(b), "glibc ")), m.MinimumGlibc) {
		return errors.New("release is incompatible with this host's glibc")
	}
	return nil
}

var setupLiteralPath = regexp.MustCompile(`^/[A-Za-z0-9_./@-]+$`)

func setupPath(value string) bool { return safeAbsolute(value) && setupLiteralPath.MatchString(value) }
func setupEnsureDirectory(path string, mode os.FileMode) error {
	if !setupPath(path) {
		return ErrConfiguration
	}
	// Verify existing ancestors before MkdirAll; never traverse a symlink into an
	// unrelated filesystem directory during privileged installation.
	for at := path; ; at = filepath.Dir(at) {
		info, err := os.Lstat(at)
		if err == nil {
			if !info.IsDir() || !ownedByCurrentUserOrRoot(info) || info.Mode().Perm()&0022 != 0 && info.Mode()&os.ModeSticky == 0 {
				return ErrConfiguration
			}
			if err = safeDirectory(at); err != nil {
				return err
			}
			break
		}
		if !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	if err := os.MkdirAll(path, mode); err != nil {
		return err
	}
	return safeDirectory(path)
}
func setupExistingFile(path string, want setupFile) error {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || !ownedByCurrentUserOrRoot(info) || info.Mode().Perm() != os.FileMode(want.Mode) {
		return ErrConfiguration
	}
	b, err := safeRead(path, p.MaxBinaryBytes, false)
	if err != nil || !bytes.Equal(b, want.Data) {
		return fmt.Errorf("existing installation file conflicts: %s", filepath.Base(path))
	}
	return nil
}
func setupPublish(path string, want setupFile) error {
	if err := setupExistingFile(path, want); err != nil {
		return err
	}
	if _, err := os.Lstat(path); err == nil {
		return nil
	}
	if err := setupEnsureDirectory(filepath.Dir(path), 0755); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".setup-")
	if err != nil {
		return err
	}
	defer f.Close()
	defer os.Remove(f.Name())
	if err = f.Chmod(os.FileMode(want.Mode)); err != nil {
		return err
	}
	if _, err = f.Write(want.Data); err != nil {
		return err
	}
	if err = f.Sync(); err != nil {
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	if err = os.Link(f.Name(), path); errors.Is(err, os.ErrExist) {
		return setupExistingFile(path, want)
	} else if err != nil {
		return err
	}
	return syncDirectory(filepath.Dir(path))
}
func properties(body []byte) map[string]string {
	result := map[string]string{}
	for _, line := range strings.Split(string(body), "\n") {
		name, value, ok := strings.Cut(line, "=")
		if ok {
			result[name] = value
		}
	}
	return result
}
func (h *setupHost) inspect(ctx context.Context, c Config) (Config, p.SetupMode, map[string]setupFile, error) {
	units, err := h.run(ctx, "systemctl", "list-units", "--all", "--plain", "--no-legend", "--no-pager", "leviathan@*.service")
	if err != nil {
		return c, "", nil, err
	}
	names := map[string]bool{}
	for _, line := range strings.Split(string(units), "\n") {
		fields := strings.Fields(line)
		if len(fields) > 0 {
			if !unitPattern.MatchString(fields[0]) {
				return c, "", nil, ErrConfiguration
			}
			names[fields[0]] = true
		}
	}
	target := h.path("/usr/local/bin/leviathan")
	_, targetErr := os.Lstat(target)
	if len(names) == 0 && errors.Is(targetErr, os.ErrNotExist) {
		// systemctl exits 1 for an unmatched pattern even though the host is
		// healthy. Enumerate service files successfully, then filter locally.
		installed, err := h.run(ctx, "systemctl", "list-unit-files", "--type=service", "--no-legend", "--no-pager")
		if err != nil {
			return c, "", nil, err
		}
		for _, line := range strings.Split(string(installed), "\n") {
			fields := strings.Fields(line)
			if len(fields) > 0 && strings.HasPrefix(fields[0], "leviathan@") && strings.HasSuffix(fields[0], ".service") {
				return c, "", nil, errors.New("an unmanaged service is partially installed; reconcile it before setup")
			}
		}
		for _, base := range []string{"/etc/systemd/system", "/run/systemd/system", "/usr/lib/systemd/system", "/lib/systemd/system"} {
			entries, _ := filepath.Glob(h.path(base) + "/leviathan@*")
			if len(entries) > 0 {
				return c, "", nil, errors.New("existing service files require explicit reconciliation")
			}
		}
		var body []byte
		if _, statErr := os.Lstat(c.AgentConfigFile); errors.Is(statErr, os.ErrNotExist) {
			body = []byte("# Created by approved Leviathan host setup.\nlisten = \"127.0.0.1:1397\"\n")
		} else {
			body, err = safeRead(c.AgentConfigFile, 64<<10, false)
			if err != nil {
				return c, "", nil, err
			}
		}

		files := map[string]setupFile{c.AgentConfigFile: {body, 0600}, h.path("/etc/systemd/system/") + "/" + c.Service: {[]byte(managedMonitorUnit(c)), 0644}}
		if info, err := os.Stat(c.AgentConfigFile); err == nil {
			file := files[c.AgentConfigFile]
			file.Mode = uint32(info.Mode().Perm())
			files[c.AgentConfigFile] = file
		}
		return c, p.SetupInstall, files, nil
	}
	if targetErr != nil || len(names) != 1 {
		return c, "", nil, errors.New("setup requires one supported active service, or an empty host")
	}
	for name := range names {
		c.Service = name
	}
	b, err := h.run(ctx, "systemctl", "show", c.Service, "--property=User,ExecStart,FragmentPath,ActiveState,EnvironmentFiles,Environment,PassEnvironment,UnsetEnvironment")
	if err != nil {
		return c, "", nil, err
	}
	props := properties(b)
	user := strings.TrimSuffix(strings.TrimPrefix(c.Service, "leviathan@"), ".service")
	if props["ActiveState"] != "active" || props["User"] != user || props["FragmentPath"] == "" || props["Environment"] != "" || props["PassEnvironment"] != "" || props["UnsetEnvironment"] != "" {
		return c, "", nil, errors.New("existing service identity, state or environment is unsupported")
	}
	_, argv, ok := strings.Cut(props["ExecStart"], "argv[]=")
	if !ok {
		return c, "", nil, ErrConfiguration
	}
	argv, _, ok = strings.Cut(argv, " ;")
	if !ok {
		return c, "", nil, ErrConfiguration
	}
	words := strings.Fields(argv)
	if len(words) < 4 || words[0] != target {
		return c, "", nil, errors.New("existing service must directly execute the locally installed Leviathan")
	}
	options := map[string]string{}
	serve := 0
	for i := 1; i < len(words); i++ {
		if words[i] == "serve" {
			serve++
			continue
		}
		name, value, equals := strings.Cut(words[i], "=")
		if name != "--config" && name != "--listen" || options[name] != "" {
			return c, "", nil, errors.New("existing service has unsupported command options")
		}
		if !equals {
			i++
			if i >= len(words) {
				return c, "", nil, ErrConfiguration
			}
			value = words[i]
		}
		options[name] = value
	}
	environment := strings.TrimSpace(props["EnvironmentFiles"])
	c.AgentEnvironmentFile = ""
	if environment != "" {
		parts := strings.Fields(environment)
		if len(parts) != 2 || parts[1] != "(ignore_errors=yes)" && parts[1] != "(ignore_errors=no)" || !setupPath(parts[0]) {
			return c, "", nil, ErrConfiguration
		}
		c.AgentEnvironmentFile = parts[0]
	}
	c.AgentConfigFile = options["--config"]
	if c.AgentEnvironmentFile != "" {
		raw, err := safeRead(c.AgentEnvironmentFile, 256<<10, false)
		if err != nil {
			return c, "", nil, err
		}
		env, err := LiteralEnvironment(raw)
		if err != nil {
			return c, "", nil, err
		}
		for _, entry := range env {
			if value, ok := strings.CutPrefix(entry, "LEVIATHAN_CONFIG="); ok {
				if c.AgentConfigFile != "" && c.AgentConfigFile != value {
					return c, "", nil, ErrConfiguration
				}
				c.AgentConfigFile = value
			}
		}
	}
	if serve != 1 || !setupPath(c.AgentConfigFile) || options["--listen"] == "" {
		return c, "", nil, errors.New("existing service must register its exact TOML and loopback listener")
	}
	c.APIURL = "http://" + options["--listen"]
	if c.Validate() != nil {
		return c, "", nil, ErrConfiguration
	}
	for _, path := range []string{c.AgentConfigFile, c.AgentEnvironmentFile} {
		if path != "" {
			if strings.HasPrefix(path, "/root/") || strings.HasPrefix(path, "/home/") || strings.HasPrefix(path, "/run/user/") {
				return c, "", nil, errors.New("registered configuration is hidden by the updater sandbox")
			}
			if _, err := safeRead(path, 256<<10, false); err != nil {
				return c, "", nil, err
			}
		}
	}
	return c, p.SetupAdopt, map[string]setupFile{}, nil
}
func setupFingerprint(c Config, files map[string]setupFile) (string, error) {
	return configurationFingerprint(c, func(path string) ([]byte, error) {
		if file, ok := files[path]; ok {
			return append([]byte(nil), file.Data...), nil
		}
		return safeRead(path, 256<<10, false)
	})
}

func (h *setupHost) verify(ctx context.Context, c Config, expected p.Installation, required Probe, onVerified ...func(Probe)) error {
	service := h.service(c)
	var since, last time.Time
	announced := false
	started := time.Now()
	for time.Since(started) < h.timeLimit {
		sample, err := service.Probe(ctx)
		now := time.Now()
		if err == nil && sample.RunningSHA256 == expected.BinarySHA256 && sample.Build.Version == expected.Version && commitMatches(sample.Build.Commit, expected.Commit) && (sample.SystemAvailable || sample.GPUAvailable) && (!required.SystemAvailable || sample.SystemAvailable) && (!required.GPUAvailable || sample.GPUAvailable) && sample.SampledAt.After(now.Add(-30*time.Second)) && !sample.SampledAt.After(now.Add(5*time.Second)) {
			if !announced {
				announced = true
				required.SystemAvailable = required.SystemAvailable || sample.SystemAvailable
				required.GPUAvailable = required.GPUAvailable || sample.GPUAvailable
				for _, notify := range onVerified {
					notify(sample)
				}
			}
			if since.IsZero() {
				since = now
			}
			if sample.SampledAt.After(last) && !last.IsZero() && now.Sub(since) >= h.verifyWindow {
				return nil
			}
			if sample.SampledAt.After(last) {
				last = sample.SampledAt
			}
		} else {
			since = time.Time{}
			last = time.Time{}
		}
		if err := sleepContext(ctx, time.Second); err != nil {
			return err
		}
	}
	return errors.New("registered monitor did not verify the exact running build and fresh telemetry")
}
