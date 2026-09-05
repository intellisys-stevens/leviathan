//go:build linux || darwin

package updater

import (
	"os"
	"syscall"

	"golang.org/x/sys/unix"
)

func openNoFollow(path string, flags int, mode os.FileMode) (*os.File, error) {
	fd, e := unix.Open(path, flags|unix.O_NOFOLLOW|unix.O_CLOEXEC, uint32(mode.Perm()))
	if e != nil {
		return nil, e
	}
	return os.NewFile(uintptr(fd), path), nil
}
func ownedByCurrentUserOrRoot(info os.FileInfo) bool {
	s, ok := info.Sys().(*syscall.Stat_t)
	return ok && (s.Uid == 0 || s.Uid == uint32(os.Geteuid()))
}
func lockState(path string) (func(), error) {
	f, e := openNoFollow(path, os.O_CREATE|os.O_RDWR, 0600)
	if e != nil {
		return nil, e
	}
	info, e := f.Stat()
	if e != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || !ownedByCurrentUserOrRoot(info) {
		f.Close()
		return nil, ErrConfiguration
	}
	if e = unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB); e != nil {
		f.Close()
		return nil, e
	}
	return func() { _ = unix.Flock(int(f.Fd()), unix.LOCK_UN); _ = f.Close() }, nil
}
func availableBytes(path string) (uint64, error) {
	var s unix.Statfs_t
	if e := unix.Statfs(path, &s); e != nil {
		return 0, e
	}
	return uint64(s.Bavail) * uint64(s.Bsize), nil
}
