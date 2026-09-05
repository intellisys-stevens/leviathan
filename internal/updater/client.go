package updater

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	p "github.com/intellisys-stevens/leviathan/internal/updateprotocol"
)

var ErrControl = errors.New("updater control plane request failed")
var ErrIdentity = errors.New("updater credential is unavailable, expired, or invalid")

type Control interface {
	Claim(context.Context, p.ClaimRequest) (p.ClaimResponse, error)
	Authorize(context.Context, p.AuthorizeRequest) (p.AuthorizeResponse, error)
	Report(context.Context, p.ReportRequest) error
	Artifact(context.Context, p.ArtifactRequest) (io.ReadCloser, error)
}
type Client struct {
	config Config
	http   *http.Client
	now    func() time.Time
}
type identity struct {
	PrivateKey     string `json:"privateKey"`
	CertificatePEM string `json:"certificatePem"`
	CSRPEM         string `json:"csrPem,omitempty"`
}

func NewClient(c Config, base *http.Client) (*Client, error) {
	if c.Validate() != nil {
		return nil, ErrConfiguration
	}
	client := &http.Client{}
	if base != nil {
		*client = *base
	}
	var tr *http.Transport
	switch t := client.Transport.(type) {
	case nil:
		tr = http.DefaultTransport.(*http.Transport).Clone()
	case *http.Transport:
		tr = t.Clone()
	default:
		return nil, ErrConfiguration
	}
	tr.Proxy = nil
	if tr.TLSClientConfig == nil {
		tr.TLSClientConfig = &tls.Config{}
	} else {
		tr.TLSClientConfig = tr.TLSClientConfig.Clone()
	}
	tr.TLSClientConfig.MinVersion = tls.VersionTLS13
	tr.ResponseHeaderTimeout = 10 * time.Second
	client.Transport = tr
	client.Jar = nil
	client.Timeout = 2 * time.Minute
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &Client{config: c, http: client, now: time.Now}, nil
}
func (c *Client) Close() { c.http.CloseIdleConnections() }
func (c *Client) Heartbeat(ctx context.Context, jobID string) error {
	var out p.ReportResponse
	if e := c.signedJSON(ctx, p.HeartbeatPath, p.HeartbeatRequest{JobID: jobID}, &out); e != nil {
		return e
	}
	if out.Schema != p.Schema || !out.Accepted {
		return ErrControl
	}
	return nil
}
func (c *Client) Claim(ctx context.Context, in p.ClaimRequest) (p.ClaimResponse, error) {
	var out p.ClaimResponse
	_, key, cert, err := c.loadIdentity()
	if err != nil {
		return out, err
	}
	clear(key)
	// Leave enough validity for download, verification and rollback. The run
	// loop renews independently even when this guard rejects a new claim.
	if cert.NotAfter.Sub(c.now()) < 10*time.Minute {
		return out, ErrIdentity
	}
	e := c.signedJSON(ctx, p.ClaimPath, in, &out)
	if e == nil && (out.Schema != p.Schema || out.PollAfterSeconds < 1 || out.PollAfterSeconds > 300) {
		e = ErrControl
	}
	return out, e
}
func (c *Client) Authorize(ctx context.Context, in p.AuthorizeRequest) (p.AuthorizeResponse, error) {
	var out p.AuthorizeResponse
	e := c.signedJSON(ctx, p.AuthorizePath, in, &out)
	if e == nil && (out.Schema != p.Schema || out.JobID != in.JobID || !out.Allowed || !out.InstallBefore.After(c.now()) || out.InstallBefore.After(c.now().Add(2*time.Minute))) {
		e = ErrControl
	}
	return out, e
}
func (c *Client) Report(ctx context.Context, in p.ReportRequest) error {
	var out p.ReportResponse
	if e := c.signedJSON(ctx, p.ReportPath, in, &out); e != nil {
		return e
	}
	if out.Schema != p.Schema || !out.Accepted {
		return ErrControl
	}
	return nil
}
func (c *Client) Artifact(ctx context.Context, in p.ArtifactRequest) (io.ReadCloser, error) {
	b, e := c.signedBody(p.ArtifactPath, in)
	if e != nil {
		return nil, e
	}
	response, e := c.request(ctx, p.ArtifactPath, b)
	if e != nil {
		return nil, e
	}
	kind, _, e := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if e != nil || response.StatusCode != http.StatusOK || kind != "application/gzip" || response.ContentLength > p.MaxArchiveBytes {
		response.Body.Close()
		return nil, ErrControl
	}
	return response.Body, nil
}
func (c *Client) signedBody(path string, in any) ([]byte, error) {
	value, key, cert, e := c.loadIdentity()
	if e != nil {
		return nil, e
	}
	defer clear(key)
	signed, e := p.NewSignedRequest(path, in, value.CertificatePEM, cert.SerialNumber.Text(16), key, c.now())
	if e != nil {
		return nil, ErrControl
	}
	return json.Marshal(signed)
}
func (c *Client) signedJSON(ctx context.Context, path string, in, out any) error {
	b, e := c.signedBody(path, in)
	if e != nil {
		return e
	}
	return c.jsonRequest(ctx, path, b, out)
}
func (c *Client) request(ctx context.Context, path string, body []byte) (*http.Response, error) {
	r, e := http.NewRequestWithContext(ctx, http.MethodPost, c.config.ControlPlaneURL+path, bytes.NewReader(body))
	if e != nil {
		return nil, ErrControl
	}
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Accept", "application/json")
	response, e := c.http.Do(r)
	if e != nil {
		return nil, ErrControl
	}
	return response, nil
}
func (c *Client) jsonRequest(ctx context.Context, path string, body []byte, out any) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	r, e := c.request(ctx, path, body)
	if e != nil {
		return e
	}
	defer r.Body.Close()
	media, _, e := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if e != nil || media != "application/json" || (r.StatusCode != 200 && r.StatusCode != 201 && r.StatusCode != 202) {
		_, _ = io.Copy(io.Discard, io.LimitReader(r.Body, 4096))
		return ErrControl
	}
	if p.DecodeStrict(r.Body, p.MaxBodyBytes, out) != nil {
		return ErrControl
	}
	return nil
}

func updaterIdentity(machine p.MachineKey) string {
	enc := func(s string) string { return base64.RawURLEncoding.EncodeToString([]byte(s)) }
	return "spiffe://yggdrasil.invalid/updater/" + enc(machine.PlatformID) + "/" + enc(machine.ScopeID) + "/" + enc(machine.MachineID)
}
func parseIdentity(value identity, machine p.MachineKey, now time.Time) (ed25519.PrivateKey, *x509.Certificate, error) {
	key, e := base64.RawStdEncoding.DecodeString(value.PrivateKey)
	if e != nil || len(key) != ed25519.PrivateKeySize {
		return nil, nil, ErrIdentity
	}
	block, rest := pem.Decode([]byte(value.CertificatePEM))
	if block == nil || block.Type != "CERTIFICATE" || len(block.Headers) != 0 || len(bytes.TrimSpace(rest)) != 0 {
		clear(key)
		return nil, nil, ErrIdentity
	}
	cert, e := x509.ParseCertificate(block.Bytes)
	private := ed25519.PrivateKey(key)
	if e != nil {
		clear(key)
		return nil, nil, ErrIdentity
	}
	public, ok := cert.PublicKey.(ed25519.PublicKey)
	if !ok || !bytes.Equal(public, private.Public().(ed25519.PublicKey)) || cert.IsCA || cert.SerialNumber == nil || len(cert.URIs) != 1 || cert.URIs[0].String() != updaterIdentity(machine) || now.Before(cert.NotBefore) || !now.Before(cert.NotAfter) || len(cert.ExtKeyUsage) != 1 || cert.ExtKeyUsage[0] != x509.ExtKeyUsageClientAuth {
		clear(key)
		return nil, nil, ErrIdentity
	}
	return private, cert, nil
}
func (c *Client) loadIdentity() (identity, ed25519.PrivateKey, *x509.Certificate, error) {
	var value identity
	if readJSON(filepath.Join(c.config.StateDirectory, "identity.json"), &value) != nil {
		return value, nil, nil, ErrIdentity
	}
	key, cert, e := parseIdentity(value, c.config.Machine, c.now())
	return value, key, cert, e
}

// Enroll persists the CSR before transmitting a one-use token, so retry after
// a lost response redeems exactly the same key and the server's same receipt.
func (c *Client) Enroll(ctx context.Context, tokenFile string) error {
	if e := prepareDirectories(c.config); e != nil {
		return e
	}
	unlock, e := lockState(filepath.Join(c.config.StateDirectory, "lock"))
	if e != nil {
		return e
	}
	defer unlock()
	if _, key, _, e := c.loadIdentity(); e == nil {
		clear(key)
		return nil
	}
	if _, e := os.Lstat(filepath.Join(c.config.StateDirectory, "identity.json")); e == nil {
		return ErrIdentity
	}
	token, e := safeRead(tokenFile, 512, true)
	if e != nil {
		return ErrIdentity
	}
	defer clear(token)
	raw := strings.TrimSpace(string(token))
	if !strings.HasPrefix(raw, "yenr1_") || len(raw) > 256 {
		return ErrIdentity
	}
	path := filepath.Join(c.config.StateDirectory, "enrollment-pending.json")
	var value identity
	if e = readJSON(path, &value); errors.Is(e, os.ErrNotExist) {
		_, private, generateErr := ed25519.GenerateKey(rand.Reader)
		if generateErr != nil {
			return generateErr
		}
		defer clear(private)
		csr, generateErr := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{}, private)
		if generateErr != nil {
			return generateErr
		}
		value = identity{PrivateKey: base64.RawStdEncoding.EncodeToString(private), CSRPEM: string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: csr}))}
		if e = atomicJSON(path, value); e != nil {
			return e
		}
	} else if e != nil {
		return ErrIdentity
	}
	var out p.CertificateResponse
	body, _ := json.Marshal(p.EnrollRequest{Token: raw, CSRPEM: value.CSRPEM})
	if e = c.jsonRequest(ctx, p.EnrollPath, body, &out); e != nil {
		return e
	}
	if e = c.saveCertificate(value, out); e != nil {
		return e
	}
	return removeDurable(path)
}
func (c *Client) saveCertificate(value identity, out p.CertificateResponse) error {
	if out.PlatformID != c.config.Machine.PlatformID || out.ScopeID != c.config.Machine.ScopeID || out.MachineID != c.config.Machine.MachineID || out.Identity != updaterIdentity(c.config.Machine) {
		return ErrIdentity
	}
	value.CertificatePEM = out.CertificatePEM
	value.CSRPEM = ""
	key, cert, e := parseIdentity(value, c.config.Machine, c.now())
	if e != nil {
		return e
	}
	defer clear(key)
	if cert.SerialNumber.Text(16) != out.Serial || !cert.NotBefore.Equal(out.NotBefore) || !cert.NotAfter.Equal(out.NotAfter) {
		return ErrIdentity
	}
	return atomicJSON(filepath.Join(c.config.StateDirectory, "identity.json"), value)
}
func (c *Client) Renew(ctx context.Context) error {
	unlock, e := lockState(filepath.Join(c.config.StateDirectory, "lock"))
	if e != nil {
		return e
	}
	defer unlock()
	value, key, cert, e := c.loadIdentity()
	if e != nil {
		return e
	}
	defer clear(key)
	if cert.NotAfter.Sub(c.now()) > 30*24*time.Hour {
		return nil
	}
	csr, e := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{}, key)
	if e != nil {
		return e
	}
	var out p.CertificateResponse
	if e = c.signedJSON(ctx, p.RenewPath, p.RenewRequest{CSRPEM: string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: csr}))}, &out); e != nil {
		return e
	}
	return c.saveCertificate(value, out)
}
