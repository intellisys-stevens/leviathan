// Package updateprotocol is the versioned, HTTP-only contract for managed
// Leviathan updates. Yggdrasil owns this file; Leviathan vendors it verbatim.
// Neither repository imports the other's internal packages.
package updateprotocol

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	Schema                = "leviathan-update-v1"
	ManifestSchema        = "leviathan-release-v1"
	ProtocolVersion       = 1
	ConfigProfile         = "leviathan-config-v1"
	StateProfile          = "leviathan-state-v1"
	MaxBodyBytes    int64 = 256 << 10
	MaxArchiveBytes int64 = 512 << 20
	MaxBinaryBytes  int64 = 256 << 20
	EnrollPath            = "/api/node-control/v1/updates/enroll"
	RenewPath             = "/api/node-control/v1/updates/renew"
	ClaimPath             = "/api/node-control/v1/updates/claim"
	AuthorizePath         = "/api/node-control/v1/updates/authorize"
	ReportPath            = "/api/node-control/v1/updates/report"
	ArtifactPath          = "/api/node-control/v1/updates/artifact"
	HeartbeatPath         = "/api/node-control/v1/updates/heartbeat"
	BrowserPrefix         = "/api/agent-updates/v1"
)

var ErrInvalid = errors.New("invalid update contract")
var stableVersion = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`)
var currentVersion = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$`)
var platformID = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,63}$`)

type MachineKey struct {
	PlatformID string `json:"platformId"`
	ScopeID    string `json:"scopeId"`
	MachineID  string `json:"machineId"`
}

func (m MachineKey) Valid() bool {
	return platformID.MatchString(m.PlatformID) && printable(m.ScopeID, 256) && printable(m.MachineID, 512)
}
func printable(s string, max int) bool {
	if s == "" || len(s) > max || !utf8.ValidString(s) {
		return false
	}
	for _, c := range s {
		if c <= 0x20 || c == 0x7f {
			return false
		}
	}
	return true
}

// Manifest is signed as the canonical compact JSON produced by SignManifest.
// Compatibility profiles describe config/state formats, not release numbers;
// compatible patch releases intentionally share profiles.
type Manifest struct {
	Schema         string `json:"schema"`
	Version        string `json:"version"`
	Commit         string `json:"commit"`
	OS             string `json:"os"`
	Arch           string `json:"arch"`
	MinimumGlibc   string `json:"minimumGlibc"`
	MinimumUpdater int    `json:"minimumUpdater"`
	ConfigProfile  string `json:"configProfile"`
	StateProfile   string `json:"stateProfile"`
	ArchiveSHA256  string `json:"archiveSha256"`
	BinarySHA256   string `json:"binarySha256"`
	ArchiveBytes   int64  `json:"archiveBytes"`
	BinaryBytes    int64  `json:"binaryBytes"`
}
type SignedManifest struct {
	KeyID     string          `json:"keyId"`
	Manifest  json.RawMessage `json:"manifest"`
	Signature string          `json:"signature"`
}

func IsDigest(s string) bool {
	if len(s) != 64 {
		return false
	}
	b, e := hex.DecodeString(s)
	return e == nil && hex.EncodeToString(b) == s
}
func StableVersion(s string) bool { return len(s) <= 64 && stableVersion.MatchString(s) }
func (m Manifest) Validate() error {
	commit, e := hex.DecodeString(m.Commit)
	if m.Schema != ManifestSchema || !StableVersion(m.Version) || e != nil || len(commit) != 20 || hex.EncodeToString(commit) != m.Commit || m.OS != "linux" || (m.Arch != "amd64" && m.Arch != "arm64") || !validGlibc(m.MinimumGlibc) || m.MinimumUpdater < 1 || m.MinimumUpdater > 10000 || !printable(m.ConfigProfile, 64) || !printable(m.StateProfile, 64) || !IsDigest(m.ArchiveSHA256) || !IsDigest(m.BinarySHA256) || m.ArchiveBytes < 1 || m.ArchiveBytes > MaxArchiveBytes || m.BinaryBytes < 1 || m.BinaryBytes > MaxBinaryBytes {
		return ErrInvalid
	}
	return nil
}
func KeyID(key ed25519.PublicKey) string { h := sha256.Sum256(key); return hex.EncodeToString(h[:16]) }
func SignManifest(m Manifest, key ed25519.PrivateKey) (SignedManifest, error) {
	if m.Validate() != nil || len(key) != ed25519.PrivateKeySize {
		return SignedManifest{}, ErrInvalid
	}
	b, e := json.Marshal(m)
	if e != nil {
		return SignedManifest{}, ErrInvalid
	}
	return SignedManifest{KeyID: KeyID(key.Public().(ed25519.PublicKey)), Manifest: b, Signature: base64.RawURLEncoding.EncodeToString(ed25519.Sign(key, manifestMessage(b)))}, nil
}
func manifestMessage(b []byte) []byte { return append([]byte(ManifestSchema+"\n"), b...) }
func VerifyManifest(s SignedManifest, keys map[string]ed25519.PublicKey) (Manifest, error) {
	var m Manifest
	key := keys[s.KeyID]
	sig, e := base64.RawURLEncoding.DecodeString(s.Signature)
	if len(key) != ed25519.PublicKeySize || s.KeyID != KeyID(key) || e != nil || len(sig) != ed25519.SignatureSize || len(s.Manifest) > int(MaxBodyBytes)/2 || !ed25519.Verify(key, manifestMessage(s.Manifest), sig) || DecodeStrict(bytes.NewReader(s.Manifest), MaxBodyBytes, &m) != nil || m.Validate() != nil {
		return Manifest{}, ErrInvalid
	}
	canonical, _ := json.Marshal(m)
	if !bytes.Equal(canonical, s.Manifest) {
		return Manifest{}, ErrInvalid
	}
	return m, nil
}

type Installation struct {
	Version        string `json:"version"`
	Commit         string `json:"commit"`
	BinarySHA256   string `json:"binarySha256"`
	OS             string `json:"os"`
	Arch           string `json:"arch"`
	Glibc          string `json:"glibc"`
	UpdaterVersion int    `json:"updaterVersion"`
	ConfigProfile  string `json:"configProfile"`
	StateProfile   string `json:"stateProfile"`
	ConfigSHA256   string `json:"configSha256"`
	Managed        bool   `json:"managed"`
}

func (i Installation) Validate() error {
	if !printable(i.Version, 96) || !printable(i.Commit, 96) || !IsDigest(i.BinarySHA256) || i.OS != "linux" || (i.Arch != "amd64" && i.Arch != "arm64") || !validGlibc(i.Glibc) || i.UpdaterVersion < 1 || i.UpdaterVersion > 10000 || !printable(i.ConfigProfile, 64) || !printable(i.StateProfile, 64) || !IsDigest(i.ConfigSHA256) {
		return ErrInvalid
	}
	return nil
}

// Eligibility fails closed for unmanaged/unknown builds. A locally adopted
// preview may advance to its stable version; older stable versions never win.
func Eligibility(m Manifest, i Installation) string {
	if m.Validate() != nil || i.Validate() != nil {
		return "invalid_metadata"
	}
	if !i.Managed {
		return "setup_required"
	}
	if i.OS != m.OS || i.Arch != m.Arch {
		return "architecture_mismatch"
	}
	if !GlibcAtLeast(i.Glibc, m.MinimumGlibc) {
		return "glibc_incompatible"
	}
	if i.UpdaterVersion < m.MinimumUpdater {
		return "updater_upgrade_required"
	}
	if i.ConfigProfile != m.ConfigProfile || i.StateProfile != m.StateProfile {
		return "incompatible_configuration_or_state"
	}
	if !NewerStable(m.Version, i.Version) {
		return "not_a_newer_stable_release"
	}
	return ""
}
func NewerStable(target, current string) bool {
	if !StableVersion(target) || len(current) > 96 || !currentVersion.MatchString(current) {
		return false
	}
	base, pre, _ := strings.Cut(current, "-")
	a, b := strings.Split(target, "."), strings.Split(base, ".")
	for n := range 3 {
		x, e1 := strconv.ParseUint(a[n], 10, 64)
		y, e2 := strconv.ParseUint(b[n], 10, 64)
		if e1 != nil || e2 != nil {
			return false
		}
		if x != y {
			return x > y
		}
	}
	return pre != ""
}
func validGlibc(s string) bool {
	p := strings.Split(s, ".")
	if len(p) < 2 || len(p) > 3 {
		return false
	}
	for _, v := range p {
		n, e := strconv.ParseUint(v, 10, 32)
		if e != nil || strconv.FormatUint(n, 10) != v {
			return false
		}
	}
	return true
}
func GlibcAtLeast(have, need string) bool {
	if !validGlibc(have) || !validGlibc(need) {
		return false
	}
	a, b := strings.Split(have, "."), strings.Split(need, ".")
	for n := range 3 {
		var x, y uint64
		if n < len(a) {
			x, _ = strconv.ParseUint(a[n], 10, 32)
		}
		if n < len(b) {
			y, _ = strconv.ParseUint(b[n], 10, 32)
		}
		if x != y {
			return x > y
		}
	}
	return true
}

type Status string

const (
	Queued           Status = "queued"
	Downloading      Status = "downloading"
	Installing       Status = "installing"
	Verifying        Status = "verifying"
	Succeeded        Status = "succeeded"
	RolledBack       Status = "rolled_back"
	Failed           Status = "failed"
	RecoveryRequired Status = "recovery_required"
	Expired          Status = "expired"
)

func (s Status) Terminal() bool {
	return s == Succeeded || s == RolledBack || s == Failed || s == RecoveryRequired || s == Expired
}
func (s Status) Valid() bool {
	return s == Queued || s == Downloading || s == Installing || s == Verifying || s.Terminal()
}

type Job struct {
	ID          string         `json:"id"`
	Machine     MachineKey     `json:"machine"`
	Release     SignedManifest `json:"release"`
	Expected    Installation   `json:"expected"`
	Status      Status         `json:"status"`
	RequestedBy string         `json:"requestedBy"`
	CreatedAt   time.Time      `json:"createdAt"`
	ExpiresAt   time.Time      `json:"expiresAt"`
	UpdatedAt   time.Time      `json:"updatedAt"`
	Code        string         `json:"code,omitempty"`
}
type HeartbeatRequest struct {
	JobID string `json:"jobId"`
}
type ClaimRequest struct {
	Installation Installation `json:"installation"`
}
type ClaimResponse struct {
	Schema           string `json:"schema"`
	Job              *Job   `json:"job"`
	PollAfterSeconds int    `json:"pollAfterSeconds"`
}
type AuthorizeRequest struct {
	JobID        string       `json:"jobId"`
	Installation Installation `json:"installation"`
}
type AuthorizeResponse struct {
	Schema        string    `json:"schema"`
	JobID         string    `json:"jobId"`
	Allowed       bool      `json:"allowed"`
	InstallBefore time.Time `json:"installBefore"`
}
type ReportRequest struct {
	InstallationVerified bool         `json:"installationVerified"`
	JobID                string       `json:"jobId"`
	Status               Status       `json:"status"`
	Installation         Installation `json:"installation"`
	Code                 string       `json:"code,omitempty"`
}
type ReportResponse struct {
	Schema   string `json:"schema"`
	Accepted bool   `json:"accepted"`
}
type ArtifactRequest struct {
	JobID         string `json:"jobId"`
	ArchiveSHA256 string `json:"archiveSha256"`
}
type CreateRequest struct {
	Machine       MachineKey `json:"machine"`
	ReleaseDigest string     `json:"releaseDigest"`
	RequestID     string     `json:"requestId"`
}
type DelegationRequest struct {
	Machine MachineKey `json:"machine"`
	UserID  string     `json:"userId"`
	Granted bool       `json:"granted"`
}
type EnrollmentRequest struct {
	Machine MachineKey `json:"machine"`
}
type EnrollmentResponse struct {
	Token     string     `json:"token"`
	Machine   MachineKey `json:"machine"`
	ExpiresAt time.Time  `json:"expiresAt"`
}
type EnrollRequest struct {
	Token  string `json:"token"`
	CSRPEM string `json:"csrPem"`
}
type RenewRequest struct {
	CSRPEM string `json:"csrPem"`
}
type CertificateResponse struct {
	CertificatePEM string    `json:"certificatePem"`
	Identity       string    `json:"identity"`
	PlatformID     string    `json:"platformId"`
	ScopeID        string    `json:"scopeId"`
	MachineID      string    `json:"machineId"`
	Serial         string    `json:"serial"`
	NotBefore      time.Time `json:"notBefore"`
	NotAfter       time.Time `json:"notAfter"`
}
type ReleaseSummary struct {
	Version       string `json:"version"`
	Commit        string `json:"commit"`
	ArchiveSHA256 string `json:"archiveSha256"`
	Arch          string `json:"arch"`
	Eligible      bool   `json:"eligible"`
	Reason        string `json:"reason,omitempty"`
}
type Delegate struct {
	UserID      string `json:"userId"`
	DisplayName string `json:"displayName,omitempty"`
}
type HostListResponse struct {
	Machines []MachineKey `json:"machines"`
}
type MachineStatus struct {
	Enabled      bool             `json:"enabled"`
	CanUpdate    bool             `json:"canUpdate"`
	CanDelegate  bool             `json:"canDelegate"`
	Enrolled     bool             `json:"enrolled"`
	Online       bool             `json:"online"`
	ObservedAt   *time.Time       `json:"observedAt"`
	Installation *Installation    `json:"installation"`
	Releases     []ReleaseSummary `json:"releases"`
	Job          *Job             `json:"job"`
	Delegates    []Delegate       `json:"delegates"`
	Reason       string           `json:"reason,omitempty"`
}

// SignedRequest retains the existing node-control-v1 signature framing. The
// server must independently verify updater purpose, certificate, freshness and
// consume the nonce durably; a valid signature alone is not authorization.
type SignedRequest struct {
	CertificatePEM    string          `json:"certificatePem"`
	CertificateSerial string          `json:"certificateSerial"`
	Timestamp         time.Time       `json:"timestamp"`
	Nonce             string          `json:"nonce"`
	Payload           json.RawMessage `json:"payload"`
	Signature         string          `json:"signature"`
}

func NewSignedRequest(path string, payload any, certificatePEM, serial string, key ed25519.PrivateKey, now time.Time) (SignedRequest, error) {
	if len(key) != ed25519.PrivateKeySize || certificatePEM == "" || serial == "" || now.IsZero() {
		return SignedRequest{}, ErrInvalid
	}
	body, err := json.Marshal(payload)
	if err != nil || len(body) > int(MaxBodyBytes)/2 {
		return SignedRequest{}, ErrInvalid
	}
	nonce := make([]byte, 24)
	if _, err = rand.Read(nonce); err != nil {
		return SignedRequest{}, err
	}
	r := SignedRequest{CertificatePEM: certificatePEM, CertificateSerial: serial, Timestamp: now.UTC(), Nonce: base64.RawURLEncoding.EncodeToString(nonce), Payload: body}
	digest := sha256.Sum256(body)
	message := fmt.Sprintf("yggdrasil-node-control-v1\nPOST\n%s\n%s\n%s\n%s\n%s\n", path, serial, r.Timestamp.Format(time.RFC3339Nano), r.Nonce, base64.RawURLEncoding.EncodeToString(digest[:]))
	r.Signature = base64.RawURLEncoding.EncodeToString(ed25519.Sign(key, []byte(message)))
	return r, nil
}

// DecodeStrict bounds memory, rejects duplicate members and unknown fields,
// and rejects trailing values. Signed data must have one interpretation.
func DecodeStrict(r io.Reader, limit int64, target any) error {
	if r == nil || limit < 1 || limit > MaxBodyBytes || target == nil {
		return ErrInvalid
	}
	b, e := io.ReadAll(io.LimitReader(r, limit+1))
	if e != nil || int64(len(b)) > limit {
		return ErrInvalid
	}
	d := json.NewDecoder(bytes.NewReader(b))
	d.UseNumber()
	if uniqueValue(d, 0) != nil {
		return ErrInvalid
	}
	if _, e = d.Token(); e != io.EOF {
		return ErrInvalid
	}
	d = json.NewDecoder(bytes.NewReader(b))
	d.DisallowUnknownFields()
	if d.Decode(target) != nil {
		return ErrInvalid
	}
	return nil
}
func uniqueValue(d *json.Decoder, depth int) error {
	if depth > 20 {
		return ErrInvalid
	}
	t, e := d.Token()
	if e != nil {
		return e
	}
	v, ok := t.(json.Delim)
	if !ok {
		return nil
	}
	switch v {
	case '{':
		seen := map[string]bool{}
		for d.More() {
			key, e := d.Token()
			s, ok := key.(string)
			if e != nil || !ok || seen[s] {
				return ErrInvalid
			}
			seen[s] = true
			if uniqueValue(d, depth+1) != nil {
				return ErrInvalid
			}
		}
		end, e := d.Token()
		if e != nil || end != json.Delim('}') {
			return ErrInvalid
		}
	case '[':
		for d.More() {
			if uniqueValue(d, depth+1) != nil {
				return ErrInvalid
			}
		}
		end, e := d.Token()
		if e != nil || end != json.Delim(']') {
			return ErrInvalid
		}
	default:
		return ErrInvalid
	}
	return nil
}
