package uplink

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestJoinLostResponsePreservesSecretAndRerunIdentity(t *testing.T) {
	var mu sync.Mutex
	var token string
	var calls int
	var origin string
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if r.URL.Path == RenewPath && r.Header.Get("Authorization") == "Bearer "+token {
			_ = json.NewEncoder(w).Encode(testEnrollmentReceipt(origin, time.Now()))
			return
		}
		if r.URL.Path != JoinPath {
			t.Errorf("path = %s", r.URL.Path)
			w.WriteHeader(404)
			return
		}
		var request JoinRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error(err)
			w.WriteHeader(400)
			return
		}
		if request.Ticket != "one-time-ticket" || !validMachineToken(request.Token) {
			t.Error("invalid join request")
			w.WriteHeader(400)
			return
		}
		if token == "" {
			token = request.Token
		} else if token != request.Token {
			t.Error("lost-response retry regenerated secret")
			w.WriteHeader(409)
			return
		}
		calls++
		if calls == 1 {
			connection, _, err := w.(http.Hijacker).Hijack()
			if err != nil {
				t.Error(err)
			} else {
				connection.Close()
			}
			return
		}
		_ = json.NewEncoder(w).Encode(testEnrollmentReceipt(origin, time.Now()))
	}))
	defer server.Close()
	origin = server.URL
	client, err := NewEnrollmentClient(origin, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "state.json")
	request := JoinRequest{Ticket: "one-time-ticket", Hostname: "server", OS: "linux", Arch: "arm64", AgentVersion: "test"}
	if _, err = client.Join(context.Background(), path, request); err == nil {
		t.Fatal("expected lost response")
	}
	state, err := readEnrollment(path)
	if err != nil || state.Token != token || state.Receipt.Machine.MachineID != "" {
		t.Fatalf("pending state: err=%v", err)
	}
	first, err := client.Join(context.Background(), path, request)
	if err != nil {
		t.Fatal(err)
	}
	second, err := client.Join(context.Background(), path, request)
	if err != nil || first.Machine != second.Machine {
		t.Fatalf("rerun identity: %v", err)
	}
	info, _ := os.Stat(path)
	if info.Mode().Perm() != 0600 {
		t.Fatal("state is not private")
	}
	body, _ := os.ReadFile(path)
	if strings.Contains(string(body), request.Ticket) {
		t.Fatal("persisted plaintext join ticket")
	}
}

func TestRenewalLostResponseAndRestartRetainPendingToken(t *testing.T) {
	now := time.Now().UTC()
	var origin string
	var accepted string
	var calls int
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != RenewPath {
			w.WriteHeader(404)
			return
		}
		var request struct {
			Token string `json:"token"`
		}
		_ = json.NewDecoder(r.Body).Decode(&request)
		if accepted == "" {
			accepted = request.Token
		} else if accepted != request.Token {
			t.Error("renewal regenerated pending token")
			w.WriteHeader(409)
			return
		}
		calls++
		if calls == 1 {
			connection, _, _ := w.(http.Hijacker).Hijack()
			connection.Close()
			return
		}
		_ = json.NewEncoder(w).Encode(testEnrollmentReceipt(origin, now))
	}))
	defer server.Close()
	origin = server.URL
	path := filepath.Join(t.TempDir(), "state.json")
	old, _ := newMachineToken()
	receipt := testEnrollmentReceipt(origin, now)
	receipt.RenewAfter = now.Add(-time.Hour)
	if err := writeEnrollment(path, enrollmentState{Server: origin, Token: old, Receipt: receipt}); err != nil {
		t.Fatal(err)
	}
	first, err := NewEnrollmentTokenSource(path, origin, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	got, err := first.Token(context.Background())
	if err != nil || got != old {
		t.Fatalf("failed renewal should retain unexpired old token: %v", err)
	}
	state, _ := readEnrollment(path)
	if state.PendingToken == "" || state.PendingToken != accepted || state.Token != old {
		t.Fatal("pending rotation was not saved before request")
	}
	restarted, err := NewEnrollmentTokenSource(path, origin, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	got, err = restarted.Token(context.Background())
	if err != nil || got != accepted {
		t.Fatalf("recover pending rotation: %v", err)
	}
	state, _ = readEnrollment(path)
	if state.PendingToken != "" || state.Token != accepted {
		t.Fatal("successful rotation was not promoted")
	}
}

func TestRenewalRecoversWithPendingCredentialAfterOverlap(t *testing.T) {
	var origin string
	pending, _ := newMachineToken()
	old, _ := newMachineToken()
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "Bearer "+old {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if r.Header.Get("Authorization") != "Bearer "+pending {
			t.Error("unexpected credential")
			w.WriteHeader(401)
			return
		}
		_ = json.NewEncoder(w).Encode(testEnrollmentReceipt(origin, time.Now()))
	}))
	defer server.Close()
	origin = server.URL
	path := filepath.Join(t.TempDir(), "state.json")
	receipt := testEnrollmentReceipt(origin, time.Now())
	receipt.RenewAfter = time.Now().Add(-time.Hour)
	receipt.ExpiresAt = time.Now().Add(-time.Minute)
	_ = writeEnrollment(path, enrollmentState{Server: origin, Token: old, PendingToken: pending, Receipt: receipt})
	source, err := NewEnrollmentTokenSource(path, origin, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	got, err := source.Token(context.Background())
	if err != nil || got != pending {
		t.Fatalf("pending recovery failed: %v", err)
	}
}

func testEnrollmentReceipt(origin string, now time.Time) EnrollmentReceipt {
	return EnrollmentReceipt{Machine: MachineKey{PlatformID: "agents", ScopeID: "default", MachineID: "test-host"}, ExpiresAt: now.Add(180 * 24 * time.Hour), RenewAfter: now.Add(150 * 24 * time.Hour), UplinkVersion: SchemaV2, UplinkURL: origin + EndpointPathV2}
}

func TestJoinReplacementTicketPreservesActiveStateAndRetriesAfterLostResponse(t *testing.T) {
	for _, alreadyJoined := range []bool{false, true} {
		t.Run(map[bool]string{false: "expired-first-ticket", true: "joined-machine"}[alreadyJoined], func(t *testing.T) {
			var origin, replacementToken string
			var replacementCalls int
			server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var request JoinRequest
				if json.NewDecoder(r.Body).Decode(&request) != nil {
					t.Error("invalid request")
					w.WriteHeader(400)
					return
				}
				receipt := testEnrollmentReceipt(origin, time.Now())
				if request.Ticket == "original-ticket" {
					if !alreadyJoined {
						w.WriteHeader(401)
						return
					}
					_ = json.NewEncoder(w).Encode(receipt)
					return
				}
				if request.Ticket != "replacement-ticket" {
					t.Error("unexpected ticket")
					w.WriteHeader(401)
					return
				}
				if replacementToken == "" {
					replacementToken = request.Token
				} else if replacementToken != request.Token {
					t.Error("replacement retry changed persisted token")
					w.WriteHeader(409)
					return
				}
				replacementCalls++
				if replacementCalls == 1 {
					connection, _, _ := w.(http.Hijacker).Hijack()
					_ = connection.Close()
					return
				}
				receipt.Machine.MachineID = "replacement"
				_ = json.NewEncoder(w).Encode(receipt)
			}))
			defer server.Close()
			origin = server.URL
			client, err := NewEnrollmentClient(origin, server.Client())
			if err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(t.TempDir(), "state.json")
			_, err = client.Join(context.Background(), path, JoinRequest{Ticket: "original-ticket"})
			if (err == nil) != alreadyJoined {
				t.Fatalf("initial enrollment result: %v", err)
			}
			original, err := readEnrollment(path)
			if err != nil {
				t.Fatal(err)
			}
			_, err = client.Join(context.Background(), path, JoinRequest{Ticket: "replacement-ticket"})
			if err == nil {
				t.Fatal("expected lost replacement response")
			}
			pending, err := readEnrollment(path)
			if err != nil || pending.Token != original.Token || pending.Receipt != original.Receipt || pending.PendingJoin == nil || pending.PendingJoin.Token != replacementToken || replacementToken == original.Token {
				t.Fatalf("replacement did not preserve previous state and pending token: %v", err)
			}
			if alreadyJoined {
				source, err := NewEnrollmentTokenSource(path, origin, server.Client())
				if err != nil {
					t.Fatal(err)
				}
				if token, err := source.Token(context.Background()); err != nil || token != original.Token {
					t.Fatalf("active uploader must keep original credential until replacement succeeds: %v", err)
				}
			}
			restarted, _ := NewEnrollmentClient(origin, server.Client())
			receipt, err := restarted.Join(context.Background(), path, JoinRequest{Ticket: "replacement-ticket"})
			if err != nil || receipt.Machine.MachineID != "replacement" {
				t.Fatalf("replacement retry failed: %v", err)
			}
			state, err := readEnrollment(path)
			if err != nil || state.PendingJoin != nil || state.Token != replacementToken || state.Receipt != receipt {
				t.Fatalf("replacement receipt was not atomically promoted: %v", err)
			}
		})
	}
}

func TestCanceledJoinDoesNotCreateCredentialState(t *testing.T) {
	client, err := NewEnrollmentClient("https://yggdrasil.example.test", nil)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "new", "state.json")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err = client.Join(ctx, path, JoinRequest{Ticket: "ticket"}); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled join returned %v", err)
	}
	if _, err = os.Stat(filepath.Dir(path)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("canceled join created credential state or lock")
	}
}

func TestCanceledRenewalPreservesPendingStateWithoutBackoff(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-release
	}))
	defer server.Close()
	defer close(release)
	path := filepath.Join(t.TempDir(), "state.json")
	token, _ := newMachineToken()
	receipt := testEnrollmentReceipt(server.URL, time.Now())
	receipt.RenewAfter = time.Now().Add(-time.Hour)
	if err := writeEnrollment(path, enrollmentState{Server: server.URL, Token: token, Receipt: receipt}); err != nil {
		t.Fatal(err)
	}
	source, err := NewEnrollmentTokenSource(path, server.URL, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { _, err := source.Token(ctx); done <- err }()
	receive(t, started)
	// Another caller waiting on this same source must honor its own context.
	waiting, stopWaiting := context.WithCancel(context.Background())
	stopWaiting()
	waitingDone := make(chan error, 1)
	go func() { _, err := source.Token(waiting); waitingDone <- err }()
	if err = receive(t, waitingDone); !errors.Is(err, context.Canceled) {
		t.Fatalf("waiting credential caller ignored cancellation: %v", err)
	}
	cancel()
	if err = receive(t, done); !errors.Is(err, context.Canceled) {
		t.Fatalf("renewal hid cancellation: %v", err)
	}
	state, err := readEnrollment(path)
	if err != nil || state.Token != token || state.PendingToken == "" || !source.retryAt.IsZero() {
		t.Fatalf("cancellation changed active credential or added renewal backoff: %v", err)
	}
}
