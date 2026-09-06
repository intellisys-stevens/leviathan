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
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func testCertificate(t *testing.T, key ed25519.PublicKey, m p.MachineKey, now time.Time, serial int64, purpose string, lifetime time.Duration) p.CertificateResponse {
	t.Helper()
	uri, _ := url.Parse(strings.Replace(updaterIdentity(m), "/updater/", "/"+purpose+"/", 1))
	_, ca, _ := ed25519.GenerateKey(rand.Reader)
	template := &x509.Certificate{SerialNumber: big.NewInt(serial), NotBefore: now.Add(-time.Minute).Truncate(time.Second), NotAfter: now.Add(lifetime).Truncate(time.Second), URIs: []*url.URL{uri}, KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}}
	der, err := x509.CreateCertificate(rand.Reader, template, template, key, ca)
	if err != nil {
		t.Fatal(err)
	}
	return p.CertificateResponse{CertificatePEM: string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})), Identity: uri.String(), PlatformID: m.PlatformID, ScopeID: m.ScopeID, MachineID: m.MachineID, Serial: template.SerialNumber.Text(16), NotBefore: template.NotBefore, NotAfter: template.NotAfter}
}
func TestHTTPSClientEnrollmentRetrySignedRequestsRenewalAndRedirect(t *testing.T) {
	f := newFixture(t)
	cfg := f.e.config
	var firstCSR string
	enrollCalls, renewCalls, claims := 0, 0, 0
	seenNonces := map[string]bool{}
	var certificate p.CertificateResponse
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == p.EnrollPath {
			var input p.EnrollRequest
			if p.DecodeStrict(r.Body, p.MaxBodyBytes, &input) != nil {
				t.Error("bad enrollment")
				w.WriteHeader(400)
				return
			}
			if firstCSR == "" {
				firstCSR = input.CSRPEM
			}
			if input.CSRPEM != firstCSR {
				t.Error("CSR changed after lost response")
			}
			enrollCalls++
			if enrollCalls == 1 {
				w.WriteHeader(503)
				return
			}
			block, _ := pem.Decode([]byte(input.CSRPEM))
			csr, err := x509.ParseCertificateRequest(block.Bytes)
			if err != nil || csr.CheckSignature() != nil {
				t.Error("bad CSR")
			}
			certificate = testCertificate(t, csr.PublicKey.(ed25519.PublicKey), cfg.Machine, *f.now, 1, "updater", time.Hour)
			json.NewEncoder(w).Encode(certificate)
			return
		}
		var signed p.SignedRequest
		if p.DecodeStrict(r.Body, p.MaxBodyBytes, &signed) != nil {
			t.Error("bad signed envelope")
			w.WriteHeader(400)
			return
		}
		block, _ := pem.Decode([]byte(signed.CertificatePEM))
		cert, _ := x509.ParseCertificate(block.Bytes)
		digest := sha256.Sum256(signed.Payload)
		frame := fmt.Sprintf("yggdrasil-node-control-v1\nPOST\n%s\n%s\n%s\n%s\n%s\n", r.URL.Path, cert.SerialNumber.Text(16), signed.Timestamp.Format(time.RFC3339Nano), signed.Nonce, base64.RawURLEncoding.EncodeToString(digest[:]))
		sig, _ := base64.RawURLEncoding.DecodeString(signed.Signature)
		if !ed25519.Verify(cert.PublicKey.(ed25519.PublicKey), []byte(frame), sig) || seenNonces[signed.Nonce] {
			t.Error("invalid/replayed signature")
		}
		seenNonces[signed.Nonce] = true
		switch r.URL.Path {
		case p.ClaimPath:
			claims++
			json.NewEncoder(w).Encode(p.ClaimResponse{Schema: p.Schema, PollAfterSeconds: 15})
		case p.RenewPath:
			renewCalls++
			var in p.RenewRequest
			json.Unmarshal(signed.Payload, &in)
			block, _ := pem.Decode([]byte(in.CSRPEM))
			csr, _ := x509.ParseCertificateRequest(block.Bytes)
			certificate = testCertificate(t, csr.PublicKey.(ed25519.PublicKey), cfg.Machine, *f.now, 2, "updater", 90*24*time.Hour)
			json.NewEncoder(w).Encode(certificate)
		case p.HeartbeatPath:
			json.NewEncoder(w).Encode(p.ReportResponse{Schema: p.Schema, Accepted: true})
		case p.ArtifactPath:
			w.Header().Set("Content-Type", "application/gzip")
			w.Write(f.c.archive)
		case p.ReportPath:
			w.Header().Set("Location", "https://example.invalid/credentials")
			w.WriteHeader(http.StatusTemporaryRedirect)
		default:
			t.Error("unexpected route", r.URL.Path)
			w.WriteHeader(404)
		}
	})
	server := httptest.NewTLSServer(handler)
	defer server.Close()
	cfg.ControlPlaneURL = server.URL
	client, err := NewClient(cfg, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	client.now = func() time.Time { return *f.now }
	token := filepath.Join(cfg.StateDirectory, "token")
	os.WriteFile(token, []byte("yenr1_test_one_use"), 0600)
	if client.Enroll(context.Background(), token) == nil {
		t.Fatal("expected unavailable enrollment response")
	}
	if _, err := os.Stat(filepath.Join(cfg.StateDirectory, "enrollment-pending.json")); err != nil {
		t.Fatal("CSR not retained")
	}
	if err = client.Enroll(context.Background(), token); err != nil {
		t.Fatal(err)
	}
	if enrollCalls != 2 {
		t.Fatal("enrollment retries")
	}
	if err = client.Enroll(context.Background(), token); err != nil || enrollCalls != 2 {
		t.Fatal("enrollment not idempotent")
	}
	if _, err = client.Claim(context.Background(), p.ClaimRequest{Installation: f.installed}); err != nil {
		t.Fatal(err)
	}
	if err = client.Renew(context.Background()); err != nil {
		t.Fatal(err)
	}
	if renewCalls != 1 {
		t.Fatal("renewal not attempted")
	}
	value, key, cert, err := client.loadIdentity()
	if err != nil || cert.SerialNumber.Int64() != 2 {
		t.Fatal("renewed leaf not retained", err)
	}
	clear(key)
	if value.CertificatePEM != certificate.CertificatePEM {
		t.Fatal("identity receipt mismatch")
	}
	if err = client.Heartbeat(context.Background(), "job1"); err != nil {
		t.Fatal(err)
	}
	reader, err := client.Artifact(context.Background(), p.ArtifactRequest{JobID: "job1", ArchiveSHA256: f.manifest.ArchiveSHA256})
	if err != nil {
		t.Fatal(err)
	}
	reader.Close()
	if client.Report(context.Background(), p.ReportRequest{JobID: "job1", Status: p.Failed}) == nil {
		t.Fatal("redirect accepted")
	}
	// A leaf without enough time for local recovery cannot start another update.
	f.nowValue(cert.NotAfter.Add(-5 * time.Minute))
	if _, err = client.Claim(context.Background(), p.ClaimRequest{Installation: f.installed}); err == nil || claims != 1 {
		t.Fatal("short validity claim was sent")
	}
}
func (f *fixture) nowValue(t time.Time) { *f.now = t }
func TestIdentityRejectsViewerWrongHostMismatchedKeyAndPermissions(t *testing.T) {
	f := newFixture(t)
	_, key, _ := ed25519.GenerateKey(rand.Reader)
	pub := key.Public().(ed25519.PublicKey)
	good := testCertificate(t, pub, f.e.config.Machine, *f.now, 1, "updater", time.Hour)
	value := identity{PrivateKey: base64.RawStdEncoding.EncodeToString(key), CertificatePEM: good.CertificatePEM}
	if _, _, err := parseIdentity(value, f.e.config.Machine, *f.now); err != nil {
		t.Fatal(err)
	}
	cases := []identity{value, value, value}
	cases[0].CertificatePEM = testCertificate(t, pub, f.e.config.Machine, *f.now, 2, "node", time.Hour).CertificatePEM
	wrong := f.e.config.Machine
	wrong.MachineID = "other"
	cases[1].CertificatePEM = testCertificate(t, pub, wrong, *f.now, 3, "updater", time.Hour).CertificatePEM
	cases[2].PrivateKey = base64.RawStdEncoding.EncodeToString(ed25519.NewKeyFromSeed(bytes.Repeat([]byte{12}, 32)))
	for _, bad := range cases {
		if _, _, err := parseIdentity(bad, f.e.config.Machine, *f.now); err == nil {
			t.Fatal("wrong purpose/host/key accepted")
		}
	}
	path := filepath.Join(f.e.config.StateDirectory, "identity.json")
	atomicJSON(path, value)
	os.Chmod(path, 0644)
	client, _ := NewClient(f.e.config, nil)
	client.now = func() time.Time { return *f.now }
	if _, _, _, err := client.loadIdentity(); err == nil {
		t.Fatal("world readable private key accepted")
	}
}
