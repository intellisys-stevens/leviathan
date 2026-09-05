package updater

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"

	p "github.com/intellisys-stevens/leviathan/internal/updateprotocol"
)

// ReleasePublicKeys contains only independently provisioned PUBLIC release
// roots. Protected release builds supply comma-separated raw-base64 Ed25519
// keys with ldflags. Development builds cannot silently invent a trust root.
var ReleasePublicKeys string

type SetupOptions struct {
	Version, Commit, ArchiveURL, ArchiveSHA256, InstallDirectory, ControlOrigin string
	TicketStdin, WithoutUpdater                                                 bool
	host                                                                        *setupHost // only same-package fixtures can select an isolated filesystem
	http                                                                        *http.Client
	keys                                                                        map[string]ed25519.PublicKey
}
type setupRecord struct {
	Schema           string                 `json:"schema"`
	Origin           string                 `json:"origin"`
	TicketSHA256     string                 `json:"ticketSha256"`
	ReleaseVersion   string                 `json:"releaseVersion"`
	ReleaseCommit    string                 `json:"releaseCommit"`
	Receipt          *p.SetupRedeemResponse `json:"receipt,omitempty"`
	Config           Config                 `json:"config"`
	MachineBound     bool                   `json:"machineBound,omitempty"`
	Mode             p.SetupMode            `json:"mode,omitempty"`
	Installation     p.Installation         `json:"installation"`
	Files            map[string]setupFile   `json:"files,omitempty"`
	UpdaterSHA256    string                 `json:"updaterSha256,omitempty"`
	Complete         bool                   `json:"complete"`
	RecoveryRequired bool                   `json:"recoveryRequired,omitempty"`
	Started          bool                   `json:"started"`
	InstallBefore    time.Time              `json:"installBefore"`
	Authorized       bool                   `json:"authorized"`
	RequiredSystem   bool                   `json:"requiredSystem"`
	RequiredGPU      bool                   `json:"requiredGPU"`
	Report           *p.SetupReportRequest  `json:"report,omitempty"`
}
type setupFile struct {
	Data []byte `json:"data"`
	Mode uint32 `json:"mode"`
}

func embeddedReleaseKeys() (map[string]ed25519.PublicKey, error) {
	keys := map[string]ed25519.PublicKey{}
	for _, value := range strings.Split(ReleasePublicKeys, ",") {
		raw, err := base64.RawStdEncoding.DecodeString(value)
		if err != nil || len(raw) != ed25519.PublicKeySize {
			return nil, errors.New("this updater has no valid embedded release trust roots")
		}
		key := ed25519.PublicKey(raw)
		if _, exists := keys[p.KeyID(key)]; exists {
			return nil, ErrConfiguration
		}
		keys[p.KeyID(key)] = key
	}
	if len(keys) == 0 || len(keys) > 8 {
		return nil, ErrConfiguration
	}
	return keys, nil
}
func setupHTTP(base *http.Client, redirects bool) *http.Client {
	result := &http.Client{Timeout: 2 * time.Minute}
	if base != nil {
		*result = *base
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	if existing, ok := result.Transport.(*http.Transport); ok {
		transport = existing.Clone()
	}
	transport.Proxy = nil
	if transport.TLSClientConfig == nil {
		transport.TLSClientConfig = &tls.Config{}
	} else {
		transport.TLSClientConfig = transport.TLSClientConfig.Clone()
	}
	transport.TLSClientConfig.MinVersion = tls.VersionTLS13
	transport.ResponseHeaderTimeout = 10 * time.Second
	result.Transport = transport
	result.Jar = nil
	result.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if !redirects || len(via) > 5 || req.URL.Scheme != "https" || req.URL.User != nil {
			return http.ErrUseLastResponse
		}
		return nil
	}
	return result
}
func setupURL(value string, origin bool) error {
	u, err := url.Parse(value)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.RawPath != "" || u.ForceQuery || origin && u.Path != "" {
		return ErrConfiguration
	}
	return nil
}
func Setup(ctx context.Context, opts SetupOptions, stdin io.Reader, stdout io.Writer) error {
	if !p.StableVersion(opts.Version) || len(opts.Commit) != 40 || !p.IsDigest(opts.Commit+strings.Repeat("0", 24)) || !p.IsDigest(opts.ArchiveSHA256) || setupURL(opts.ArchiveURL, false) != nil {
		return errors.New("setup requires the exact release-specific installer metadata")
	}
	if opts.ControlOrigin != "" && (setupURL(opts.ControlOrigin, true) != nil || !opts.TicketStdin || opts.WithoutUpdater || opts.InstallDirectory != "") || opts.ControlOrigin == "" && opts.TicketStdin {
		return errors.New("managed setup requires a control origin and ticket on stdin; standalone installation options cannot be combined")
	}
	keys := opts.keys
	var err error
	if len(keys) == 0 {
		keys, err = embeddedReleaseKeys()
		if err != nil {
			return err
		}
	}
	host := opts.host
	if host == nil && runtime.GOOS != "linux" {
		return errors.New("Leviathan setup requires Linux")
	}
	if host == nil {
		host = newSetupHost()
	}
	if opts.ControlOrigin == "" {
		return standaloneSetup(ctx, opts, keys, host, stdout)
	}
	if opts.host == nil && (runtime.GOOS != "linux" || os.Geteuid() != 0) {
		return errors.New("managed setup must run as root on the intended Linux host")
	}
	return managedSetup(ctx, opts, keys, host, stdin, stdout)
}
func fetchSetup(ctx context.Context, client *http.Client, address string, maximum int64) ([]byte, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, address, nil)
	if err != nil {
		return nil, ErrControl
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, ErrControl
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || response.ContentLength > maximum {
		return nil, ErrControl
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maximum+1))
	if err != nil || int64(len(body)) > maximum {
		return nil, ErrControl
	}
	return body, nil
}
func setupManifest(signed p.SignedManifest, opts SetupOptions, keys map[string]ed25519.PublicKey, architecture string) (p.Manifest, error) {
	m, err := p.VerifyManifest(signed, keys)
	if err != nil || m.Version != opts.Version || m.Commit != opts.Commit || m.ArchiveSHA256 != opts.ArchiveSHA256 || m.Arch != architecture || m.OS != "linux" || m.MinimumUpdater > p.ProtocolVersion || m.ConfigProfile != p.ConfigProfile || m.StateProfile != p.StateProfile {
		return m, errors.New("release signature or pinned build metadata mismatch")
	}
	return m, nil
}
func stagedSetupBinary(reader io.Reader, dir string, m p.Manifest) (string, error) {
	archive, err := os.CreateTemp(dir, ".setup-archive-")
	if err != nil {
		return "", err
	}
	defer os.Remove(archive.Name())
	defer archive.Close()
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(archive, h), io.LimitReader(reader, m.ArchiveBytes+1))
	if err != nil || n != m.ArchiveBytes || hex.EncodeToString(h.Sum(nil)) != m.ArchiveSHA256 {
		return "", errors.New("setup archive digest mismatch")
	}
	if _, err = archive.Seek(0, io.SeekStart); err != nil {
		return "", err
	}
	target := filepath.Join(dir, "leviathan")
	if err = extractBinary(archive, target, m); err != nil {
		return "", err
	}
	return target, nil
}
func refuseManagedBinary(path string) error {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return errors.New("installer refuses executable symlinks; use Yggdrasil for a managed installation")
	}
	if !info.Mode().IsRegular() || !ownedByCurrentUserOrRoot(info) || info.Mode().Perm()&0022 != 0 {
		return ErrConfiguration
	}
	return nil
}
func standaloneSetup(ctx context.Context, opts SetupOptions, keys map[string]ed25519.PublicKey, host *setupHost, stdout io.Writer) error {
	directory := opts.InstallDirectory
	if directory == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return err
		}
		directory = filepath.Join(home, ".local/bin")
	}
	if !safeAbsolute(directory) {
		return ErrConfiguration
	}
	for _, name := range []string{"leviathan", "leviathan-updater"} {
		if err := refuseManagedBinary(filepath.Join(directory, name)); err != nil {
			return err
		}
	}
	if err := os.MkdirAll(directory, 0755); err != nil {
		return err
	}
	if err := safeDirectory(directory); err != nil {
		return err
	}
	unlock, err := lockState(filepath.Join(directory, ".leviathan-setup.lock"))
	if err != nil {
		return err
	}
	defer unlock()
	client := setupHTTP(opts.http, true)
	defer client.CloseIdleConnections()
	if !strings.HasSuffix(opts.ArchiveURL, ".tar.gz") {
		return ErrConfiguration
	}
	body, err := fetchSetup(ctx, client, strings.TrimSuffix(opts.ArchiveURL, ".tar.gz")+".manifest.json", p.MaxBodyBytes)
	if err != nil {
		return err
	}
	var signed p.SignedManifest
	if p.DecodeStrict(bytes.NewReader(body), p.MaxBodyBytes, &signed) != nil {
		return ErrConfiguration
	}
	m, err := setupManifest(signed, opts, keys, host.arch)
	if err != nil {
		return err
	}
	if err = host.compatible(ctx, m); err != nil {
		return err
	}
	free, err := availableBytes(directory)
	if err != nil || free < uint64(m.ArchiveBytes+m.BinaryBytes)+(64<<20) {
		return errors.New("insufficient setup disk space")
	}
	stage, err := os.MkdirTemp(directory, ".leviathan-setup-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(stage)
	request, _ := http.NewRequestWithContext(ctx, http.MethodGet, opts.ArchiveURL, nil)
	response, err := client.Do(request)
	if err != nil {
		return ErrControl
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return ErrControl
	}
	binary, err := stagedSetupBinary(response.Body, stage, m)
	if err != nil {
		return err
	}
	build, err := host.build(ctx, binary)
	if err != nil || build.Version != m.Version || build.Commit != m.Commit {
		return errors.New("setup executable build mismatch")
	}
	target := filepath.Join(directory, "leviathan")
	if _, err = os.Lstat(target); err == nil {
		old, readErr := host.build(ctx, target)
		if readErr != nil {
			return errors.New("existing executable build cannot be safely identified")
		}
		if old.Version != m.Version && !p.NewerStable(m.Version, old.Version) {
			return errors.New("installer will not downgrade an existing build")
		}
	}
	files := map[string]setupFile{}
	data, err := safeRead(binary, p.MaxBinaryBytes, false)
	if err != nil {
		return err
	}
	files[target] = setupFile{data, 0755}
	if !opts.WithoutUpdater {
		self, err := host.executable()
		if err != nil {
			return err
		}
		data, err = safeRead(self, p.MaxBinaryBytes, false)
		if err != nil {
			return err
		}
		files[filepath.Join(directory, "leviathan-updater")] = setupFile{data, 0755}
	}
	// Every input was verified before either executable changes. Restore prior
	// bytes if an atomic replacement fails halfway through the two-file install.
	previous := map[string][]byte{}
	modes := map[string]os.FileMode{}
	for path := range files {
		if err = refuseManagedBinary(path); err != nil {
			return err
		}
		if info, e := os.Stat(path); e == nil {
			data, e := safeRead(path, p.MaxBinaryBytes, false)
			if e != nil {
				return e
			}
			previous[path] = data
			modes[path] = info.Mode().Perm()
		}
	}
	var installed []string
	for _, path := range sortedSetupFiles(files) {
		file := files[path]
		if err = atomicBytes(path, file.Data, os.FileMode(file.Mode)); err != nil {
			for _, oldPath := range installed {
				if old, ok := previous[oldPath]; ok {
					_ = atomicBytes(oldPath, old, modes[oldPath])
				} else {
					_ = removeDurable(oldPath)
				}
			}
			return err
		}
		installed = append(installed, path)
	}
	_, err = fmt.Fprintf(stdout, "Installed Leviathan %s%s in %s.\n", m.Version, map[bool]string{true: "", false: " and leviathan-updater"}[opts.WithoutUpdater], directory)
	return err
}
func sortedSetupFiles(files map[string]setupFile) []string {
	names := make([]string, 0, len(files))
	for name := range files {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func managedSetup(ctx context.Context, opts SetupOptions, keys map[string]ed25519.PublicKey, h *setupHost, stdin io.Reader, stdout io.Writer) (result error) {
	ticket, err := io.ReadAll(io.LimitReader(stdin, 513))
	if err != nil || len(ticket) > 512 {
		return errors.New("setup ticket must be supplied privately on stdin")
	}
	defer clear(ticket)
	token := strings.TrimSpace(string(ticket))
	if len(token) < 16 || len(token) > 256 {
		return errors.New("setup ticket must be supplied privately on stdin")
	}
	ticketHash := sha256.Sum256([]byte(token))
	ticketDigest := hex.EncodeToString(ticketHash[:])
	if err = setupEnsureDirectory(h.path("/run"), 0755); err != nil {
		return err
	}
	unlock, err := lockState(h.path("/run/leviathan-bootstrap.lock"))
	if err != nil {
		return errors.New("another host installer is active or its lock is unsafe")
	}
	defer unlock()
	state := h.path("/var/lib/leviathan-updater")
	recordPath := filepath.Join(state, "setup.json")
	var record setupRecord
	err = readSetupRecord(recordPath, &record)
	if _, statErr := os.Lstat(recordPath); errors.Is(statErr, os.ErrNotExist) {
		if _, configErr := os.Lstat(h.path("/etc/leviathan-updater/config.json")); !errors.Is(configErr, os.ErrNotExist) {
			return errors.New("host already has managed updater configuration; use its existing Yggdrasil update workflow")
		}
		secrets := os.Getenv("CODEX_SECRETS_DIR")
		if secrets == "" {
			secrets = filepath.Join(state, "secrets")
		}
		if !setupPath(secrets) || strings.HasPrefix(secrets, "/root/") || strings.HasPrefix(secrets, "/home/") || strings.HasPrefix(secrets, "/run/user/") {
			return errors.New("CODEX_SECRETS_DIR must be a private root-owned directory visible to the updater service")
		}
		if err = setupEnsureDirectory(secrets, 0700); err != nil {
			return err
		}
		info, err := os.Stat(secrets)
		if err != nil || info.Mode().Perm()&0077 != 0 {
			return errors.New("CODEX_SECRETS_DIR must have mode 0700")
		}
		c := Config{Schema: configSchema, ControlPlaneURL: opts.ControlOrigin, Machine: p.MachineKey{PlatformID: "setup", ScopeID: "pending", MachineID: "pending"}, RootDirectory: h.path("/opt/leviathan"), StateDirectory: state, CredentialDirectory: secrets, Service: "leviathan@root.service", APIURL: "http://127.0.0.1:1397", AgentConfigFile: h.path("/etc/leviathan/config.toml")}
		ids := make([]string, 0, len(keys))
		for id := range keys {
			ids = append(ids, id)
		}
		sort.Strings(ids)
		for _, id := range ids {
			c.TrustedReleaseKeyFiles = append(c.TrustedReleaseKeyFiles, h.path("/etc/leviathan-updater/release-"+id+".pem"))
		}
		if c.Validate() != nil {
			return ErrConfiguration
		}
		record = setupRecord{Schema: "leviathan-setup-v1", Origin: opts.ControlOrigin, TicketSHA256: ticketDigest, ReleaseVersion: opts.Version, ReleaseCommit: opts.Commit, Config: c}
		if err = setupEnsureDirectory(state, 0700); err != nil {
			return err
		}
		if err = atomicJSON(recordPath, record); err != nil {
			return err
		}
	} else if err != nil {
		return errors.New("retained setup state is invalid; operator recovery is required")
	}
	if record.Schema != "leviathan-setup-v1" || record.Origin != opts.ControlOrigin || record.Config.Validate() != nil {
		return errors.New("setup inputs differ from the retained host transaction")
	}
	client, err := NewClient(record.Config, opts.http)
	if err != nil {
		return err
	}
	defer client.Close()
	if record.TicketSHA256 != ticketDigest {
		if err = replaceUnstartedSetupTicket(ctx, h, client, &record, recordPath, opts, ticketDigest); err != nil {
			return err
		}
	}
	if record.ReleaseVersion != opts.Version || record.ReleaseCommit != opts.Commit {
		return errors.New("setup release differs from the retained host transaction")
	}
	if record.Receipt == nil {
		pending := filepath.Join(record.Config.credentialDirectory(), "setup-identity.json")
		var value identity
		if err = readJSON(pending, &value); errors.Is(err, os.ErrNotExist) {
			_, private, err := ed25519.GenerateKey(rand.Reader)
			if err != nil {
				return err
			}
			defer clear(private)
			csr, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{}, private)
			if err != nil {
				return err
			}
			value = identity{PrivateKey: base64.RawStdEncoding.EncodeToString(private), CSRPEM: string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: csr}))}
			if err = atomicJSON(pending, value); err != nil {
				return err
			}
		} else if err != nil {
			return ErrIdentity
		}
		receipt, err := client.SetupRedeem(ctx, p.SetupRedeemRequest{Ticket: token, CSRPEM: value.CSRPEM, Arch: h.arch})
		if err != nil {
			return err
		}
		if _, err = setupManifest(receipt.Release, opts, keys, h.arch); err != nil {
			return err
		}
		if record.MachineBound && receipt.Machine != record.Config.Machine {
			return errors.New("replacement setup ticket names a different host")
		}
		record.Config.Machine = receipt.Machine
		client.config = record.Config
		if _, err = client.validateCertificate(value, receipt.Certificate); err != nil {
			return err
		}
		record.Receipt = &receipt
		record.MachineBound = true
		// Persist the machine and receipt before its credential. A crash may
		// recreate that credential from this exact receipt and retained CSR key.
		if err = atomicJSON(recordPath, record); err != nil {
			return err
		}
		if err = client.saveCertificate(value, receipt.Certificate); err != nil {
			return err
		}
	} else {
		client.config = record.Config
		if err = restoreSetupIdentity(client, record); err != nil {
			return err
		}
	}
	if record.RecoveryRequired {
		_ = client.reconcileSetupRecord(ctx, recordPath, &record)
		return ErrRecoveryRequired
	}
	if record.Complete {
		reportErr := client.reconcileSetupRecord(ctx, recordPath, &record)
		if _, err = h.run(ctx, "systemctl", "enable", "--now", "leviathan-updater.service"); err != nil {
			return err
		}
		if reportErr != nil {
			_, err = fmt.Fprintln(stdout, "Leviathan and its updater are already installed. The updater will retry result reporting.")
			return err
		}
		_, err = fmt.Fprintln(stdout, "Leviathan and its updater are already installed; the current running release was preserved.")
		return err
	}
	defer func() {
		if result != nil && record.Authorized && !record.Complete && !record.RecoveryRequired {
			record.RecoveryRequired = true
			record.Report = &p.SetupReportRequest{SetupID: record.Receipt.SetupID, Status: p.SetupRecoveryRequired, Installation: record.Installation, Code: "interrupted_setup_requires_recovery"}
			_ = atomicJSON(recordPath, record)
			_ = client.reconcileSetupRecord(ctx, recordPath, &record)
			result = fmt.Errorf("%w: %v", ErrRecoveryRequired, result)
		}
	}()
	m, err := setupManifest(record.Receipt.Release, opts, keys, h.arch)
	if err != nil {
		return err
	}
	if err = h.compatible(ctx, m); err != nil {
		return err
	}
	if record.Mode == "" {
		c, mode, files, err := h.inspect(ctx, record.Config)
		if err != nil {
			return err
		}
		record.Config = c
		record.Mode = mode
		record.Files = files
		client.config = c
		for path, file := range managedSetupUnits(h, c) {
			record.Files[path] = file
		}
		for _, path := range c.TrustedReleaseKeyFiles {
			id := strings.TrimSuffix(strings.TrimPrefix(filepath.Base(path), "release-"), ".pem")
			der, err := x509.MarshalPKIXPublicKey(keys[id])
			if err != nil {
				return err
			}
			record.Files[path] = setupFile{pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}), 0644}
		}
		raw, _ := json.MarshalIndent(c, "", "  ")
		record.Files[h.path("/etc/leviathan-updater/config.json")] = setupFile{append(raw, '\n'), 0600}
		self, err := h.executable()
		if err != nil {
			return err
		}
		record.UpdaterSHA256, err = binaryDigest(self)
		if err != nil {
			return err
		}

		if err = atomicJSON(recordPath, record); err != nil {
			return err
		}
	}
	c := record.Config
	self, err := h.executable()
	if err != nil {
		return err
	}
	selfDigest, err := binaryDigest(self)
	if err != nil || selfDigest != record.UpdaterSHA256 {
		return errors.New("setup updater differs from the retained installation transaction")
	}
	selfData, err := safeRead(self, p.MaxBinaryBytes, false)
	if err != nil {
		return err
	}
	updaterFile := setupFile{selfData, 0755}
	if err = setupExistingFile(h.path("/usr/local/bin/leviathan-updater"), updaterFile); err != nil {
		return err
	}
	if record.Mode == p.SetupInstall {
		target := h.path("/usr/local/bin/leviathan")
		if info, e := os.Lstat(target); e == nil {
			link, linkErr := os.Readlink(target)
			if info.Mode()&os.ModeSymlink == 0 || linkErr != nil || link != filepath.Join(c.RootDirectory, "current/leviathan") || !ownedByCurrentUserOrRoot(info) {
				return errors.New("fresh setup refuses a changed local monitor executable")
			}
		} else if !errors.Is(e, os.ErrNotExist) {
			return e
		}
	}
	for path, file := range record.Files {
		if !setupPath(path) {
			return ErrConfiguration
		}
		if err = setupExistingFile(path, file); err != nil {
			return err
		}
	}
	if err = setupEnsureDirectory(h.path("/run/leviathan-setup"), 0700); err != nil {
		return err
	}
	stage, err := os.MkdirTemp(h.path("/run/leviathan-setup"), ".release-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(stage)
	free, err := availableBytes(stage)
	if err != nil || free < uint64(m.ArchiveBytes+m.BinaryBytes)+(64<<20) {
		return errors.New("insufficient setup staging disk space")
	}
	binary := filepath.Join(c.StateDirectory, "setup-candidate")
	if _, candidateErr := os.Lstat(binary); errors.Is(candidateErr, os.ErrNotExist) {
		if record.Authorized {
			record.RecoveryRequired = true
			return errors.New("authorized setup lost its verified candidate; operator recovery is required")
		}
		reader, err := client.SetupArtifact(ctx, p.SetupArtifactRequest{SetupID: record.Receipt.SetupID, ArchiveSHA256: m.ArchiveSHA256})
		if err != nil {
			return err
		}
		temporary, err := stagedSetupBinary(reader, stage, m)
		reader.Close()
		if err != nil {
			return err
		}
		data, err := safeRead(temporary, p.MaxBinaryBytes, false)
		if err != nil {
			return err
		}
		if err = setupPublish(binary, setupFile{data, 0755}); err != nil {
			return err
		}
	} else if candidateErr != nil {
		return candidateErr
	}
	cachedDigest, err := binaryDigest(binary)
	if err != nil || cachedDigest != m.BinarySHA256 {
		return errors.New("cached setup candidate differs from the signed release")
	}

	build, err := h.build(ctx, binary)
	if err != nil || build.Version != m.Version || build.Commit != m.Commit {
		return errors.New("setup candidate build mismatch")
	}
	checkConfig := c
	if record.Mode == p.SetupInstall {
		stagedConfig := filepath.Join(stage, "config.toml")
		if err = atomicBytes(stagedConfig, record.Files[c.AgentConfigFile].Data, 0600); err != nil {
			return err
		}
		checkConfig.AgentConfigFile = stagedConfig
	}
	if err = h.service(checkConfig).Preflight(ctx, binary); err != nil {
		return errors.New("candidate does not accept the retained local configuration")
	}
	baseline := binary
	if record.Mode == p.SetupAdopt {
		baseline = h.path("/usr/local/bin/leviathan")
		if target, e := os.Readlink(baseline); e == nil {
			if target != filepath.Join(c.RootDirectory, "current/leviathan") {
				return ErrConfiguration
			}
			resolved, e := filepath.EvalSymlinks(baseline)
			if e != nil {
				return e
			}
			baseline = resolved
		}
	}
	installed, err := inspectSetupBaseline(ctx, h, c, record.Files, baseline)
	if err != nil {
		return err
	}
	if record.Mode == p.SetupInstall && (installed.Version != m.Version || installed.Commit != m.Commit || installed.BinarySHA256 != m.BinarySHA256) {
		return ErrConfiguration
	}
	if record.Mode == p.SetupAdopt && !p.StableVersion(installed.Version) && !record.Receipt.AllowPreview {
		return errors.New("preview adoption must be explicitly allowed in Yggdrasil")
	}
	if record.Mode == p.SetupAdopt {
		probe, err := h.service(c).Probe(ctx)
		if err != nil || probe.RunningSHA256 != installed.BinarySHA256 || probe.Build.Version != installed.Version || !commitMatches(probe.Build.Commit, installed.Commit) {
			return errors.New("existing running executable does not match the inspected baseline")
		}
		if record.RequiredSystem && !probe.SystemAvailable || record.RequiredGPU && !probe.GPUAvailable {
			return errors.New("existing monitor lost a required telemetry domain")
		}
		record.RequiredSystem = record.RequiredSystem || probe.SystemAvailable
		record.RequiredGPU = record.RequiredGPU || probe.GPUAvailable
	}
	if record.Mode == p.SetupInstall {
		record.RequiredSystem = true
	}
	if record.Authorized && record.Started {
		probe, probeErr := h.service(c).Probe(ctx)
		if probeErr == nil && probe.RunningSHA256 == record.Installation.BinarySHA256 && probe.Build.Version == record.Installation.Version && commitMatches(probe.Build.Commit, record.Installation.Commit) {
			// Installation already crossed the local activation boundary while
			// its original lease was valid. Resume ONLY verification/reporting;
			// never request another artifact, re-adopt, switch or start a unit.
			return finishManagedSetup(ctx, h, client, &record, recordPath, stdout)
		}
	}
	auth, err := client.SetupAuthorize(ctx, p.SetupAuthorizeRequest{SetupID: record.Receipt.SetupID, Mode: record.Mode, Installation: installed})
	if err != nil {
		if record.Authorized {
			record.Report = &p.SetupReportRequest{SetupID: record.Receipt.SetupID, Status: p.SetupRecoveryRequired, Installation: record.Installation, Code: "interrupted_setup_authorization_expired"}
			_ = atomicJSON(recordPath, record)
			_ = client.reconcileSetupRecord(ctx, recordPath, &record)
			return errors.New("interrupted setup cannot resume installation; operator recovery is required")
		}
		return err
	}
	if !p.StableVersion(installed.Version) && !auth.AllowPreview {
		return errors.New("preview adoption is no longer authorized")
	}
	record.Installation = installed
	record.InstallBefore = auth.InstallBefore
	record.Authorized = true
	if err = atomicJSON(recordPath, record); err != nil {
		return err
	}
	if !auth.InstallBefore.After(time.Now()) {
		return errors.New("setup installation authorization expired")
	}
	// No service, monitored executable, or runtime registry has changed before
	// this final live authorization gate. Only private identity/recovery state exists.
	for _, path := range sortedSetupFiles(record.Files) {
		if !auth.InstallBefore.After(time.Now()) {
			return errors.New("setup installation authorization expired")
		}
		if err = setupPublish(path, record.Files[path]); err != nil {
			return err
		}
	}
	if !auth.InstallBefore.After(time.Now()) {
		return errors.New("setup installation authorization expired")
	}
	if err = setupPublish(h.path("/usr/local/bin/leviathan-updater"), updaterFile); err != nil {
		return err
	}
	if err = prepareDirectories(c); err != nil {
		return err
	}
	engine, err := NewEngine(c, client, h.service(c), Options{Keys: keys})
	if err != nil {
		return err
	}
	if !auth.InstallBefore.After(time.Now()) {
		return errors.New("setup authorization expired before adoption")
	}
	installCtx, cancelInstall := context.WithDeadline(ctx, auth.InstallBefore)
	err = engine.Adopt(installCtx, baseline, auth.AllowPreview)
	cancelInstall()
	if err != nil {
		return err
	}
	if !auth.InstallBefore.After(time.Now()) {
		return errors.New("setup authorization expired before executable switch")
	}

	target := h.path("/usr/local/bin/leviathan")
	if link, e := os.Readlink(target); e == nil {
		if link != filepath.Join(c.RootDirectory, "current/leviathan") {
			return ErrConfiguration
		}
	} else {
		temporary := filepath.Join(filepath.Dir(target), ".leviathan-managed-setup")
		if _, e = os.Lstat(temporary); e == nil {
			return errors.New("unexpected pending executable link requires local inspection")
		}
		if err = os.Symlink(filepath.Join(c.RootDirectory, "current/leviathan"), temporary); err != nil {
			return err
		}
		if err = os.Rename(temporary, target); err != nil {
			_ = os.Remove(temporary)
			return err
		}
		if err = syncDirectory(filepath.Dir(target)); err != nil {
			return err
		}
	}
	if _, err = h.run(ctx, "systemctl", "daemon-reload"); err != nil {
		return err
	}
	record.Started = true
	if err = atomicJSON(recordPath, record); err != nil {
		return err
	}
	if record.Mode == p.SetupInstall {
		if !auth.InstallBefore.After(time.Now()) {
			return errors.New("setup authorization expired before starting the monitor")
		}
		if _, err = h.run(ctx, "systemctl", "enable", "--now", c.Service); err != nil {
			record.RecoveryRequired = true
			record.Report = &p.SetupReportRequest{SetupID: record.Receipt.SetupID, Status: p.SetupRecoveryRequired, Installation: installed, Code: "initial_startup_failed"}
			_ = atomicJSON(recordPath, record)
			_ = client.reconcileSetupRecord(ctx, recordPath, &record)
			return errors.New("initial service startup failed; retained setup requires operator recovery")
		}
	}
	return finishManagedSetup(ctx, h, client, &record, recordPath, stdout)
}
func finishManagedSetup(ctx context.Context, h *setupHost, client *Client, record *setupRecord, recordPath string, stdout io.Writer) error {
	required := Probe{SystemAvailable: record.RequiredSystem, GPUAvailable: record.RequiredGPU}
	notifyVerifying := func(probe Probe) {
		record.RequiredSystem = record.RequiredSystem || probe.SystemAvailable
		record.RequiredGPU = record.RequiredGPU || probe.GPUAvailable
		record.Report = &p.SetupReportRequest{SetupID: record.Receipt.SetupID, Status: p.SetupVerifying, Installation: record.Installation, InstallationVerified: true}
		if atomicJSON(recordPath, record) == nil {
			_ = client.reconcileSetupRecord(ctx, recordPath, record)
		}
	}
	if err := h.verify(ctx, record.Config, record.Installation, required, notifyVerifying); err != nil {
		if record.Mode == p.SetupInstall {
			_, _ = h.run(ctx, "systemctl", "stop", record.Config.Service)
		}
		record.RecoveryRequired = true
		record.Report = &p.SetupReportRequest{SetupID: record.Receipt.SetupID, Status: p.SetupRecoveryRequired, Installation: record.Installation, Code: "initial_health_failed"}
		_ = atomicJSON(recordPath, record)
		_ = client.reconcileSetupRecord(ctx, recordPath, record)
		return errors.New("setup health verification failed; operator recovery is required")
	}
	record.Complete = true
	record.Report = &p.SetupReportRequest{SetupID: record.Receipt.SetupID, Status: p.SetupSucceeded, Installation: record.Installation, InstallationVerified: true}
	// The durable completion boundary precedes autonomous update polling.
	if err := atomicJSON(recordPath, record); err != nil {
		return err
	}
	reportErr := client.reconcileSetupRecord(ctx, recordPath, record)
	if _, err := h.run(ctx, "systemctl", "enable", "--now", "leviathan-updater.service"); err != nil {
		return err
	}
	if reportErr != nil {
		_, err := fmt.Fprintln(stdout, "Leviathan and its updater are installed. The updater will retry result reporting.")
		return err
	}
	_, err := fmt.Fprintln(stdout, "Leviathan and its updater are installed and verified for this Yggdrasil host.")
	return err
}

func inspectSetupBaseline(ctx context.Context, h *setupHost, c Config, files map[string]setupFile, binary string) (p.Installation, error) {
	var out p.Installation
	build, err := h.build(ctx, binary)
	if err != nil {
		return out, err
	}
	digest, err := binaryDigest(binary)
	if err != nil {
		return out, err
	}
	fingerprint, err := setupFingerprint(c, files)
	if err != nil {
		return out, err
	}
	_, arch, glibc, err := h.service(c).Platform(ctx)
	if err != nil {
		return out, err
	}
	out = p.Installation{Version: build.Version, Commit: build.Commit, BinarySHA256: digest, OS: "linux", Arch: arch, Glibc: glibc, UpdaterVersion: p.ProtocolVersion, ConfigProfile: p.ConfigProfile, StateProfile: p.StateProfile, ConfigSHA256: fingerprint, Managed: true}
	return out, out.Validate()
}
func (c *Client) reconcileSetupRecord(ctx context.Context, path string, record *setupRecord) error {
	if record.Report == nil {
		return nil
	}
	if err := c.SetupReport(ctx, *record.Report); err != nil {
		return err
	}
	record.Report = nil
	return atomicJSON(path, record)
}
func (c *Client) ReconcileSetup(ctx context.Context) error {
	path := filepath.Join(c.config.StateDirectory, "setup.json")
	var record setupRecord
	if err := readSetupRecord(path, &record); errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	if record.Schema != "leviathan-setup-v1" || record.Config.Machine != c.config.Machine || record.Origin != c.config.ControlPlaneURL {
		return ErrConfiguration
	}
	return c.reconcileSetupRecord(ctx, path, &record)
}

func readSetupRecord(path string, out *setupRecord) error {
	body, err := safeRead(path, p.MaxBodyBytes, true)
	if err != nil {
		return err
	}
	var decoded setupRecord
	if err = p.DecodeStrict(bytes.NewReader(body), p.MaxBodyBytes, &decoded); err != nil {
		return err
	}
	*out = decoded
	return nil
}

func restoreSetupIdentity(client *Client, record setupRecord) error {
	if _, key, _, err := client.loadIdentity(); err == nil {
		clear(key)
		return nil
	}
	var pending identity
	if record.Receipt == nil || readJSON(filepath.Join(record.Config.credentialDirectory(), "setup-identity.json"), &pending) != nil {
		return ErrIdentity
	}
	return client.saveCertificate(pending, record.Receipt.Certificate)
}

func replaceUnstartedSetupTicket(ctx context.Context, h *setupHost, client *Client, record *setupRecord, path string, opts SetupOptions, ticketDigest string) error {
	if record.Authorized || record.Started || record.Complete || record.RecoveryRequired || record.Report != nil {
		return errors.New("a new ticket cannot replace an authorized or installed host transaction")
	}
	// This journal is fsynced before every runtime mutation. Also reject any
	// runtime registry that appeared independently since the original attempt.
	for _, name := range []string{h.path("/etc/leviathan-updater/config.json"), filepath.Join(record.Config.RootDirectory, "current")} {
		if _, err := os.Lstat(name); !errors.Is(err, os.ErrNotExist) {
			return errors.New("existing managed runtime prevents ticket replacement")
		}
	}
	if record.Receipt != nil {
		if err := restoreSetupIdentity(client, *record); err != nil {
			return err
		}
		status, err := client.SetupStatus(ctx, p.SetupStatusRequest{SetupID: record.Receipt.SetupID})
		if err != nil {
			return err
		}
		if status.Setup.Status != p.SetupExpired && status.Setup.Status != p.SetupFailed && status.Setup.Status != p.SetupSuperseded {
			return errors.New("previous setup ticket is still active; reuse its original command")
		}
		record.MachineBound = true
	} else if _, err := os.Lstat(filepath.Join(record.Config.credentialDirectory(), "identity.json")); !errors.Is(err, os.ErrNotExist) && !record.MachineBound {
		// Covers legacy/ambiguous state from an interruption before the durable
		// receipt existed. Do not silently rebind an already issued identity.
		return errors.New("unbound retained credential requires local recovery")
	}
	if err := removeDurable(filepath.Join(record.Config.StateDirectory, "setup-candidate")); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	*record = setupRecord{Schema: record.Schema, Origin: record.Origin, TicketSHA256: ticketDigest, ReleaseVersion: opts.Version, ReleaseCommit: opts.Commit, Config: record.Config, MachineBound: record.MachineBound}
	return atomicJSON(path, record)
}
