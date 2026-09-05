package updater

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	p "github.com/intellisys-stevens/leviathan/internal/updateprotocol"
)

type BuildInfo struct {
	Version   string `json:"version"`
	Commit    string `json:"commit"`
	BuildDate string `json:"buildDate"`
}
type Probe struct {
	Build           BuildInfo
	SampledAt       time.Time
	SystemAvailable bool
	GPUAvailable    bool
	RunningSHA256   string
}
type Service interface {
	Build(context.Context, string) (BuildInfo, error)
	Platform(context.Context) (string, string, string, error)
	Preflight(context.Context, string) error
	Restart(context.Context) error
	Probe(context.Context) (Probe, error)
}
type SystemdService struct {
	config Config
	http   *http.Client
}

func NewSystemdService(c Config) *SystemdService {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.Proxy = nil
	return &SystemdService{config: c, http: &http.Client{Transport: tr, Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}

type boundedBuffer struct {
	bytes.Buffer
	max int
}

func (b *boundedBuffer) Write(s []byte) (int, error) {
	if len(s) > b.max-b.Len() {
		return 0, errors.New("bounded command output exceeded")
	}
	return b.Buffer.Write(s)
}
func commandOutput(ctx context.Context, path string, args []string, env []string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, args...)
	cmd.Env = env
	output := &boundedBuffer{max: 64 << 10}
	cmd.Stdout = output
	cmd.Stderr = io.Discard
	if e := cmd.Run(); e != nil {
		return nil, errors.New("local updater command failed")
	}
	return output.Bytes(), nil
}
func (s *SystemdService) Build(ctx context.Context, path string) (BuildInfo, error) {
	var v BuildInfo
	b, e := commandOutput(ctx, path, []string{"version", "--format", "json"}, []string{"PATH=/usr/bin:/bin", "HOME=/nonexistent"})
	if e != nil || p.DecodeStrict(bytes.NewReader(b), 64<<10, &v) != nil || v.Version == "" || v.Commit == "" {
		return v, ErrConfiguration
	}
	return v, nil
}
func (s *SystemdService) Platform(ctx context.Context) (string, string, string, error) {
	if runtime.GOOS != "linux" {
		return "", "", "", ErrConfiguration
	}
	b, e := commandOutput(ctx, "/usr/bin/getconf", []string{"GNU_LIBC_VERSION"}, []string{"PATH=/usr/bin:/bin"})
	glibc := strings.TrimSpace(strings.TrimPrefix(string(b), "glibc "))
	if e != nil || !p.GlibcAtLeast(glibc, "2.34") {
		return "", "", "", ErrConfiguration
	}
	return "linux", runtime.GOARCH, glibc, nil
}

// LiteralEnvironment accepts the deliberately small systemd EnvironmentFile
// subset used by the packaged service. Unsupported quoting/continuations fail
// closed instead of running a shell or guessing how systemd would interpret it.
func LiteralEnvironment(body []byte) ([]string, error) {
	var result []string
	for _, line := range strings.Split(string(body), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, ";") {
			continue
		}
		name, value, ok := strings.Cut(line, "=")
		if !ok || !strings.HasPrefix(name, "LEVIATHAN_") {
			return nil, ErrConfiguration
		}
		for _, ch := range name {
			if !(ch == '_' || ch >= 'A' && ch <= 'Z' || ch >= '0' && ch <= '9') {
				return nil, ErrConfiguration
			}
		}
		value = strings.TrimSpace(value)
		if strings.ContainsAny(value, "\\\r\x00") {
			return nil, ErrConfiguration
		}
		if strings.HasPrefix(value, "\"") || strings.HasPrefix(value, "'") {
			if len(value) < 2 || value[len(value)-1] != value[0] || strings.ContainsRune(value[1:len(value)-1], rune(value[0])) {
				return nil, ErrConfiguration
			}
			value = value[1 : len(value)-1]
		} else if strings.ContainsAny(value, "\"'") {
			return nil, ErrConfiguration
		}
		result = append(result, name+"="+value)
	}
	return result, nil
}
func (s *SystemdService) Preflight(ctx context.Context, binary string) error {
	env := []string{"PATH=/usr/bin:/bin", "HOME=/nonexistent", "XDG_CONFIG_HOME=/nonexistent"}
	if s.config.AgentEnvironmentFile != "" {
		b, e := safeRead(s.config.AgentEnvironmentFile, 256<<10, false)
		if e != nil {
			return e
		}
		entries, e := LiteralEnvironment(b)
		clear(b)
		if e != nil {
			return e
		}
		for _, entry := range entries {
			if strings.HasPrefix(entry, "LEVIATHAN_CONFIG=") && strings.TrimPrefix(entry, "LEVIATHAN_CONFIG=") != s.config.AgentConfigFile {
				return ErrConfiguration
			}
		}
		env = append(env, entries...)
	}
	args := []string{"config-check"}
	if s.config.AgentConfigFile != "" {
		args = append([]string{"--config", s.config.AgentConfigFile}, args...)
	}
	b, e := commandOutput(ctx, binary, args, env)
	if e != nil {
		return e
	}
	var out struct {
		Valid         bool   `json:"valid"`
		ConfigProfile string `json:"configProfile"`
		StateProfile  string `json:"stateProfile"`
	}
	if p.DecodeStrict(bytes.NewReader(b), 64<<10, &out) != nil || !out.Valid || out.ConfigProfile != p.ConfigProfile || out.StateProfile != p.StateProfile {
		return ErrConfiguration
	}
	return nil
}
func (s *SystemdService) Restart(ctx context.Context) error {
	if !unitPattern.MatchString(s.config.Service) {
		return ErrConfiguration
	}
	_, e := commandOutput(ctx, "/usr/bin/systemctl", []string{"restart", s.config.Service}, []string{"PATH=/usr/bin:/bin"})
	return e
}
func (s *SystemdService) Probe(ctx context.Context) (Probe, error) {
	var out Probe
	pidBytes, e := commandOutput(ctx, "/usr/bin/systemctl", []string{"show", s.config.Service, "--property=MainPID", "--value"}, []string{"PATH=/usr/bin:/bin"})
	if e != nil {
		return out, e
	}
	pid, e := strconv.ParseUint(strings.TrimSpace(string(pidBytes)), 10, 32)
	if e != nil || pid < 1 {
		return out, ErrConfiguration
	}
	// Read the executable of the live process, not merely the new symlink. This
	// detects a restart that left the old process serving its old build.
	f, e := os.Open(filepath.Join("/proc", strconv.FormatUint(pid, 10), "exe"))
	if e != nil {
		return out, e
	}
	h := sha256.New()
	n, e := io.Copy(h, io.LimitReader(f, p.MaxBinaryBytes+1))
	f.Close()
	if e != nil || n < 1 || n > p.MaxBinaryBytes {
		return out, ErrConfiguration
	}
	out.RunningSHA256 = hex.EncodeToString(h.Sum(nil))
	if e = s.getJSON(ctx, "/api/v1/version", &out.Build); e != nil {
		return out, e
	}
	var health struct {
		Status    string    `json:"status"`
		SampledAt time.Time `json:"sampledAt"`
		Domains   struct {
			System struct {
				Available bool `json:"available"`
			} `json:"system"`
			GPU struct {
				Available bool `json:"available"`
			} `json:"gpu"`
		} `json:"domains"`
	}
	if e = s.getJSON(ctx, "/healthz", &health); e != nil {
		return out, e
	}
	if health.Status != "ok" && health.Status != "degraded" {
		return out, ErrConfiguration
	}
	out.SampledAt = health.SampledAt
	out.SystemAvailable = health.Domains.System.Available
	out.GPUAvailable = health.Domains.GPU.Available
	if !out.SystemAvailable && !out.GPUAvailable {
		return out, ErrConfiguration
	}
	return out, nil
}
func (s *SystemdService) getJSON(ctx context.Context, path string, target any) error {
	r, e := http.NewRequestWithContext(ctx, http.MethodGet, s.config.APIURL+path, nil)
	if e != nil {
		return e
	}
	resp, e := s.http.Do(r)
	if e != nil {
		return e
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return ErrConfiguration
	}
	body, e := io.ReadAll(io.LimitReader(resp.Body, 64<<10+1))
	if e != nil || len(body) > 64<<10 {
		return ErrConfiguration
	}
	return json.Unmarshal(body, target)
}
