package attribution

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/intellisys-stevens/miglens/internal/model"
	"github.com/intellisys-stevens/miglens/internal/provider"
)

func TestClientFreshStaleAndExpiredInventory(t *testing.T) {
	now := time.Unix(1_700_000_000, 0).UTC()
	document := validDocument(now)
	socket, closeServer := serveDocument(t, func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "application/json; charset=utf-8")
		payload := map[string]any{}
		data, _ := json.Marshal(document)
		_ = json.Unmarshal(data, &payload)
		payload["futureCompatibleField"] = true
		_ = json.NewEncoder(writer).Encode(payload)
	})
	defer closeServer()

	options := testOptions(socket, &now)
	client, err := NewClient(options)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if err := client.Poll(context.Background()); err != nil {
		t.Fatal(err)
	}
	fresh := client.Current(now)
	if fresh.Provider != model.AttributionProviderKubernetesDRA || fresh.Status != model.AttributionAvailable || fresh.ObservedAt == nil || len(fresh.Assignments) != 1 {
		t.Fatalf("fresh attribution = %+v", fresh)
	}

	now = now.Add(16 * time.Second)
	stale := client.Current(now)
	if stale.Status != model.AttributionStale || len(stale.Assignments) != 1 {
		t.Fatalf("stale attribution = %+v", stale)
	}
	now = now.Add(45 * time.Second)
	expired := client.Current(now)
	if expired.Status != model.AttributionUnavailable || expired.ObservedAt != nil || len(expired.Assignments) != 0 || len(expired.Workloads) != 0 {
		t.Fatalf("expired attribution = %+v", expired)
	}
}

func TestClientRetainsLastDocumentAcrossBridgeFailure(t *testing.T) {
	now := time.Unix(1_700_000_000, 0).UTC()
	document := validDocument(now)
	socket, closeServer := serveDocument(t, func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(document)
	})
	options := testOptions(socket, &now)
	client, err := NewClient(options)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if err := client.Poll(context.Background()); err != nil {
		t.Fatal(err)
	}
	closeServer()
	if err := client.Poll(context.Background()); err == nil {
		t.Fatal("missing bridge unexpectedly succeeded")
	}
	now = now.Add(10 * time.Second)
	if current := client.Current(now); current.Status != model.AttributionAvailable || len(current.Assignments) != 1 {
		t.Fatalf("grace-period attribution = %+v", current)
	}
	now = now.Add(6 * time.Second)
	if current := client.Current(now); current.Status != model.AttributionStale || len(current.Assignments) != 1 {
		t.Fatalf("post-grace attribution = %+v", current)
	}
}

func TestClientUsesAgeForGraceEvenWhenSourceReportsFailure(t *testing.T) {
	for _, sourceState := range []SourceState{SourceStale, SourceError} {
		t.Run(string(sourceState), func(t *testing.T) {
			now := time.Unix(1_700_000_000, 0).UTC()
			document := validDocument(now)
			document.Status = SourceStatus{State: sourceState, HasValidInventory: true, Message: "sanitized source status"}
			socket, closeServer := serveDocument(t, func(writer http.ResponseWriter, _ *http.Request) {
				writer.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(writer).Encode(document)
			})
			defer closeServer()
			client, err := NewClient(testOptions(socket, &now))
			if err != nil {
				t.Fatal(err)
			}
			defer client.Close()
			if err := client.Poll(context.Background()); err != nil {
				t.Fatal(err)
			}
			if current := client.Current(now.Add(14 * time.Second)); current.Status != model.AttributionAvailable || len(current.Assignments) != 1 {
				t.Fatalf("grace attribution = %+v", current)
			}
			if current := client.Current(now.Add(15 * time.Second)); current.Status != model.AttributionStale || len(current.Assignments) != 1 {
				t.Fatalf("stale attribution = %+v", current)
			}
		})
	}
}

func TestClientDoesNotReplaceValidInventoryWithSynchronizingDocument(t *testing.T) {
	now := time.Unix(1_700_000_000, 0).UTC()
	document := validDocument(now)
	socket, closeServer := serveDocument(t, func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(document)
	})
	defer closeServer()
	client, err := NewClient(testOptions(socket, &now))
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()

	document.Status = SourceStatus{State: SourceStale, Message: "synchronizing"}
	document.Workloads = nil
	document.Assignments = nil
	if err := client.Poll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if current := client.Current(now); current.Status != model.AttributionUnavailable {
		t.Fatalf("initial synchronizing attribution = %+v", current)
	}

	document = validDocument(now)
	if err := client.Poll(context.Background()); err != nil {
		t.Fatal(err)
	}
	document.Status = SourceStatus{State: SourceStale, Message: "synchronizing"}
	document.Workloads = nil
	document.Assignments = nil
	if err := client.Poll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if current := client.Current(now.Add(10 * time.Second)); current.Status != model.AttributionAvailable || len(current.Assignments) != 1 {
		t.Fatalf("retained attribution = %+v", current)
	}
}

func TestClientRejectsFutureDocument(t *testing.T) {
	now := time.Unix(1_700_000_000, 0).UTC()
	document := validDocument(now.Add(2 * time.Minute))
	socket, closeServer := serveDocument(t, func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(document)
	})
	defer closeServer()
	client, err := NewClient(testOptions(socket, &now))
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if err := client.Poll(context.Background()); err == nil {
		t.Fatal("future bridge document was accepted")
	}
	if current := client.Current(now); current.Status != model.AttributionUnavailable || len(current.Assignments) != 0 {
		t.Fatalf("future document attribution = %+v", current)
	}
}

func TestClientRejectsOversizedDocument(t *testing.T) {
	now := time.Unix(1_700_000_000, 0).UTC()
	socket, closeServer := serveDocument(t, func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(strings.Repeat("x", 257)))
	})
	defer closeServer()
	options := testOptions(socket, &now)
	options.MaxDocumentBytes = 256
	client, err := NewClient(options)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if err := client.Poll(context.Background()); err == nil {
		t.Fatal("oversized document was accepted")
	}
}

func TestProviderDecoratesWithoutChangingBaseCapabilities(t *testing.T) {
	now := time.Unix(1_700_000_000, 0).UTC()
	client, err := NewClient(testOptions(filepath.Join(t.TempDir(), "absent.sock"), &now))
	if err != nil {
		t.Fatal(err)
	}
	base := &stubProvider{}
	decorated := NewProvider(base, client)
	if err := decorated.Open(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer decorated.Close()
	snapshot, err := decorated.Sample(context.Background(), now)
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Attribution == nil || snapshot.Attribution.Status != model.AttributionUnavailable {
		t.Fatalf("missing bridge attribution = %+v", snapshot.Attribution)
	}
	if decorated.Capabilities() != base.Capabilities() {
		t.Fatal("base capabilities changed")
	}
}

func testOptions(socket string, now *time.Time) ClientOptions {
	options := DefaultClientOptions(socket)
	options.PollInterval = time.Hour
	options.RequestTimeout = 250 * time.Millisecond
	options.Now = func() time.Time { return *now }
	return options
}

func serveDocument(t *testing.T, handler http.HandlerFunc) (string, func()) {
	t.Helper()
	directory := t.TempDir()
	socket := filepath.Join(directory, "bridge.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: handler}
	go func() { _ = server.Serve(listener) }()
	closed := false
	return socket, func() {
		if closed {
			return
		}
		closed = true
		_ = server.Close()
		_ = listener.Close()
		_ = os.Remove(socket)
	}
}

type stubProvider struct{}

func (*stubProvider) Name() string               { return "stub" }
func (*stubProvider) Open(context.Context) error { return nil }
func (*stubProvider) Close() error               { return nil }
func (*stubProvider) Capabilities() model.Capabilities {
	return model.Capabilities{NVML: model.ProviderState{Name: "stub", Available: true, Status: model.StatusAvailable}}
}
func (*stubProvider) Sample(_ context.Context, at time.Time) (model.Snapshot, error) {
	return model.Snapshot{SampledAt: at}, nil
}

var _ provider.Provider = (*stubProvider)(nil)
