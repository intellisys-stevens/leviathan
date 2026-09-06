package workload

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/intellisys-stevens/leviathan/internal/attribution"
	"github.com/intellisys-stevens/leviathan/internal/model"
)

type fakeInventory struct {
	document Document
	err      error
}

func (f *fakeInventory) Read(context.Context, time.Time) (Document, error) { return f.document, f.err }
func (f *fakeInventory) Close()                                            {}

const testOwner = "owner_11111111111111111111111111111111"
const testWorkspace = "workspace_22222222222222222222222222222222"
const podOne = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
const podTwo = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff"

func inventory(at time.Time, uids ...string) Document {
	w := model.WorkloadAttribution{Ref: testWorkspace, Platform: model.WorkloadPlatformCoder, Kind: model.WorkloadKindWorkspace, Name: "CPU workspace", OwnerName: "owner"}
	document := Document{SchemaVersion: SchemaVersion, GeneratedAt: at, ObservedAt: at, Status: model.WorkloadTelemetryAvailable, Owners: []Owner{{Ref: testOwner, Name: "owner", Platform: model.WorkloadPlatformCoder, Workspaces: []model.WorkloadAttribution{w}}}, Pods: []Pod{}}
	for _, uid := range uids {
		scope, _ := attribution.ScopeRefForPodUID(uid)
		document.Pods = append(document.Pods, Pod{ScopeRef: scope, OwnerRef: testOwner, WorkloadRef: testWorkspace})
	}
	return document
}
func writeFile(t *testing.T, path, data string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(data), 0600); err != nil {
		t.Fatal(err)
	}
}
func makePod(t *testing.T, root, uid string, cpu, mem uint64) string {
	t.Helper()
	path := filepath.Join(root, "kubepods.slice", "kubepods-burstable.slice", "kubepods-burstable-pod"+strings.ReplaceAll(uid, "-", "_")+".slice")
	writeFile(t, filepath.Join(path, "cpu.stat"), fmt.Sprintf("usage_usec %d\n", cpu))
	writeFile(t, filepath.Join(path, "memory.current"), fmt.Sprint(mem))
	writeFile(t, filepath.Join(path, "io.stat"), "")
	return path
}
func newFixture(t *testing.T, uids ...string) (*Collector, *fakeInventory, time.Time) {
	t.Helper()
	if runtime.GOOS != "linux" {
		t.Skip("Linux cgroup collector")
	}
	at := time.Now().UTC()
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "cgroup.controllers"), "cpu memory io\n")
	client := &fakeInventory{document: inventory(at, uids...)}
	return &Collector{options: Options{CgroupRoot: root, SysfsRoot: t.TempDir()}, client: client, previous: map[string]podSample{}}, client, at
}
func metric(t *testing.T, telemetry model.WorkloadTelemetry, name string) model.Metric {
	t.Helper()
	if len(telemetry.Owners) != 1 {
		t.Fatalf("owners=%d", len(telemetry.Owners))
	}
	return telemetry.Owners[0].Metrics[name]
}
func assertValue(t *testing.T, value model.Metric, want float64) {
	t.Helper()
	if value.Status != model.StatusAvailable || value.Value == nil || *value.Value != want {
		t.Fatalf("metric=%+v want=%v", value, want)
	}
}

func TestCPUOnlyOwnerAggregatesPodsOnceAndPreservesZero(t *testing.T) {
	c, _, at := newFixture(t, podOne, podTwo)
	one := makePod(t, c.options.CgroupRoot, podOne, 1_000_000, 100)
	two := makePod(t, c.options.CgroupRoot, podTwo, 2_000_000, 200)
	// Nested container data must not be added to the inclusive Pod counters.
	writeFile(t, filepath.Join(one, "container.scope", "memory.current"), "999999")
	first, err := c.Sample(context.Background(), at)
	if err != nil {
		t.Fatal(err)
	}
	assertValue(t, metric(t, first, "memory_used_bytes"), 300)
	if metric(t, first, "cpu_cores").Value != nil {
		t.Fatal("first CPU sample fabricated")
	}
	writeFile(t, filepath.Join(one, "cpu.stat"), "usage_usec 2000000\n")
	writeFile(t, filepath.Join(two, "cpu.stat"), "usage_usec 5000000\n")
	second, err := c.Sample(context.Background(), at.Add(2*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	assertValue(t, metric(t, second, "cpu_cores"), 2)
	assertValue(t, metric(t, second, "storage_read_bps"), 0)
	third, _ := c.Sample(context.Background(), at.Add(4*time.Second))
	assertValue(t, metric(t, third, "cpu_cores"), 0)
	if third.Status != model.WorkloadTelemetryAvailable {
		t.Fatalf("status=%s", third.Status)
	}
}

func TestPartialMemoryAndStaleInventoryNeverReportSubsetAsTotal(t *testing.T) {
	c, client, at := newFixture(t, podOne, podTwo)
	makePod(t, c.options.CgroupRoot, podOne, 0, 100)
	two := makePod(t, c.options.CgroupRoot, podTwo, 0, 200)
	c.Sample(context.Background(), at)
	if err := os.Remove(filepath.Join(two, "memory.current")); err != nil {
		t.Fatal(err)
	}
	partial, _ := c.Sample(context.Background(), at.Add(2*time.Second))
	value := metric(t, partial, "memory_used_bytes")
	if value.Value != nil || !strings.HasPrefix(value.Message, "Partial") {
		t.Fatalf("partial memory=%+v", value)
	}
	assertValue(t, metric(t, partial, "cpu_cores"), 0)
	client.err = errors.New("Workspace inventory is stale")
	c.lastRead = time.Time{}
	stale, _ := c.Sample(context.Background(), at.Add(4*time.Second))
	if stale.Status != model.WorkloadTelemetryStale || len(stale.Owners) != 1 {
		t.Fatalf("stale=%+v", stale)
	}
	for _, value := range stale.Owners[0].Metrics {
		if value.Value != nil || value.Status != model.StatusStale {
			t.Fatalf("stale metric=%+v", value)
		}
	}
}

func TestCounterResetAndMissingPodResetBaselines(t *testing.T) {
	c, _, at := newFixture(t, podOne)
	path := makePod(t, c.options.CgroupRoot, podOne, 1000, 100)
	c.Sample(context.Background(), at)
	writeFile(t, filepath.Join(path, "cpu.stat"), "usage_usec 10\n")
	reset, _ := c.Sample(context.Background(), at.Add(2*time.Second))
	if metric(t, reset, "cpu_cores").Value != nil {
		t.Fatal("counter reset became a rate")
	}
	if err := os.Rename(path, path+"-gone"); err != nil {
		t.Fatal(err)
	}
	missing, _ := c.Sample(context.Background(), at.Add(4*time.Second))
	if metric(t, missing, "memory_used_bytes").Value != nil {
		t.Fatal("missing Pod became zero")
	}
	if err := os.Rename(path+"-gone", path); err != nil {
		t.Fatal(err)
	}
	back, _ := c.Sample(context.Background(), at.Add(6*time.Second))
	if metric(t, back, "cpu_cores").Value != nil {
		t.Fatal("gap reused old CPU baseline")
	}
}

func TestDiscoveryRejectsDuplicatePodScopesAndEscapingSymlinks(t *testing.T) {
	c, _, at := newFixture(t, podOne)
	path := makePod(t, c.options.CgroupRoot, podOne, 0, 100)
	outside := t.TempDir()
	writeFile(t, filepath.Join(outside, "memory"), "333")
	if err := os.Remove(filepath.Join(path, "memory.current")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(outside, "memory"), filepath.Join(path, "memory.current")); err != nil {
		t.Fatal(err)
	}
	result, _ := c.Sample(context.Background(), at)
	if metric(t, result, "memory_used_bytes").Value != nil {
		t.Fatal("read outside cgroup root")
	}
	duplicate := filepath.Join(c.options.CgroupRoot, "pod"+podOne)
	writeFile(t, filepath.Join(duplicate, "cpu.stat"), "usage_usec 0\n")
	paths, err := discoverPods(context.Background(), c.options.CgroupRoot)
	if err != nil {
		t.Fatal(err)
	}
	scope, _ := attribution.ScopeRefForPodUID(podOne)
	if paths[scope] != "" {
		t.Fatal("duplicate Pod scope resolved arbitrarily")
	}
}

func TestUnsupportedControllersPreserveMonitoring(t *testing.T) {
	c, _, at := newFixture(t, podOne)
	if err := os.Remove(filepath.Join(c.options.CgroupRoot, "cgroup.controllers")); err != nil {
		t.Fatal(err)
	}
	value, err := c.Sample(context.Background(), at)
	if err != nil {
		t.Fatal(err)
	}
	if value.Status != model.WorkloadTelemetryUnavailable || metric(t, value, "cpu_cores").Status != model.StatusUnsupported {
		t.Fatalf("telemetry=%+v", value)
	}
}

func TestProtocolRejectsConflictsAndOutOfBounds(t *testing.T) {
	at := time.Now().UTC()
	doc := inventory(at, podOne)
	if err := doc.Validate(); err != nil {
		t.Fatal(err)
	}
	for name, change := range map[string]func(*Document){"duplicate": func(d *Document) { d.Pods = append(d.Pods, d.Pods[0]) }, "path": func(d *Document) { d.Pods[0].ScopeRef = "../../etc" }, "owner": func(d *Document) { d.Pods[0].OwnerRef = "owner_33333333333333333333333333333333" }, "control": func(d *Document) { d.Owners[0].Name = "bad\nname" }, "future": func(d *Document) { d.ObservedAt = at.Add(time.Minute) }} {
		t.Run(name, func(t *testing.T) {
			doc := inventory(at, podOne)
			change(&doc)
			if doc.Validate() == nil {
				t.Fatal("invalid document accepted")
			}
		})
	}
}

func TestIOPerDeviceResetAndDiskReplacementResetRates(t *testing.T) {
	c, _, at := newFixture(t, podOne)
	pod := makePod(t, c.options.CgroupRoot, podOne, 0, 100)
	disk := block(t, c.options.SysfsRoot, "8:0", "sda", false)
	block(t, c.options.SysfsRoot, "8:16", "sdb", false)
	writeFile(t, filepath.Join(disk, "diskseq"), "1\n")
	writeFile(t, filepath.Join(pod, "io.stat"), "8:0 rbytes=1000 wbytes=1000\n8:16 rbytes=1000 wbytes=1000\n")
	c.Sample(context.Background(), at)
	// The total rises while one underlying counter resets. Neither direction
	// may report a plausible aggregate rate across this reset.
	writeFile(t, filepath.Join(pod, "io.stat"), "8:0 rbytes=0 wbytes=0\n8:16 rbytes=3000 wbytes=3000\n")
	reset, _ := c.Sample(context.Background(), at.Add(2*time.Second))
	if metric(t, reset, "storage_read_bps").Value != nil {
		t.Fatal("per-device reset hidden by aggregate growth")
	}
	writeFile(t, filepath.Join(pod, "io.stat"), "8:0 rbytes=1000 wbytes=1000\n8:16 rbytes=4000 wbytes=4000\n")
	good, _ := c.Sample(context.Background(), at.Add(4*time.Second))
	assertValue(t, metric(t, good, "storage_read_bps"), 1000)
	writeFile(t, filepath.Join(disk, "diskseq"), "2\n")
	replaced, _ := c.Sample(context.Background(), at.Add(6*time.Second))
	if metric(t, replaced, "storage_read_bps").Value != nil {
		t.Fatal("replaced disk retained rate baseline")
	}
}

func TestAccountingClockStartsAfterInventoryDelay(t *testing.T) {
	c, _, at := newFixture(t, podOne)
	pod := makePod(t, c.options.CgroupRoot, podOne, 0, 100)
	clock := at
	c.options.Now = func() time.Time { return clock }
	c.Sample(context.Background(), at)
	// Simulate a one-second inventory/discovery delay before a nominal second
	// tick: the three seconds of CPU time must produce one core, not 1.5.
	clock = at.Add(3 * time.Second)
	writeFile(t, filepath.Join(pod, "cpu.stat"), "usage_usec 3000000\n")
	next, _ := c.Sample(context.Background(), at.Add(2*time.Second))
	assertValue(t, metric(t, next, "cpu_cores"), 1)
	if !next.SampledAt.Equal(clock) {
		t.Fatal("published owner timestamp precedes actual collection")
	}
}
