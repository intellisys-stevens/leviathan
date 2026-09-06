package workload

import (
	"os"
	"path/filepath"
	"testing"
)

func block(t *testing.T, root, id, name string, virtual bool, slaves ...string) string {
	t.Helper()
	parent := "devices/pci0000:00/block"
	if virtual {
		parent = "devices/virtual/block"
	}
	path := filepath.Join(root, parent, name)
	writeFile(t, filepath.Join(path, "dev"), id+"\n")
	if err := os.MkdirAll(filepath.Join(path, "slaves"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "dev/block"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(path, filepath.Join(root, "dev/block", id)); err != nil {
		t.Fatal(err)
	}
	for _, slave := range slaves {
		target, err := filepath.EvalSymlinks(filepath.Join(root, "dev/block", slave))
		if err != nil {
			t.Fatal(err)
		}
		relative, relErr := filepath.Rel(filepath.Join(path, "slaves"), target)
		if relErr != nil {
			t.Fatal(relErr)
		}
		if err = os.Symlink(relative, filepath.Join(path, "slaves", filepath.Base(target))); err != nil {
			t.Fatal(err)
		}
	}
	return path
}
func TestIODeduplicatesMapperBackingAndPartitionCounters(t *testing.T) {
	root := t.TempDir()
	disk := block(t, root, "8:0", "sda", false)
	block(t, root, "253:0", "dm-0", true, "8:0")
	partition := filepath.Join(disk, "sda1")
	writeFile(t, filepath.Join(partition, "dev"), "8:1\n")
	writeFile(t, filepath.Join(partition, "partition"), "1\n")
	if err := os.Symlink(partition, filepath.Join(root, "dev/block/8:1")); err != nil {
		t.Fatal(err)
	}
	for name, contents := range map[string]string{"leaf": "8:0 rbytes=100 wbytes=200\n", "mapper_and_leaf": "253:0 rbytes=100 wbytes=200\n8:0 rbytes=100 wbytes=200\n", "partition_and_disk": "8:1 rbytes=80 wbytes=90\n8:0 rbytes=100 wbytes=200\n", "mapper_only": "253:0 rbytes=100 wbytes=200\n"} {
		t.Run(name, func(t *testing.T) {
			read, write, _, err := readIO([]byte(contents), root)
			if err != nil || read != 100 || write != 200 {
				t.Fatalf("read=%d write=%d err=%v", read, write, err)
			}
		})
	}
	read, write, _, err := readIO([]byte("8:1 rbytes=80 wbytes=90\n"), root)
	if err != nil || read != 80 || write != 90 {
		t.Fatalf("partition=%d %d %v", read, write, err)
	}
}
func TestIOIncompleteOverlappingOrUnknownBackingIsUnavailable(t *testing.T) {
	root := t.TempDir()
	block(t, root, "8:0", "sda", false)
	block(t, root, "8:16", "sdb", false)
	block(t, root, "253:0", "dm-0", true, "8:0", "8:16")
	block(t, root, "253:1", "dm-1", true, "8:0")
	block(t, root, "7:0", "loop0", true)
	for _, contents := range []string{"253:0 rbytes=100 wbytes=200\n8:0 rbytes=50 wbytes=100\n", "253:0 rbytes=100 wbytes=200\n253:1 rbytes=100 wbytes=200\n", "7:0 rbytes=100 wbytes=200\n", "9:9 rbytes=100 wbytes=200\n", "8:0 rbytes=1\n", "../../escape rbytes=1 wbytes=2\n"} {
		if _, _, _, err := readIO([]byte(contents), root); err == nil {
			t.Fatalf("ambiguous counters accepted: %s", contents)
		}
	}
	read, write, _, err := readIO(nil, root)
	if err != nil || read != 0 || write != 0 {
		t.Fatalf("empty counters=%d %d %v", read, write, err)
	}
}
