//go:build linux || darwin

package updater

import (
	"context"
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

func TestPrivateServiceUmaskDoesNotHideManagedExecutables(t *testing.T) {
	old := syscall.Umask(0077)
	defer syscall.Umask(old)
	f := newFixture(t)
	if err := f.e.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{f.e.config.RootDirectory, filepath.Join(f.e.config.RootDirectory, "releases"), filepath.Join(f.e.config.RootDirectory, releaseTarget(sum(f.old))), filepath.Join(f.e.config.RootDirectory, releaseTarget(sum(f.next))), filepath.Join(f.e.config.RootDirectory, releaseTarget(sum(f.next)), "leviathan")} {
		info, err := os.Stat(path)
		if err != nil || info.Mode().Perm() != 0755 {
			t.Fatalf("non-root monitor cannot access %s: %v %v", path, info, err)
		}
	}
	info, _ := os.Stat(f.e.config.StateDirectory)
	if info.Mode().Perm() != 0700 {
		t.Fatal("credential directory became public")
	}
}
