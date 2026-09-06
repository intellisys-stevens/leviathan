package kubernetesbridge

import (
	"context"
	"encoding/json"
	resourcev1 "k8s.io/api/resource/v1"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/intellisys-stevens/leviathan/internal/attribution"
	"github.com/intellisys-stevens/leviathan/internal/model"
)

func TestServerPublishesVersionedSanitizedDocument(t *testing.T) {
	at := time.Unix(1_700_000_000, 0).UTC()
	state := newStateWithInstance("test", "synthetic-node", "instance_11111111111111111111111111111111", at)
	workload := model.WorkloadAttribution{Ref: "workspace_22222222222222222222222222222222", Platform: model.WorkloadPlatformCoder, Kind: model.WorkloadKindWorkspace, Name: "workspace", OwnerName: "owner"}
	state.Update([]model.WorkloadAttribution{workload}, []model.ResourceAssignment{{
		WorkloadRef: workload.Ref, EntityType: model.AllocationEntityPhysicalGPU,
		EntityUUID: "GPU-synthetic-one", State: model.AllocationStateReserved,
	}}, []attribution.ProcessScope{{ScopeRef: "scope_33333333333333333333333333333333", WorkloadRef: workload.Ref}}, BuildStats{MatchedAllocations: 1, ProcessScopes: 1}, at)
	server := NewServer(state)
	server.now = func() time.Time { return at }
	socket := filepath.Join(t.TempDir(), "bridge.sock")
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- ServeUnix(ctx, socket, server.Handler()) }()
	waitForSocket(t, socket)

	client := unixHTTPClient(socket)
	response, err := client.Get("http://unix/v1/allocations")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var document attribution.Document
	if err := json.NewDecoder(response.Body).Decode(&document); err != nil {
		t.Fatal(err)
	}
	if err := document.Validate(); err != nil {
		t.Fatal(err)
	}
	if document.SchemaVersion != attribution.SchemaVersion || document.NodeRef == "synthetic-node" {
		t.Fatalf("bridge document = %+v", document)
	}
	if len(document.ProcessScopes) != 1 || document.ProcessScopes[0].WorkloadRef != workload.Ref {
		t.Fatalf("bridge process scopes = %+v", document.ProcessScopes)
	}
	info, err := os.Stat(socket)
	if err != nil {
		t.Fatalf("stat socket: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("socket mode = %v", info.Mode().Perm())
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestServeUnixRefusesRegularFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bridge.sock")
	if err := os.WriteFile(path, []byte("do not replace"), 0o600); err != nil {
		t.Fatal(err)
	}
	err := ServeUnix(context.Background(), path, http.NewServeMux())
	if err == nil {
		t.Fatal("regular file was replaced")
	}
	data, readErr := os.ReadFile(path)
	if readErr != nil || string(data) != "do not replace" {
		t.Fatalf("regular file changed: %q, %v", data, readErr)
	}
}

func TestServeUnixRefusesSymlinkedParent(t *testing.T) {
	realDirectory := t.TempDir()
	linkRoot := t.TempDir()
	linkedDirectory := filepath.Join(linkRoot, "handoff")
	if err := os.Symlink(realDirectory, linkedDirectory); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(linkedDirectory, "bridge.sock")
	if err := ServeUnix(context.Background(), path, http.NewServeMux()); err == nil {
		t.Fatal("symlinked socket parent was accepted")
	}
	if _, err := os.Lstat(filepath.Join(realDirectory, "bridge.sock")); !os.IsNotExist(err) {
		t.Fatalf("unexpected socket through symlink: %v", err)
	}
}

func waitForSocket(t *testing.T, path string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if info, err := os.Stat(path); err == nil && info.Mode()&os.ModeSocket != 0 {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("Unix socket did not appear")
}

func unixHTTPClient(socket string) *http.Client {
	dialer := &net.Dialer{Timeout: time.Second}
	return &http.Client{
		Timeout: time.Second,
		Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return dialer.DialContext(ctx, "unix", socket)
		}},
	}
}

func TestServerV2KeepsDynamicBindingsPrivateAndV1Unchanged(t *testing.T) {
	c, slices := dynamicInventoryFixture()
	modern := BuildInventoryV2([]*resourcev1.ResourceClaim{c}, slices, "node", "gpu.nvidia.com")
	w, a, scopes, stats := BuildInventory([]*resourcev1.ResourceClaim{c}, slices, "node", "gpu.nvidia.com")
	state := NewState("test", "node", time.Now())
	state.UpdateInventories(w, a, scopes, stats, modern, time.Now())
	handler := NewServer(state).Handler()
	for _, version := range []string{"v1", "v2"} {
		rr := httptest.NewRecorder()
		handler.ServeHTTP(rr, httptest.NewRequest("GET", "/"+version+"/allocations", nil))
		if rr.Code != 200 || rr.Header().Get("Cache-Control") != "no-store" {
			t.Fatal(rr.Code)
		}
		var payload map[string]json.RawMessage
		if err := json.Unmarshal(rr.Body.Bytes(), &payload); err != nil {
			t.Fatal(err)
		}
		if version == "v1" {
			if payload["bindings"] != nil || payload["resolution"] != nil {
				t.Fatal("v1 shape changed")
			}
		} else {
			var d attribution.DocumentV2
			if err := json.Unmarshal(rr.Body.Bytes(), &d); err != nil {
				t.Fatal(err)
			}
			if err := d.Validate(); err != nil {
				t.Fatal(err)
			}
			if len(d.Bindings) != 2 || len(d.Assignments) != 1 || d.Resolution.Status != "complete" {
				t.Fatal(d)
			}
		}
	}
}
