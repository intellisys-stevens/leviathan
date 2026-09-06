// Package updater implements the one-purpose, independently supervised host
// update transaction. Configuration is local and root-owned; no remote message
// can select a filesystem path, service name or executable command.
package updater

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	p "github.com/intellisys-stevens/leviathan/internal/updateprotocol"
)

const configSchema = "leviathan-updater-config-v1"

var ErrConfiguration = errors.New("invalid or unsafe updater configuration")
var ErrRecoveryRequired = errors.New("update recovery requires operator intervention")
var unitPattern = regexp.MustCompile(`^leviathan@[a-zA-Z0-9_][a-zA-Z0-9_-]{0,63}\.service$`)

type Config struct {
	Schema                 string       `json:"schema"`
	ControlPlaneURL        string       `json:"controlPlaneURL"`
	Machine                p.MachineKey `json:"machine"`
	RootDirectory          string       `json:"rootDirectory"`
	StateDirectory         string       `json:"stateDirectory"`
	Service                string       `json:"service"`
	APIURL                 string       `json:"apiURL"`
	AgentConfigFile        string       `json:"agentConfigFile"`
	AgentEnvironmentFile   string       `json:"agentEnvironmentFile"`
	TrustedReleaseKeyFiles []string     `json:"trustedReleaseKeyFiles"`
	CredentialDirectory    string       `json:"credentialDirectory,omitempty"`
}

func LoadConfig(path string) (Config, error) {
	var c Config
	b, e := safeRead(path, 64<<10, true)
	if e != nil {
		return c, ErrConfiguration
	}
	if p.DecodeStrict(bytes.NewReader(b), 64<<10, &c) != nil || c.Validate() != nil {
		return c, ErrConfiguration
	}
	return c, nil
}
func (c Config) Validate() error {
	origin, e := url.Parse(c.ControlPlaneURL)
	if e != nil || origin.Scheme != "https" || origin.Host == "" || origin.User != nil || origin.Path != "" || origin.RawQuery != "" || origin.Fragment != "" || origin.RawPath != "" || origin.ForceQuery {
		return ErrConfiguration
	}
	api, e := url.Parse(c.APIURL)
	if e != nil || api.Scheme != "http" || api.User != nil || api.Path != "" || api.RawQuery != "" || api.Fragment != "" || api.RawPath != "" || api.ForceQuery {
		return ErrConfiguration
	}
	ip := net.ParseIP(api.Hostname())
	if ip == nil || !ip.IsLoopback() {
		return ErrConfiguration
	}
	if c.AgentConfigFile == "" || c.Schema != configSchema || !c.Machine.Valid() || !unitPattern.MatchString(c.Service) || !safeAbsolute(c.RootDirectory) || !safeAbsolute(c.StateDirectory) || c.RootDirectory == c.StateDirectory || len(c.TrustedReleaseKeyFiles) < 1 || len(c.TrustedReleaseKeyFiles) > 8 {
		return ErrConfiguration
	}
	for _, s := range []string{c.RootDirectory, c.StateDirectory} {
		if s == "/" || s == "/opt" || s == "/var" || s == "/usr" || s == "/etc" || s == "/var/lib" || strings.HasPrefix(s, "/proc/") || strings.HasPrefix(s, "/sys/") || strings.HasPrefix(s, "/dev/") {
			return ErrConfiguration
		}
	}
	for _, s := range append([]string{c.AgentConfigFile, c.AgentEnvironmentFile, c.CredentialDirectory}, c.TrustedReleaseKeyFiles...) {
		if s != "" && !safeAbsolute(s) {
			return ErrConfiguration
		}
	}
	return nil
}
func safeAbsolute(s string) bool {
	return filepath.IsAbs(s) && filepath.Clean(s) == s && !strings.ContainsAny(s, "\x00\r\n")
}

func LoadReleaseKeys(paths []string) (map[string]ed25519.PublicKey, error) {
	keys := make(map[string]ed25519.PublicKey)
	for _, path := range paths {
		b, e := safeRead(path, 16<<10, false)
		if e != nil {
			return nil, ErrConfiguration
		}
		block, rest := pem.Decode(b)
		if block == nil || block.Type != "PUBLIC KEY" || len(block.Headers) != 0 || len(bytes.TrimSpace(rest)) != 0 {
			return nil, ErrConfiguration
		}
		parsed, e := x509.ParsePKIXPublicKey(block.Bytes)
		key, ok := parsed.(ed25519.PublicKey)
		if e != nil || !ok || len(key) != ed25519.PublicKeySize {
			return nil, ErrConfiguration
		}
		id := p.KeyID(key)
		if _, exists := keys[id]; exists {
			return nil, ErrConfiguration
		}
		keys[id] = key
	}
	if len(keys) == 0 {
		return nil, ErrConfiguration
	}
	return keys, nil
}

// ConfigurationFingerprint binds both local configuration sources, including
// their presence and paths, without putting their contents on the wire.
func ConfigurationFingerprint(c Config) (string, error) {
	return configurationFingerprint(c, func(path string) ([]byte, error) { return safeRead(path, 256<<10, false) })
}
func configurationFingerprint(c Config, read func(string) ([]byte, error)) (string, error) {
	h := sha256.New()
	for _, path := range []string{c.AgentConfigFile, c.AgentEnvironmentFile} {
		_, _ = fmt.Fprintf(h, "%d:%s\n", len(path), path)
		if path == "" {
			continue
		}
		body, e := read(path)
		if e != nil {
			return "", e
		}
		_, _ = fmt.Fprintf(h, "%d:", len(body))
		_, _ = h.Write(body)
		_, _ = h.Write([]byte{0})
		clear(body)
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func prepareDirectories(c Config) error {
	for _, dir := range []string{c.RootDirectory, c.StateDirectory, filepath.Join(c.RootDirectory, "releases")} {
		mode := os.FileMode(0755)
		if dir == c.StateDirectory {
			mode = 0700
		}
		if e := os.MkdirAll(dir, mode); e != nil {
			return e
		}
		if e := safeDirectory(dir); e != nil {
			return e
		}
		if e := os.Chmod(dir, mode); e != nil {
			return e
		}
	}
	if c.CredentialDirectory != "" {
		if e := os.MkdirAll(c.CredentialDirectory, 0700); e != nil {
			return e
		}
		if e := safeDirectory(c.CredentialDirectory); e != nil {
			return e
		}
		if info, e := os.Stat(c.CredentialDirectory); e != nil || info.Mode().Perm()&0077 != 0 {
			return ErrConfiguration
		}
	}
	return nil
}

func (c Config) credentialDirectory() string {
	if c.CredentialDirectory != "" {
		return c.CredentialDirectory
	}
	return c.StateDirectory
}
