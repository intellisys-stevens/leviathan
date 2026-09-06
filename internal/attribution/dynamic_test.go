package attribution

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/intellisys-stevens/leviathan/internal/model"
)

const testClaimUID = "11111111-2222-3333-4444-555555555555"
const testBoot = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"

// This reproduces v0.4.1's nested checkpoint and checksum without importing
// driver code or recording any real claim, workspace, or checkpoint contents.
func checkpointFixture(t *testing.T, state, migUUID string, mutate func(map[string]any)) []byte {
	t.Helper()
	results := []any{}
	devices := []any{}
	for i, name := range []string{"dynamic-a", "dynamic-b"} {
		results = append(results, map[string]any{"request": "mig", "driver": "gpu.nvidia.com", "pool": "node", "device": name})
		devices = append(devices, map[string]any{"mig": map[string]any{
			"concrete": map[string]any{"parentUUID": "GPU-parent", "giId": 3 + i, "ciId": 0, "migUUID": migUUID},
			"device":   map[string]any{"Requests": []string{"mig"}, "PoolName": "node", "DeviceName": name, "CDIDeviceIDs": []string{"nvidia.com/gpu=private"}},
		}})
	}
	claim := map[string]any{"checkpointState": state, "status": map[string]any{"allocation": map[string]any{"devices": map[string]any{"results": results}}}, "preparedDevices": []any{map[string]any{"devices": devices}}}
	if mutate != nil {
		mutate(claim)
	}
	raw, _ := json.Marshal(map[string]any{testClaimUID: claim})
	v2 := checkpointV2{PreparedClaims: raw, NodeBootID: testBoot}
	data, _ := json.Marshal(v2)
	v2.Checksum = checkpointChecksum(data)
	data, _ = json.Marshal(map[string]any{"checksum": 0, "v1": map[string]any{}, "v2": v2})
	return data
}

func TestCheckpointValidationAndExactIdentity(t *testing.T) {
	data := checkpointFixture(t, "PrepareCompleted", "GPU-parent", nil)
	entries, err := parseCheckpoint(data, testBoot)
	if err != nil || len(entries) != 2 {
		t.Fatalf("parse: %v %v", entries, err)
	}
	ref := AllocationRef(testClaimUID, "mig", "gpu.nvidia.com", "node", "dynamic-a")
	if entries[ref].GIID != 3 || entries[ref].CIID != 0 || entries[ref].MIGUUID != "GPU-parent" {
		t.Fatal(entries)
	}
	for name, invalid := range map[string][]byte{
		"truncated":      data[:len(data)-3],
		"corrupt":        []byte(strings.Replace(string(data), "GPU-parent", "GPU-forged", 1)),
		"version":        []byte(`{"v3":{}}`),
		"duplicate":      []byte(`{"v2":{},"v2":{}}`),
		"oversize":       make([]byte, CheckpointMaxBytes+1),
		"foreign parent": checkpointFixture(t, "PrepareCompleted", "GPU-other", nil),
		"unknown state":  checkpointFixture(t, "FutureState", "GPU-parent", nil),
		"wrong device": checkpointFixture(t, "PrepareCompleted", "GPU-parent", func(c map[string]any) {
			c["status"] = map[string]any{"allocation": map[string]any{"devices": map[string]any{"results": []any{}}}}
		}),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := parseCheckpoint(invalid, testBoot); err == nil {
				t.Fatal("accepted invalid checkpoint")
			}
		})
	}
	if _, err := parseCheckpoint(data, "previous-boot"); err == nil {
		t.Fatal("wrong boot accepted")
	}
	entries, err = parseCheckpoint(checkpointFixture(t, "PrepareStarted", "GPU-parent", nil), testBoot)
	if err != nil || len(entries) != 0 {
		t.Fatal("pending preparation exposed")
	}
}

func TestCheckpointFilesAndAtomicReplacement(t *testing.T) {
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "checkpoint.json")
	data := checkpointFixture(t, "PrepareCompleted", "GPU-parent", nil)
	if err = os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	read := func() error { _, _, err := readCheckpointFile(path, testBoot, uint32(os.Getuid())); return err }
	if err = read(); err != nil {
		t.Fatal(err)
	}
	replacement := path + ".new"
	os.WriteFile(replacement, checkpointFixture(t, "PrepareStarted", "GPU-parent", nil), 0600)
	os.Rename(replacement, path)
	entries, _, err := readCheckpointFile(path, testBoot, uint32(os.Getuid()))
	if err != nil || len(entries) != 0 {
		t.Fatal("did not follow replacement", err)
	}
	os.Chmod(path, 0666)
	if read() == nil {
		t.Fatal("writable checkpoint accepted")
	}
	os.Chmod(path, 0600)
	if _, _, err = readCheckpointFile(path, testBoot, uint32(os.Getuid()+1)); err == nil {
		t.Fatal("wrong owner accepted")
	}
	link := path + ".link"
	os.Symlink(path, link)
	if _, _, err = readCheckpointFile(link, testBoot, uint32(os.Getuid())); err == nil {
		t.Fatal("symlink accepted")
	}
	os.Remove(path)
	if read() == nil {
		t.Fatal("missing checkpoint accepted")
	}
}

func TestCheckpointEpochRequiresVerifiedPreparation(t *testing.T) {
	now := time.Now()
	r := NewCheckpointReader("unused")
	data := checkpointFixture(t, "PrepareCompleted", "GPU-parent", nil)
	fail := false
	r.read = func() (map[string]preparedBinding, string, error) {
		if fail {
			return nil, "", errors.New("private path must not leak")
		}
		e, err := parseCheckpoint(data, testBoot)
		return e, string(data), err
	}
	r.Poll(now)
	first := r.Current(now)
	for _, e := range first.Entries {
		if e.Epoch == 0 {
			t.Fatal(e)
		}
	}
	r.Poll(now.Add(time.Second))
	if r.Current(now).Revision != first.Revision {
		t.Fatal("poll changed evidence")
	}
	fail = true
	r.Poll(now)
	if r.Current(now).Reason != "checkpoint_unavailable" {
		t.Fatal("unsanitized reason")
	}
	fail = false
	r.Poll(now)
	for _, e := range r.Current(now).Entries {
		if e.Epoch > 2 {
			t.Fatal("failure rearmed binding")
		}
	}
	data = checkpointFixture(t, "PrepareStarted", "GPU-parent", nil)
	r.Poll(now)
	data = checkpointFixture(t, "PrepareCompleted", "GPU-parent", nil)
	r.Poll(now)
	for _, e := range r.Current(now).Entries {
		if e.Epoch <= 2 {
			t.Fatal("new preparation missing epoch")
		}
	}
	if r.Current(now.Add(16*time.Second)).Reason != "checkpoint_stale" {
		t.Fatal("expired evidence accepted")
	}
}

func dynamicFixture(t *testing.T) (DocumentV2, model.Snapshot, checkpointObservation) {
	now := time.Now().UTC()
	d := DocumentV2{Document: validDocument(now), Resolution: CompleteResolution(), Bindings: []DynamicBinding{}}
	d.SchemaVersion = SchemaVersionV2
	workload := d.Workloads[0].Ref
	d.Assignments = []model.ResourceAssignment{{WorkloadRef: workload, EntityType: model.AllocationEntityPhysicalGPU, EntityUUID: "GPU-full", State: model.AllocationStateAllocated}}
	claimRef, _ := ClaimRef(testClaimUID)
	for _, name := range []string{"dynamic-a", "dynamic-b"} {
		d.Bindings = append(d.Bindings, DynamicBinding{Ref: AllocationRef(testClaimUID, "mig", "gpu.nvidia.com", "node", name), ClaimRef: claimRef, WorkloadRef: workload, ParentGPUUUID: "GPU-parent", Profile: "1g.24gb", State: model.AllocationStateAllocated})
	}
	s := model.Snapshot{Capabilities: model.Capabilities{NVML: model.ProviderState{Available: true, Status: model.StatusAvailable}}, GPUs: []model.GPU{
		{UUID: "GPU-free-a"}, {UUID: "GPU-free-b"}, {UUID: "GPU-full"}, {UUID: "GPU-parent", MIGEnabled: true, GPUInstances: []model.GPUInstance{
			{ID: 3, Profile: "1g.24gb", ComputeInstances: []model.ComputeInstance{{ID: 0, UUID: "MIG-a"}}},
			{ID: 4, Profile: "1g.24gb", ComputeInstances: []model.ComputeInstance{{ID: 0, UUID: "MIG-b"}}},
		}},
	}}
	entries, err := parseCheckpoint(checkpointFixture(t, "PrepareCompleted", "GPU-parent", nil), testBoot)
	if err != nil {
		t.Fatal(err)
	}
	for k, e := range entries {
		e.Epoch = 1
		entries[k] = e
	}
	return d, s, checkpointObservation{Entries: entries, ObservedAt: now, Revision: 1}
}

func resolveFixture(r *bindingResolver, d DocumentV2, s model.Snapshot, cp checkpointObservation) model.Attribution {
	res := CloneResolution(d.Resolution)
	a := model.Attribution{Status: model.AttributionAvailable, Workloads: d.Workloads, Assignments: append([]model.ResourceAssignment{}, d.Assignments...), Resolution: &res}
	r.resolve(&a, &d, s, cp)
	return a
}

func TestDynamicResolutionAndReuseGuard(t *testing.T) {
	d, s, cp := dynamicFixture(t)
	r := bindingResolver{}
	a := resolveFixture(&r, d, s, cp)
	if len(a.Assignments) != 3 || a.Resolution.Status != "complete" {
		t.Fatal(a)
	}
	// The two identical profiles bind by request/device plus GI/CI, never by order.
	if a.Assignments[0].EntityUUID != "MIG-a" || a.Assignments[1].EntityUUID != "MIG-b" {
		t.Fatal(a.Assignments)
	}
	s.GPUs[3].GPUInstances[0].ComputeInstances[0].UUID = "MIG-replaced"
	a = resolveFixture(&r, d, s, cp)
	if len(a.Assignments) != 2 || a.Resolution.UnresolvedAssignments != 1 || !strings.Contains(strings.Join(a.Resolution.ReasonCodes, ","), "binding_replaced") {
		t.Fatal(a)
	}
	a = resolveFixture(&r, d, s, cp)
	if len(a.Assignments) != 2 {
		t.Fatal("poll rearmed binding")
	}
	e := cp.Entries[d.Bindings[0].Ref]
	e.Epoch++
	cp.Entries[d.Bindings[0].Ref] = e
	a = resolveFixture(&r, d, s, cp)
	if len(a.Assignments) != 3 || a.Resolution.Status != "complete" {
		t.Fatal("new preparation did not bind", a)
	}
	// A normal process restart may establish identities from current boot evidence.
	a = resolveFixture(&bindingResolver{}, d, s, cp)
	if len(a.Assignments) != 3 {
		t.Fatal("startup", a)
	}
}

func TestResolutionFailuresNeverProveFreeCapacity(t *testing.T) {
	for _, reason := range []string{"checkpoint_disabled", "checkpoint_invalid", "checkpoint_unavailable", "checkpoint_stale", "binding_mismatch"} {
		t.Run(reason, func(t *testing.T) {
			d, s, cp := dynamicFixture(t)
			cp.Reason = reason
			a := resolveFixture(&bindingResolver{}, d, s, cp)
			if len(a.Assignments) != 1 || a.Resolution.Status != "incomplete" || a.Resolution.UnresolvedAssignments != 2 {
				t.Fatal(a)
			}
		})
	}
	for _, name := range []string{"parent", "profile", "pending", "topology", "duplicate tuple", "canonical mismatch", "extra preparation", "reservation", "multi CI", "conflict"} {
		t.Run(name, func(t *testing.T) {
			d, s, cp := dynamicFixture(t)
			want := 2
			switch name {
			case "parent":
				d.Bindings[0].ParentGPUUUID = "GPU-other"
			case "profile":
				d.Bindings[0].Profile = "2g.48gb"
			case "pending":
				delete(cp.Entries, d.Bindings[0].Ref)
			case "topology":
				s.Capabilities.NVML.Available = false
				want = 1
			case "duplicate tuple":
				s.GPUs[3].GPUInstances[0].ComputeInstances = append(s.GPUs[3].GPUInstances[0].ComputeInstances, model.ComputeInstance{ID: 0, UUID: "MIG-duplicate"})
			case "canonical mismatch":
				e := cp.Entries[d.Bindings[0].Ref]
				e.MIGUUID = "MIG-old"
				cp.Entries[d.Bindings[0].Ref] = e
			case "extra preparation":
				cp.Entries["extra"] = cp.Entries[d.Bindings[0].Ref]
				want = 3
			case "reservation":
				d.Bindings[0].State = model.AllocationStateReserved
				want = 3
			case "multi CI":
				e := cp.Entries[d.Bindings[1].Ref]
				e.GIID = 3
				e.CIID = 1
				cp.Entries[d.Bindings[1].Ref] = e
				s.GPUs[3].GPUInstances[0].ComputeInstances = append(s.GPUs[3].GPUInstances[0].ComputeInstances, model.ComputeInstance{ID: 1, UUID: "MIG-b"})
				s.GPUs[3].GPUInstances = s.GPUs[3].GPUInstances[:1]
				want = 3
			case "conflict":
				d.Assignments = append(d.Assignments, model.ResourceAssignment{WorkloadRef: "another", EntityType: model.AllocationEntityComputeInstance, EntityUUID: "MIG-a", State: model.AllocationStateAllocated})
			}
			a := resolveFixture(&bindingResolver{}, d, s, cp)
			if len(a.Assignments) != want {
				t.Fatal(a)
			}
			if name != "reservation" && name != "multi CI" && a.Resolution.Status != "incomplete" {
				t.Fatal("unsafe completeness", a)
			}
		})
	}
}

func TestV2ClientFallbackOrderingAndPrivacy(t *testing.T) {
	now := time.Now().UTC()
	d, _, _ := dynamicFixture(t)
	d.GeneratedAt = now
	d.SourceObservedAt = now
	legacy := false
	socket, closeServer := serveDocument(t, func(w http.ResponseWriter, r *http.Request) {
		if legacy && r.URL.Path == "/v2/allocations" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if legacy {
			v := d.Document
			v.SchemaVersion = SchemaVersion
			json.NewEncoder(w).Encode(v)
		} else {
			json.NewEncoder(w).Encode(d)
		}
	})
	defer closeServer()
	c, err := NewClient(testOptions(socket, &now))
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if err = c.Poll(context.Background()); err != nil {
		t.Fatal(err)
	}
	a := c.Current(now)
	if a.Resolution.UnresolvedAssignments != 2 {
		t.Fatal(a)
	}
	data, _ := json.Marshal(a)
	for _, private := range []string{testClaimUID, d.Bindings[0].Ref, d.Bindings[0].ClaimRef, "dynamic-a", "CDIDeviceIDs"} {
		if strings.Contains(string(data), private) {
			t.Fatal("private identity exposed")
		}
	}
	legacy = true
	if err = c.Poll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if a = c.Current(now); a.Status != model.AttributionAvailable || a.Resolution.Status != "unknown" || !reflect.DeepEqual(a.Resolution.ReasonCodes, []string{"legacy_bridge"}) {
		t.Fatal(a)
	}
}

// Opt-in, read-only compatibility probe for the installed driver. Never logs
// checkpoint data, paths, claim IDs, or instance identities.
func TestInstalledCheckpointCompatibility(t *testing.T) {
	path := os.Getenv("LEVIATHAN_TEST_CHECKPOINT_PATH")
	if path == "" {
		t.Skip("installed checkpoint probe is opt-in")
	}
	boot, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil {
		t.Fatal("current boot unavailable")
	}
	entries, _, err := readCheckpointFile(path, strings.TrimSpace(string(boot)), 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("validated current-boot checkpoint with %d completed MIG bindings", len(entries))
}

func TestClientRejectsReorderedV2Observations(t *testing.T) {
	now := time.Now().UTC()
	d, _, _ := dynamicFixture(t)
	d.Revision = 7
	d.GeneratedAt = now
	d.SourceObservedAt = now
	socket, closeServer := serveDocument(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(d)
	})
	defer closeServer()
	c, err := NewClient(testOptions(socket, &now))
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if err = c.Poll(context.Background()); err != nil {
		t.Fatal(err)
	}
	d.Revision = 6
	d.Bindings = nil
	if err = c.Poll(context.Background()); err == nil {
		t.Fatal("reordered response accepted")
	}
	if a := c.Current(now); a.Status != model.AttributionStale || a.Resolution.UnresolvedAssignments != 2 {
		t.Fatal(a)
	}
}

type topologyStub struct {
	stubProvider
	snapshot  model.Snapshot
	refreshes int
	during    func()
}

func (p *topologyStub) RefreshTopology() { p.refreshes++ }
func (p *topologyStub) Sample(_ context.Context, _ time.Time) (model.Snapshot, error) {
	if p.during != nil {
		p.during()
	}
	return p.snapshot, nil
}
func TestProviderCoalescesRefreshAndRejectsConcurrentBindingChange(t *testing.T) {
	d, s, cp := dynamicFixture(t)
	now := d.SourceObservedAt
	c, _ := NewClient(testOptions(filepath.Join(t.TempDir(), "absent.sock"), &now))
	defer c.Close()
	c.document = &d.Document
	c.modern = &d
	c.receivedAt = now
	base := &topologyStub{snapshot: s}
	p := NewProvider(base, c)
	p.checkpoint = NewCheckpointReader("unused")
	p.checkpoint.current = cp
	for i := 0; i < 3; i++ {
		a, err := p.Sample(context.Background(), now)
		if err != nil || len(a.Attribution.Assignments) != 3 {
			t.Fatal(a.Attribution, err)
		}
	}
	if base.refreshes != 1 {
		t.Fatal("polling reset topology", base.refreshes)
	}
	p.checkpoint.current.Revision++
	p.Sample(context.Background(), now)
	if base.refreshes != 2 {
		t.Fatal("checkpoint failed to refresh")
	}
	base.during = func() { p.checkpoint.current.Revision++ }
	a, _ := p.Sample(context.Background(), now)
	if a.Attribution.Resolution.Status != "incomplete" || len(a.Attribution.Assignments) != 1 {
		t.Fatal("mixed observations resolved", a.Attribution)
	}
}

func TestBridgeWatchGapCannotEraseUUIDPin(t *testing.T) {
	d, s, cp := dynamicFixture(t)
	r := bindingResolver{}
	resolveFixture(&r, d, s, cp)
	empty := d
	empty.Bindings = nil
	if a := resolveFixture(&r, empty, s, cp); a.Resolution.Status != "incomplete" {
		t.Fatal("checkpoint/watch gap reported complete")
	}
	s.GPUs[3].GPUInstances[0].ComputeInstances[0].UUID = "MIG-replacement"
	a := resolveFixture(&r, d, s, cp)
	if len(a.Assignments) != 2 || a.Resolution.UnresolvedAssignments != 1 {
		t.Fatal("watch gap erased lifetime evidence", a)
	}
}

func TestCheckpointRejectsContradictoryPreparedDevices(t *testing.T) {
	data := checkpointFixture(t, "PrepareCompleted", "GPU-parent", func(c map[string]any) {
		devices := c["preparedDevices"].([]any)[0].(map[string]any)["devices"].([]any)
		devices[1].(map[string]any)["mig"].(map[string]any)["concrete"].(map[string]any)["giId"] = 3
	})
	if _, err := parseCheckpoint(data, testBoot); err == nil {
		t.Fatal("two distinct prepared devices mapped to one CI")
	}
}
