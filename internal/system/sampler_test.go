package system

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"

	"github.com/intellisys-stevens/leviathan/internal/model"
)

func TestProcSamplerCollectsDeltasAndSanitizedFilesystems(t *testing.T) {
	root := t.TempDir()
	mustWrite(t, filepath.Join(root, "stat"), "cpu  100 0 50 850 0 0 0 0 0 0\ncpu0 1 0 1 8\ncpu1 1 0 1 8\n")
	mustWrite(t, filepath.Join(root, "cpuinfo"), "processor: 0\nmodel name: Fixture CPU\nprocessor: 1\nmodel name: Fixture CPU\n")
	mustWrite(t, filepath.Join(root, "loadavg"), "0.25 0.50 0.75 1/10 123\n")
	mustWrite(t, filepath.Join(root, "meminfo"), "MemTotal: 1024 kB\nMemAvailable: 256 kB\nMemFree: 128 kB\n")
	mustWrite(t, filepath.Join(root, "diskstats"), diskRow("8", "1", "sda1", 10, 20)+diskRow("8", "2", "sdb", 30, 40))
	mountInfo := filepath.Join(root, "mountinfo")
	mustWrite(t, mountInfo,
		"36 25 8:1 / / rw,relatime - ext4 /dev/sda1 rw\n"+
			"37 25 8:1 / /bind rw,relatime - ext4 /dev/sda1 rw\n"+
			"38 25 8:2 / /data\\040drive rw,relatime - xfs /dev/sdb rw\n"+
			"39 25 0:44 / /tmp rw - tmpfs tmpfs rw\n"+
			"40 25 0:45 / /remote rw - nfs server:/data rw\n")

	sam := New(Options{
		ProcRoot: root, MountInfoPath: mountInfo,
		Statfs: func(path string, stat *unix.Statfs_t) error {
			stat.Blocks, stat.Bfree, stat.Bavail, stat.Bsize = 1000, 400, 350, 4096
			return nil
		},
	})
	start := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	first, diagnostics, err := sam.Sample(context.Background(), start)
	if err != nil || len(diagnostics) != 0 {
		t.Fatalf("first sample: system=%+v diagnostics=%+v err=%v", first, diagnostics, err)
	}
	if first.CPU.Model != "Fixture CPU" || first.CPU.LogicalProcessors != 2 {
		t.Fatalf("CPU identity = %+v", first.CPU)
	}
	if first.CPU.Utilization.Value != nil || first.CPU.Utilization.Status != model.StatusStale {
		t.Fatalf("initial CPU utilization = %+v", first.CPU.Utilization)
	}
	if got := dereference(first.Memory.UsedBytes); got != 768*1024 {
		t.Fatalf("memory used = %d", got)
	}
	if len(first.Storage.Filesystems) != 2 {
		t.Fatalf("filesystems = %+v", first.Storage.Filesystems)
	}
	if first.Storage.Filesystems[0].MountPoint != "/" || first.Storage.Filesystems[1].MountPoint != "/data drive" {
		t.Fatalf("mount normalization/deduplication = %+v", first.Storage.Filesystems)
	}
	for _, filesystem := range first.Storage.Filesystems {
		if filesystem.ID == "" || filesystem.ID == "8:1" || filesystem.ID == "/dev/sda1" {
			t.Fatalf("filesystem ID is not opaque: %+v", filesystem)
		}
	}

	mustWrite(t, filepath.Join(root, "stat"), "cpu  150 0 70 880 0 0 0 0 0 0\ncpu0 1 0 1 8\ncpu1 1 0 1 8\n")
	mustWrite(t, filepath.Join(root, "diskstats"), diskRow("8", "1", "sda1", 20, 40)+diskRow("8", "2", "sdb", 50, 70))
	second, _, err := sam.Sample(context.Background(), start.Add(2*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	assertMetric(t, second.CPU.Utilization, 70)
	assertMetric(t, second.Storage.ReadBytesPerSecond, 7680)
	assertMetric(t, second.Storage.WriteBytesPerSecond, 12800)
	if got := dereference(second.Storage.TotalBytes); got != 2*1000*4096 {
		t.Fatalf("aggregate total = %d", got)
	}

	// One device reset must invalidate the aggregate even when another device
	// advances far enough that the summed counters still increase.
	mustWrite(t, filepath.Join(root, "diskstats"), diskRow("8", "1", "sda1", 1, 2)+diskRow("8", "2", "sdb", 100, 110))
	reset, err := sam.sampleStorage(start.Add(3 * time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if reset.ReadBytesPerSecond.Value != nil || reset.ReadBytesPerSecond.Message != "disk counters reset; waiting for a new baseline" {
		t.Fatalf("reset disk rate = %+v", reset.ReadBytesPerSecond)
	}
	mustWrite(t, filepath.Join(root, "diskstats"), diskRow("8", "1", "sda1", 4, 6)+diskRow("8", "2", "sdb", 108, 120))
	invalidTime, err := sam.sampleStorage(start.Add(3 * time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if invalidTime.ReadBytesPerSecond.Value != nil || invalidTime.ReadBytesPerSecond.Message != "disk sample time did not advance; waiting for a valid interval" {
		t.Fatalf("invalid-time disk rate = %+v", invalidTime.ReadBytesPerSecond)
	}
}

func TestMemoryFallbackIsExplicitlyEstimated(t *testing.T) {
	values, err := parseMemInfo("MemTotal: 1000 kB\nMemFree: 100 kB\nBuffers: 50 kB\nCached: 200 kB\nSReclaimable: 25 kB\nShmem: 10 kB\n")
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	mustWrite(t, filepath.Join(root, "meminfo"), "MemTotal: 1000 kB\nMemFree: 100 kB\nBuffers: 50 kB\nCached: 200 kB\nSReclaimable: 25 kB\nShmem: 10 kB\n")
	sam := New(Options{ProcRoot: root})
	memory, err := sam.sampleMemory(time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	if memory.Status != model.StatusEstimated || dereference(memory.AvailableBytes) != (100+50+200+25-10)*1024 {
		t.Fatalf("estimated memory = %+v; parsed=%+v", memory, values)
	}
	if memory.Utilization.Status != model.StatusEstimated || memory.Utilization.Value == nil || *memory.Utilization.Value != 63.5 {
		t.Fatalf("estimated memory utilization = %+v", memory.Utilization)
	}
}

func TestCounterResetAndCPUHotplugRequireNewBaseline(t *testing.T) {
	root := t.TempDir()
	mustWrite(t, filepath.Join(root, "stat"), "cpu 100 0 0 900\ncpu0 1 0 0 9\n")
	mustWrite(t, filepath.Join(root, "cpuinfo"), "processor: 0\n")
	mustWrite(t, filepath.Join(root, "loadavg"), "0 0 0 1/1 1\n")
	sam := New(Options{ProcRoot: root})
	at := time.Now().UTC()
	if _, err := sam.sampleCPU(at); err != nil {
		t.Fatal(err)
	}
	mustWrite(t, filepath.Join(root, "stat"), "cpu 10 0 0 90\ncpu0 1 0 0 9\ncpu1 1 0 0 9\n")
	mustWrite(t, filepath.Join(root, "cpuinfo"), "processor: 0\nprocessor: 1\n")
	cpu, err := sam.sampleCPU(at.Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if cpu.Utilization.Value != nil || cpu.Utilization.Message != "logical CPU topology changed; waiting for a new baseline" {
		t.Fatalf("hotplug utilization = %+v", cpu.Utilization)
	}
	mustWrite(t, filepath.Join(root, "stat"), "cpu 5 0 0 45\ncpu0 1 0 0 9\ncpu1 1 0 0 9\n")
	cpu, err = sam.sampleCPU(at.Add(2 * time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if cpu.Utilization.Value != nil || cpu.Utilization.Message != "CPU counters reset; waiting for a new baseline" {
		t.Fatalf("reset utilization = %+v", cpu.Utilization)
	}
	mustWrite(t, filepath.Join(root, "stat"), "cpu 10 0 0 90\ncpu0 1 0 0 9\ncpu1 1 0 0 9\n")
	cpu, err = sam.sampleCPU(at.Add(2 * time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if cpu.Utilization.Value != nil || cpu.Utilization.Message != "CPU sample time did not advance; waiting for a valid interval" {
		t.Fatalf("invalid-time utilization = %+v", cpu.Utilization)
	}
}

func TestStorageKeepsUnreadableFilesystemAndCapsDeterministically(t *testing.T) {
	mounts, err := parseMountInfo(
		"1 0 8:3 / /z rw - ext4 /dev/z rw\n"+
			"2 0 8:1 / /a rw - ext4 /dev/a rw\n"+
			"3 0 8:2 / /b rw - ext4 /dev/b rw\n", 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(mounts) != 2 || mounts[0].mountPoint != "/a" || mounts[1].mountPoint != "/b" {
		t.Fatalf("bounded mounts = %+v", mounts)
	}

	root := t.TempDir()
	mustWrite(t, filepath.Join(root, "mountinfo"), "1 0 8:1 / /a rw - ext4 /dev/a rw\n2 0 8:2 / /b rw - xfs /dev/b rw\n")
	mustWrite(t, filepath.Join(root, "diskstats"), diskRow("8", "1", "a", 1, 1))
	sam := New(Options{ProcRoot: root, MountInfoPath: filepath.Join(root, "mountinfo"), Statfs: func(path string, stat *unix.Statfs_t) error {
		if path == "/b" {
			return os.ErrPermission
		}
		stat.Blocks, stat.Bfree, stat.Bavail, stat.Bsize = 10, 5, 4, 1024
		return nil
	}})
	storage, err := sam.sampleStorage(time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	if storage.Status != model.StatusStale || len(storage.Filesystems) != 2 || storage.Filesystems[1].Status != model.StatusPermissionDenied {
		t.Fatalf("partial filesystem results = %+v", storage.Filesystems)
	}
}

func TestDiskThroughputRequiresEveryMountedDeviceCounter(t *testing.T) {
	root := t.TempDir()
	mountInfo := filepath.Join(root, "mountinfo")
	mustWrite(t, mountInfo, "1 0 8:1 / / rw - ext4 /dev/a rw\n2 0 8:2 / /data rw - xfs /dev/b rw\n")
	mustWrite(t, filepath.Join(root, "diskstats"), diskRow("8", "1", "a", 10, 20))
	sam := New(Options{
		ProcRoot: root, MountInfoPath: mountInfo,
		Statfs: func(string, *unix.Statfs_t) error { return nil },
	})
	at := time.Now().UTC()
	partial, err := sam.sampleStorage(at)
	if err != nil {
		t.Fatal(err)
	}
	if partial.Status != model.StatusStale || partial.ReadBytesPerSecond.Value != nil || partial.WriteBytesPerSecond.Value != nil {
		t.Fatalf("partial disk counters produced aggregate throughput: %+v", partial)
	}
	if !strings.Contains(partial.Message, "1 of 2 persistent local filesystems") || strings.Contains(partial.Message, "8:2") {
		t.Fatalf("partial disk diagnostic is not bounded and sanitized: %q", partial.Message)
	}

	mustWrite(t, filepath.Join(root, "diskstats"), diskRow("8", "1", "a", 12, 24)+diskRow("8", "2", "b", 30, 40))
	baseline, err := sam.sampleStorage(at.Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if baseline.ReadBytesPerSecond.Value != nil {
		t.Fatalf("first complete counter set did not establish a fresh baseline: %+v", baseline.ReadBytesPerSecond)
	}
	mustWrite(t, filepath.Join(root, "diskstats"), diskRow("8", "1", "a", 14, 28)+diskRow("8", "2", "b", 34, 46))
	complete, err := sam.sampleStorage(at.Add(2 * time.Second))
	if err != nil {
		t.Fatal(err)
	}
	assertMetric(t, complete.ReadBytesPerSecond, float64(6*diskSectorBytes))
	assertMetric(t, complete.WriteBytesPerSecond, float64(10*diskSectorBytes))
}

func TestNonBlockPersistentFilesystemKeepsCapacityWithoutInventingThroughput(t *testing.T) {
	root := t.TempDir()
	mountInfo := filepath.Join(root, "mountinfo")
	mustWrite(t, mountInfo, "1 0 0:42 / /pool rw - zfs tank rw\n")
	mustWrite(t, filepath.Join(root, "diskstats"), diskRow("8", "1", "unrelated", 10, 20))
	sam := New(Options{
		ProcRoot: root, MountInfoPath: mountInfo,
		Statfs: func(_ string, stat *unix.Statfs_t) error {
			stat.Blocks, stat.Bfree, stat.Bavail, stat.Bsize = 100, 40, 35, 4096
			return nil
		},
	})
	storage, err := sam.sampleStorage(time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	if storage.Status != model.StatusStale || len(storage.Filesystems) != 1 || storage.Filesystems[0].Status != model.StatusAvailable {
		t.Fatalf("non-block persistent filesystem capacity was lost: %+v", storage)
	}
	if storage.TotalBytes == nil || storage.ReadBytesPerSecond.Value != nil || storage.WriteBytesPerSecond.Value != nil {
		t.Fatalf("non-block filesystem produced incomplete capacity or invented throughput: %+v", storage)
	}
}

func TestPartialCPUAndDiskFieldsDegradeButKeepSystemUsable(t *testing.T) {
	root := t.TempDir()
	mustWrite(t, filepath.Join(root, "stat"), "cpu 100 0 0 900\ncpu0 1 0 0 9\n")
	mustWrite(t, filepath.Join(root, "cpuinfo"), "processor: 0\nmodel name: Fixture CPU\n")
	mustWrite(t, filepath.Join(root, "meminfo"), "MemTotal: 1024 kB\nMemAvailable: 512 kB\n")
	mustWrite(t, filepath.Join(root, "mountinfo"), "1 0 8:1 / / rw - ext4 /dev/a rw\n")
	sam := New(Options{
		ProcRoot: root, MountInfoPath: filepath.Join(root, "mountinfo"),
		Statfs: func(string, *unix.Statfs_t) error { return nil },
	})
	system, diagnostics, err := sam.Sample(context.Background(), time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	if system.Status != model.StatusStale || system.CPU.Status != model.StatusStale || system.Storage.Status != model.StatusStale {
		t.Fatalf("partial system status = %+v", system)
	}
	if system.Memory.Status != model.StatusAvailable || len(diagnostics) != 2 {
		t.Fatalf("usable domains/diagnostics = memory=%+v diagnostics=%+v", system.Memory, diagnostics)
	}
}

func TestFilesystemFilterRejectsNetworkPseudoAndEphemeralTypes(t *testing.T) {
	for _, fsType := range []string{"nfs4", "cifs", "ceph", "proc", "cgroup2", "tmpfs", "overlay", "fuse.sshfs", "nsfs"} {
		if !excludedFilesystem(fsType) {
			t.Errorf("filesystem type %q was not excluded", fsType)
		}
	}
	for _, fsType := range []string{"ext4", "xfs", "btrfs", "zfs", "fuseblk"} {
		if excludedFilesystem(fsType) {
			t.Errorf("persistent local filesystem type %q was excluded", fsType)
		}
	}
}

func TestSampleFailsOnlyWhenEverySystemDomainFails(t *testing.T) {
	sam := New(Options{ProcRoot: t.TempDir(), Statfs: func(string, *unix.Statfs_t) error { return errors.New("unreachable") }})
	system, diagnostics, err := sam.Sample(context.Background(), time.Now().UTC())
	if err == nil || system.Status != model.StatusError || len(diagnostics) != 3 {
		t.Fatalf("system=%+v diagnostics=%+v err=%v", system, diagnostics, err)
	}
}

func mustWrite(t *testing.T, path, value string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(value), 0o600); err != nil {
		t.Fatal(err)
	}
}

func diskRow(major, minor, name string, readSectors, writeSectors uint64) string {
	return major + " " + minor + " " + name + " 1 0 " +
		strconvUint(readSectors) + " 0 1 0 " + strconvUint(writeSectors) + " 0 0 0 0 0\n"
}

func strconvUint(value uint64) string { return strconv.FormatUint(value, 10) }

func dereference(value *uint64) uint64 {
	if value == nil {
		return 0
	}
	return *value
}

func assertMetric(t *testing.T, metric model.Metric, want float64) {
	t.Helper()
	if metric.Status != model.StatusAvailable || metric.Value == nil || *metric.Value != want {
		t.Fatalf("metric = %+v, want %v", metric, want)
	}
}
