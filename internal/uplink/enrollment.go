package uplink

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"golang.org/x/sys/unix"
)

const JoinPath = "/api/enrollment/v1/join"
const RenewPath = "/api/enrollment/v1/renew"

type MachineKey struct {
	PlatformID string `json:"platformId"`
	ScopeID    string `json:"scopeId"`
	MachineID  string `json:"machineId"`
}

type EnrollmentReceipt struct {
	Machine       MachineKey `json:"machine"`
	ExpiresAt     time.Time  `json:"expiresAt"`
	RenewAfter    time.Time  `json:"renewAfter"`
	UplinkVersion string     `json:"uplinkVersion"`
	UplinkURL     string     `json:"uplinkURL"`
}

type JoinRequest struct {
	Ticket       string `json:"ticket"`
	Token        string `json:"token"`
	Hostname     string `json:"hostname"`
	OS           string `json:"os"`
	Arch         string `json:"arch"`
	AgentVersion string `json:"agentVersion"`
}

type pendingEnrollment struct {
	Server       string `json:"server"`
	TicketDigest string `json:"ticketDigest"`
	Token        string `json:"token"`
}

type enrollmentState struct {
	Server       string             `json:"server"`
	TicketDigest string             `json:"ticketDigest"`
	Token        string             `json:"token"`
	PendingToken string             `json:"pendingToken,omitempty"`
	PendingJoin  *pendingEnrollment `json:"pendingJoin,omitempty"`
	Receipt      EnrollmentReceipt  `json:"receipt"`
}

// EnrollmentClient uses outbound HTTPS. A supplied client is useful for a
// private certificate authority; redirects and cookies remain disabled.
type EnrollmentClient struct {
	server string
	client *http.Client
	now    func() time.Time
}

func NewEnrollmentClient(server string, client *http.Client) (*EnrollmentClient, error) {
	parsed, err := parseBaseURL(server)
	if err != nil {
		return nil, err
	}
	server = parsed.String()
	if client == nil {
		client = &http.Client{Transport: http.DefaultTransport.(*http.Transport).Clone()}
	}
	copy := *client
	copy.Timeout = 15 * time.Second
	copy.Jar = nil
	copy.CheckRedirect = func(*http.Request, []*http.Request) error { return ErrRedirectBlocked }
	return &EnrollmentClient{server: server, client: &copy, now: time.Now}, nil
}

// Join persists the agent-created secret before redemption. A lost response
// can therefore be retried with exactly the same secret without central storage
// of plaintext credentials.
func (c *EnrollmentClient) Join(ctx context.Context, statePath string, request JoinRequest) (EnrollmentReceipt, error) {
	unlock, err := lockEnrollment(ctx, statePath)
	if err != nil {
		return EnrollmentReceipt{}, err
	}
	defer unlock()
	state, err := readEnrollment(statePath)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return EnrollmentReceipt{}, err
	}
	digest := sha256.Sum256([]byte(request.Ticket))
	ticketDigest := hex.EncodeToString(digest[:])
	if state.Token == "" {
		state = enrollmentState{Server: c.server, TicketDigest: ticketDigest}
		state.Token, err = newMachineToken()
		if err != nil {
			return EnrollmentReceipt{}, err
		}
		if err = writeEnrollment(statePath, state); err != nil {
			return EnrollmentReceipt{}, err
		}
	}
	if state.Server != c.server || state.TicketDigest != ticketDigest {
		// A replacement ticket is an explicit new enrollment. Keep the active
		// credential usable until the replacement receipt is safely persisted.
		pending := state.PendingJoin
		if pending == nil || pending.Server != c.server || pending.TicketDigest != ticketDigest {
			token, err := newMachineToken()
			if err != nil {
				return EnrollmentReceipt{}, err
			}
			pending = &pendingEnrollment{Server: c.server, TicketDigest: ticketDigest, Token: token}
			state.PendingJoin = pending
			if err = writeEnrollment(statePath, state); err != nil {
				return EnrollmentReceipt{}, err
			}
		}
		request.Token = pending.Token
		receipt, _, err := c.exchange(ctx, JoinPath, "", request)
		if err != nil {
			return EnrollmentReceipt{}, err
		}
		replacement := enrollmentState{Server: c.server, TicketDigest: ticketDigest, Token: pending.Token, Receipt: receipt}
		if err = writeEnrollment(statePath, replacement); err != nil {
			return EnrollmentReceipt{}, err
		}
		return receipt, nil
	}
	var receipt EnrollmentReceipt
	if state.Receipt.Machine.MachineID != "" {
		// A completed enrollment can be rerun after the ticket recovery window.
		// Authenticate the retained credential without extending its lifetime.
		next := state.Token
		if state.PendingToken != "" {
			next = state.PendingToken
		}
		var status int
		receipt, status, err = c.exchange(ctx, RenewPath, state.Token, map[string]string{"token": next})
		if status == http.StatusUnauthorized && state.PendingToken != "" {
			receipt, _, err = c.exchange(ctx, RenewPath, next, map[string]string{"token": next})
		}
		if err == nil && receipt.Machine != state.Receipt.Machine {
			return EnrollmentReceipt{}, errors.New("enrollment changed machine identity")
		}
		if err == nil {
			state.Token, state.PendingToken = next, ""
		}
	} else {
		request.Token = state.Token
		receipt, _, err = c.exchange(ctx, JoinPath, "", request)
	}
	if err != nil {
		return EnrollmentReceipt{}, err
	}
	state.Receipt = receipt
	if err = writeEnrollment(statePath, state); err != nil {
		return EnrollmentReceipt{}, err
	}
	return receipt, nil
}

func (c *EnrollmentClient) exchange(ctx context.Context, path, token string, value any) (EnrollmentReceipt, int, error) {
	body, err := json.Marshal(value)
	if err != nil {
		return EnrollmentReceipt{}, 0, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.server+path, bytes.NewReader(body))
	if err != nil {
		return EnrollmentReceipt{}, 0, errors.New("invalid enrollment request")
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	response, err := c.client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return EnrollmentReceipt{}, 0, ctx.Err()
		}
		return EnrollmentReceipt{}, 0, errors.New("enrollment request failed; verify HTTPS trust and proxy settings, then retry with the same join ticket and state directory")
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return EnrollmentReceipt{}, response.StatusCode, fmt.Errorf("enrollment rejected (HTTP %d)", response.StatusCode)
	}
	document, err := io.ReadAll(io.LimitReader(response.Body, 16385))
	if err != nil || len(document) > 16384 {
		if ctx.Err() != nil {
			return EnrollmentReceipt{}, response.StatusCode, ctx.Err()
		}
		return EnrollmentReceipt{}, response.StatusCode, errors.New("invalid enrollment receipt")
	}
	var receipt EnrollmentReceipt
	if err = json.Unmarshal(document, &receipt); err != nil || receipt.Machine.PlatformID == "" || receipt.Machine.ScopeID == "" || receipt.Machine.MachineID == "" || !receipt.ExpiresAt.After(c.now()) || receipt.RenewAfter.IsZero() || !receipt.RenewAfter.Before(receipt.ExpiresAt) || receipt.UplinkVersion != "uplink-v2" || receipt.UplinkURL != c.server+EndpointPathV2 {
		return EnrollmentReceipt{}, response.StatusCode, errors.New("invalid enrollment receipt")
	}
	return receipt, response.StatusCode, nil
}

type EnrollmentTokenSource struct {
	path       string
	enrollment *EnrollmentClient
	mu         sync.Mutex
	retryAt    time.Time
}

func NewEnrollmentTokenSource(path, server string, client *http.Client) (*EnrollmentTokenSource, error) {
	c, err := NewEnrollmentClient(server, client)
	if err != nil {
		return nil, err
	}
	state, err := readEnrollment(path)
	if err != nil {
		return nil, err
	}
	if state.Server != c.server || state.Receipt.Machine.MachineID == "" {
		return nil, errors.New("enrollment state does not match this server")
	}
	return &EnrollmentTokenSource{path: path, enrollment: c}, nil
}

func (s *EnrollmentTokenSource) Token(ctx context.Context) (string, error) {
	unlock, err := lockEnrollment(ctx, s.path)
	if err != nil {
		return "", err
	}
	defer unlock()
	state, err := readEnrollment(s.path)
	if err != nil {
		return "", err
	}
	if state.Server != s.enrollment.server {
		return "", errors.New("enrollment state does not match this server")
	}
	now := s.enrollment.now()
	if now.Before(state.Receipt.RenewAfter) && state.PendingToken == "" {
		return state.Token, nil
	}
	s.mu.Lock()
	retryAt := s.retryAt
	s.mu.Unlock()
	if now.Before(retryAt) {
		if now.Before(state.Receipt.ExpiresAt) {
			return state.Token, nil
		}
		return "", errors.New("enrollment credential expired")
	}
	if state.PendingToken == "" {
		state.PendingToken, err = newMachineToken()
		if err != nil {
			return "", err
		}
		if err = writeEnrollment(s.path, state); err != nil {
			return "", err
		}
	}
	body := map[string]string{"token": state.PendingToken}
	receipt, status, err := s.enrollment.exchange(ctx, RenewPath, state.Token, body)
	if status == http.StatusUnauthorized {
		receipt, _, err = s.enrollment.exchange(ctx, RenewPath, state.PendingToken, body)
	}
	if err != nil {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		s.mu.Lock()
		s.retryAt = now.Add(time.Minute)
		s.mu.Unlock()
		if now.Before(state.Receipt.ExpiresAt) {
			return state.Token, nil
		}
		return "", err
	}
	if receipt.Machine != state.Receipt.Machine {
		return "", errors.New("renewal changed machine identity")
	}
	state.Token, state.PendingToken, state.Receipt = state.PendingToken, "", receipt
	if err = writeEnrollment(s.path, state); err != nil {
		return "", err
	}
	return state.Token, nil
}

func newMachineToken() (string, error) {
	lookup, secret := make([]byte, 16), make([]byte, 32)
	if _, err := rand.Read(lookup); err != nil {
		return "", err
	}
	if _, err := rand.Read(secret); err != nil {
		return "", err
	}
	return "yv1_" + base64.RawURLEncoding.EncodeToString(lookup) + "_" + base64.RawURLEncoding.EncodeToString(secret), nil
}

func readEnrollment(path string) (enrollmentState, error) {
	var state enrollmentState
	info, err := os.Lstat(path)
	if err != nil {
		return state, err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
		return state, ErrCredentialInsecure
	}
	body, err := os.ReadFile(path)
	if err != nil {
		return state, ErrCredentialRead
	}
	if len(body) > 16384 || json.Unmarshal(body, &state) != nil || !validMachineToken(state.Token) || (state.PendingToken != "" && !validMachineToken(state.PendingToken)) {
		return state, ErrCredentialInvalid
	}
	if state.PendingJoin != nil && (!validMachineToken(state.PendingJoin.Token) || state.PendingJoin.Server == "" || state.PendingJoin.TicketDigest == "") {
		return state, ErrCredentialInvalid
	}
	return state, nil
}
func writeEnrollment(path string, state enrollmentState) error {
	body, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	return AtomicWriteFile(path, append(body, '\n'), 0600)
}
func lockEnrollment(ctx context.Context, path string) (func(), error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return nil, ErrCredentialRead
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(path+".lock", os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	for {
		if err = ctx.Err(); err != nil {
			file.Close()
			return nil, err
		}
		if err = unix.Flock(int(file.Fd()), unix.LOCK_EX|unix.LOCK_NB); err == nil {
			return func() { _ = unix.Flock(int(file.Fd()), unix.LOCK_UN); _ = file.Close() }, nil
		}
		if err != unix.EWOULDBLOCK && err != unix.EAGAIN {
			file.Close()
			return nil, err
		}
		select {
		case <-ctx.Done():
			file.Close()
			return nil, ctx.Err()
		case <-time.After(25 * time.Millisecond):
		}
	}
}
