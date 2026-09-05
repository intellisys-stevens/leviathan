package updater

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"

	p "github.com/intellisys-stevens/leviathan/internal/updateprotocol"
)

func safeDirectory(path string) error {
	if !safeAbsolute(path) {
		return ErrConfiguration
	}
	for at := path; ; at = filepath.Dir(at) {
		info, e := os.Lstat(at)
		if e != nil {
			return e
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || !ownedByCurrentUserOrRoot(info) {
			return ErrConfiguration
		}
		if info.Mode().Perm()&0022 != 0 { // sticky ancestors support isolated test sandboxes, never the managed directory itself.
			if at == path || info.Mode()&os.ModeSticky == 0 {
				return ErrConfiguration
			}
		}
		if at == "/" {
			break
		}
	}
	return nil
}
func safeRead(path string, limit int64, private bool) ([]byte, error) {
	if !safeAbsolute(path) || safeDirectory(filepath.Dir(path)) != nil {
		return nil, ErrConfiguration
	}
	f, e := openNoFollow(path, os.O_RDONLY, 0)
	if e != nil {
		return nil, e
	}
	defer f.Close()
	info, e := f.Stat()
	if e != nil || !info.Mode().IsRegular() || info.Size() > limit || !ownedByCurrentUserOrRoot(info) || info.Mode().Perm()&0022 != 0 || (private && info.Mode().Perm()&0077 != 0) {
		return nil, ErrConfiguration
	}
	b, e := io.ReadAll(io.LimitReader(f, limit+1))
	if e != nil || int64(len(b)) > limit {
		return nil, ErrConfiguration
	}
	return b, nil
}
func atomicJSON(path string, value any) error {
	b, e := json.Marshal(value)
	if e != nil {
		return e
	}
	return atomicBytes(path, append(b, '\n'), 0600)
}
func atomicBytes(path string, b []byte, mode os.FileMode) error {
	parent := filepath.Dir(path)
	if safeDirectory(parent) != nil {
		return ErrConfiguration
	}
	f, e := os.CreateTemp(parent, ".pending-")
	if e != nil {
		return e
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	defer f.Close()
	if e = f.Chmod(mode); e != nil {
		return e
	}
	if _, e = f.Write(b); e != nil {
		return e
	}
	if e = f.Sync(); e != nil {
		return e
	}
	if e = f.Close(); e != nil {
		return e
	}
	if e = os.Rename(tmp, path); e != nil {
		return e
	}
	return syncDirectory(parent)
}
func syncDirectory(path string) error {
	f, e := os.Open(path)
	if e != nil {
		return e
	}
	defer f.Close()
	return f.Sync()
}
func binaryDigest(path string) (string, error) {
	if safeDirectory(filepath.Dir(path)) != nil {
		return "", ErrConfiguration
	}
	f, e := openNoFollow(path, os.O_RDONLY, 0)
	if e != nil {
		return "", e
	}
	defer f.Close()
	info, e := f.Stat()
	if e != nil || !info.Mode().IsRegular() || info.Size() < 1 || info.Size() > p.MaxBinaryBytes || info.Mode().Perm()&0022 != 0 || !ownedByCurrentUserOrRoot(info) {
		return "", ErrConfiguration
	}
	h := sha256.New()
	n, e := io.Copy(h, io.LimitReader(f, p.MaxBinaryBytes+1))
	if e != nil || n != info.Size() {
		return "", ErrConfiguration
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
func releaseTarget(hash string) string { return "releases/" + hash }
func targetDigest(target string) (string, error) {
	s := strings.TrimPrefix(target, "releases/")
	if target != releaseTarget(s) || !p.IsDigest(s) {
		return "", ErrConfiguration
	}
	return s, nil
}
func currentTarget(c Config) (string, error) {
	t, e := os.Readlink(filepath.Join(c.RootDirectory, "current"))
	if e != nil {
		return "", e
	}
	if _, e = targetDigest(t); e != nil {
		return "", e
	}
	return t, nil
}
func switchTarget(c Config, target string) error {
	digest, e := targetDigest(target)
	if e != nil {
		return e
	}
	actual, e := binaryDigest(filepath.Join(c.RootDirectory, target, "leviathan"))
	if e != nil || actual != digest {
		return ErrConfiguration
	}
	// A rename in the containing directory is the commit point; fsync makes it
	// durable. No bind-mounted individual executable needs to be overwritten.
	f, e := os.CreateTemp(c.RootDirectory, ".current-")
	if e != nil {
		return e
	}
	tmp := f.Name()
	_ = f.Close()
	if e = os.Remove(tmp); e != nil {
		return e
	}
	defer os.Remove(tmp)
	if e = os.Symlink(target, tmp); e != nil {
		return e
	}
	if e = os.Rename(tmp, filepath.Join(c.RootDirectory, "current")); e != nil {
		return e
	}
	return syncDirectory(c.RootDirectory)
}
func readJSON(path string, target any) error {
	b, e := safeRead(path, p.MaxBodyBytes, true)
	if e != nil {
		return e
	}
	return p.DecodeStrict(strings.NewReader(string(b)), p.MaxBodyBytes, target)
}
func removeDurable(path string) error {
	e := os.Remove(path)
	if errors.Is(e, os.ErrNotExist) {
		return nil
	}
	if e != nil {
		return e
	}
	return syncDirectory(filepath.Dir(path))
}
