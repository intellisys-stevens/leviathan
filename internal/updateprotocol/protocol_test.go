package updateprotocol

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

func fixtureManifest() Manifest {
	return Manifest{Schema: ManifestSchema, Version: "0.4.1", Commit: strings.Repeat("1", 40), OS: "linux", Arch: "amd64", MinimumGlibc: "2.34", MinimumUpdater: 1, ConfigProfile: ConfigProfile, StateProfile: StateProfile, ArchiveSHA256: strings.Repeat("2", 64), BinarySHA256: strings.Repeat("3", 64), ArchiveBytes: 1024, BinaryBytes: 2048}
}
func fixtureInstallation() Installation {
	return Installation{Version: "0.4.0", Commit: strings.Repeat("0", 40), BinarySHA256: strings.Repeat("4", 64), OS: "linux", Arch: "amd64", Glibc: "2.36", UpdaterVersion: 1, ConfigProfile: ConfigProfile, StateProfile: StateProfile, ConfigSHA256: strings.Repeat("5", 64), Managed: true}
}
func TestSignedManifestGoldenAndTamper(t *testing.T) {
	// Public, deterministic test vector. Never a production signing key.
	key := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{7}, 32))
	pub := key.Public().(ed25519.PublicKey)
	signed, err := SignManifest(fixtureManifest(), key)
	if err != nil {
		t.Fatal(err)
	}
	body, err := json.Marshal(signed)
	if err != nil {
		t.Fatal(err)
	}
	golden, err := os.ReadFile("testdata/release-v1.golden.json")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(bytes.TrimSpace(golden), body) {
		t.Fatal("signed release golden drift")
	}
	keys := map[string]ed25519.PublicKey{KeyID(pub): pub}
	got, err := VerifyManifest(signed, keys)
	if err != nil || got != fixtureManifest() {
		t.Fatal("valid manifest rejected", err)
	}
	for _, change := range []func(*SignedManifest){
		func(s *SignedManifest) { s.Manifest = bytes.ReplaceAll(s.Manifest, []byte("0.4.1"), []byte("0.4.2")) },
		func(s *SignedManifest) { s.Signature = strings.Repeat("A", 86) },
		func(s *SignedManifest) { s.KeyID = strings.Repeat("0", 32) },
		func(s *SignedManifest) {
			s.Manifest = append([]byte(" "), s.Manifest...)
			s.Signature = base64.RawURLEncoding.EncodeToString(ed25519.Sign(key, manifestMessage(s.Manifest)))
		},
	} {
		s := signed
		change(&s)
		if _, err := VerifyManifest(s, keys); err == nil {
			t.Fatal("tamper/noncanonical encoding accepted")
		}
	}
	if _, err := VerifyManifest(signed, nil); err == nil {
		t.Fatal("untrusted signing key accepted")
	}
}
func TestEligibilityStablePreviewCompatibility(t *testing.T) {
	for _, test := range []struct {
		target, current string
		want            bool
	}{
		{"0.4.0", "0.4.0-preview.boards", true}, {"0.3.2", "0.4.0-preview.boards", false},
		{"0.4.1", "0.4.0", true}, {"0.4.0", "0.4.0", false}, {"0.4.1-rc1", "0.4.0", false},
		{"0.4.1", "dev", false}, {"0.4.1", "v0.4.0", false}, {"1.0.0", "0.99.99", true},
		{"01.0.0", "0.9.0", false}, {"1.0.0", "999999999999999999999999999.0.0", false},
	} {
		if got := NewerStable(test.target, test.current); got != test.want {
			t.Errorf("%s from %s: %v", test.target, test.current, got)
		}
	}
	for _, arch := range []string{"amd64", "arm64"} {
		m, i := fixtureManifest(), fixtureInstallation()
		m.Arch = arch
		i.Arch = arch
		if Eligibility(m, i) != "" {
			t.Fatal("compatible stable rejected", arch)
		}
	}
	for _, test := range []struct {
		change func(*Manifest, *Installation)
		reason string
	}{
		{func(m *Manifest, i *Installation) { i.Managed = false }, "setup_required"},
		{func(m *Manifest, i *Installation) { m.Arch = "arm64" }, "architecture_mismatch"},
		{func(m *Manifest, i *Installation) { m.MinimumGlibc = "2.37" }, "glibc_incompatible"},
		{func(m *Manifest, i *Installation) { m.MinimumUpdater = 2 }, "updater_upgrade_required"},
		{func(m *Manifest, i *Installation) { m.StateProfile = "leviathan-state-v2" }, "incompatible_configuration_or_state"},
		{func(m *Manifest, i *Installation) { m.ConfigProfile = "leviathan-config-v2" }, "incompatible_configuration_or_state"},
	} {
		m, i := fixtureManifest(), fixtureInstallation()
		test.change(&m, &i)
		if got := Eligibility(m, i); got != test.reason {
			t.Fatalf("got %s want %s", got, test.reason)
		}
	}
}
func TestStrictDecodeRejectsAmbiguity(t *testing.T) {
	for _, body := range []string{`{"jobId":"a","jobId":"b"}`, `{"jobId":"a","unknown":1}`, `{"jobId":"a"} {}`, `{"installation":{"version":"a","version":"b"}}`, strings.Repeat("[", 22) + "0" + strings.Repeat("]", 22)} {
		var out AuthorizeRequest
		if DecodeStrict(strings.NewReader(body), MaxBodyBytes, &out) == nil {
			t.Fatal("accepted", body)
		}
	}
	var out AuthorizeRequest
	if DecodeStrict(strings.NewReader(`{"jobId":"a"}`), 2, &out) == nil {
		t.Fatal("oversized accepted")
	}
	if DecodeStrict(strings.NewReader(`{"jobId":"a"}`), MaxBodyBytes, &out) != nil || out.JobID != "a" {
		t.Fatal("valid request rejected")
	}
}
func TestSignedRequestBindsMethodPathSerialTimeNonceAndPayload(t *testing.T) {
	key := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{8}, 32))
	pub := key.Public().(ed25519.PublicKey)
	when := time.Date(2026, 9, 5, 12, 0, 0, 123456789, time.UTC)
	r, err := NewSignedRequest(AuthorizePath, AuthorizeRequest{JobID: "job1", Installation: fixtureInstallation()}, "test-certificate", "ab", key, when)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(r.Payload)
	frame := fmt.Sprintf("yggdrasil-node-control-v1\nPOST\n%s\n%s\n%s\n%s\n%s\n", AuthorizePath, r.CertificateSerial, r.Timestamp.Format(time.RFC3339Nano), r.Nonce, base64.RawURLEncoding.EncodeToString(digest[:]))
	sig, _ := base64.RawURLEncoding.DecodeString(r.Signature)
	if !ed25519.Verify(pub, []byte(frame), sig) {
		t.Fatal("signature framing disagrees")
	}
	for _, replacement := range [][2]string{{"POST", "GET"}, {AuthorizePath, ReportPath}, {"\nab\n", "\nac\n"}, {r.Timestamp.Format(time.RFC3339Nano), when.Add(time.Second).Format(time.RFC3339Nano)}, {r.Nonce, "different"}, {base64.RawURLEncoding.EncodeToString(digest[:]), "otherpayload"}} {
		if ed25519.Verify(pub, []byte(strings.Replace(frame, replacement[0], replacement[1], 1)), sig) {
			t.Fatal("signature accepted altered frame")
		}
	}
	next, _ := NewSignedRequest(AuthorizePath, AuthorizeRequest{JobID: "job1"}, "test-certificate", "ab", key, when)
	if next.Nonce == r.Nonce {
		t.Fatal("nonce reused")
	}
}
func TestOpenAPIFieldsMatchWire(t *testing.T) {
	body, err := os.ReadFile("../../api/agent-updates-v1-openapi.json")
	if err != nil {
		t.Fatal(err)
	}
	var spec struct {
		Components struct {
			Schemas map[string]struct {
				Properties map[string]json.RawMessage `json:"properties"`
			} `json:"schemas"`
		} `json:"components"`
	}
	if err = json.Unmarshal(body, &spec); err != nil {
		t.Fatal(err)
	}
	for _, value := range []any{MachineKey{}, Manifest{}, SignedManifest{}, Installation{}, Job{}, HeartbeatRequest{}, ClaimRequest{}, ClaimResponse{}, AuthorizeRequest{}, AuthorizeResponse{}, ReportRequest{}, ReportResponse{}, ArtifactRequest{}, CreateRequest{}, DelegationRequest{}, EnrollmentRequest{}, EnrollmentResponse{}, EnrollRequest{}, RenewRequest{}, CertificateResponse{}, ReleaseSummary{}, Delegate{}, HostListResponse{}, MachineStatus{}, SignedRequest{}} {
		typ := reflect.TypeOf(value)
		schema, ok := spec.Components.Schemas[typ.Name()]
		if !ok {
			t.Fatal("missing schema", typ.Name())
		}
		if len(schema.Properties) != typ.NumField() {
			t.Fatal("schema field count", typ.Name())
		}
		for i := 0; i < typ.NumField(); i++ {
			name := strings.Split(typ.Field(i).Tag.Get("json"), ",")[0]
			if _, ok := schema.Properties[name]; !ok {
				t.Fatal("missing wire field", typ.Name(), name)
			}
		}
	}
}
