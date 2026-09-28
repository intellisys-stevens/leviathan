package uplink

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

func TestAtomicWritePreservesExistingOwnerAndPrivateMode(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("ownership change requires root; exercised by Linux container tests")
	}
	path := filepath.Join(t.TempDir(), "config.toml")
	if err := os.WriteFile(path, []byte("provider = 'fake'\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chown(path, 65534, 65534); err != nil {
		t.Fatal(err)
	}
	if err := AtomicWriteFile(path, []byte("provider = 'auto'\n"), 0600); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	owner := info.Sys().(*syscall.Stat_t)
	if owner.Uid != 65534 || owner.Gid != 65534 || info.Mode().Perm() != 0600 {
		t.Fatalf("atomic replacement changed owner or permissions: uid=%d gid=%d mode=%o", owner.Uid, owner.Gid, info.Mode().Perm())
	}
}
