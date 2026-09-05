package updater

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"

	p "github.com/intellisys-stevens/leviathan/internal/updateprotocol"
)

func (e *Engine) stage(ctx context.Context, job p.Job, m p.Manifest) (string, error) {
	free, err := availableBytes(e.config.RootDirectory)
	if err != nil || free < uint64(m.ArchiveBytes+m.BinaryBytes)+(64<<20) {
		return "", errors.New("insufficient staging space")
	}
	dir, err := os.MkdirTemp(filepath.Join(e.config.RootDirectory, "releases"), ".stage-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(dir)
	reader, err := e.control.Artifact(ctx, p.ArtifactRequest{JobID: job.ID, ArchiveSHA256: m.ArchiveSHA256})
	if err != nil {
		return "", err
	}
	defer reader.Close()
	archive, err := os.OpenFile(filepath.Join(dir, "archive.tar.gz"), os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if err != nil {
		return "", err
	}
	defer archive.Close()
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(archive, h), io.LimitReader(reader, m.ArchiveBytes+1))
	if err != nil || n != m.ArchiveBytes || hex.EncodeToString(h.Sum(nil)) != m.ArchiveSHA256 {
		return "", errors.New("archive verification failed")
	}
	if _, err = archive.Seek(0, io.SeekStart); err != nil {
		return "", err
	}
	target := filepath.Join(dir, "leviathan")
	if err = extractBinary(archive, target, m); err != nil {
		return "", err
	}
	if err = e.service.Preflight(ctx, target); err != nil {
		return "", errors.New("candidate configuration rejected")
	}
	build, err := e.service.Build(ctx, target)
	if err != nil || build.Version != m.Version || !commitMatches(build.Commit, m.Commit) {
		return "", errors.New("candidate build metadata mismatch")
	}
	destination := filepath.Join(e.config.RootDirectory, releaseTarget(m.BinarySHA256))
	if _, err = os.Lstat(destination); err == nil {
		digest, readErr := binaryDigest(filepath.Join(destination, "leviathan"))
		if readErr != nil || digest != m.BinarySHA256 {
			return "", ErrConfiguration
		}
		return releaseTarget(m.BinarySHA256), nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	// The archive itself is not retained in the executable release directory.
	if err = archive.Close(); err != nil {
		return "", err
	}
	if err = os.Remove(filepath.Join(dir, "archive.tar.gz")); err != nil {
		return "", err
	}
	if err = os.Chmod(dir, 0755); err != nil {
		return "", err
	}
	if err = syncDirectory(dir); err != nil {
		return "", err
	}
	if err = os.Rename(dir, destination); err != nil {
		return "", err
	}
	if err = syncDirectory(filepath.Dir(destination)); err != nil {
		return "", err
	}
	return releaseTarget(m.BinarySHA256), nil
}
func extractBinary(source io.Reader, destination string, m p.Manifest) error {
	gz, err := gzip.NewReader(source)
	if err != nil {
		return err
	}
	defer gz.Close()
	expanded := &io.LimitedReader{R: gz, N: 1 << 30}
	tr := tar.NewReader(expanded)
	found := false
	entries := 0
	expected := "leviathan_" + m.Version + "_linux_" + m.Arch + "/leviathan"
	for {
		header, e := tr.Next()
		if e == io.EOF {
			break
		}
		if e != nil {
			return e
		}
		entries++
		name := strings.TrimSuffix(header.Name, "/")
		if entries > 100000 || name == "" || path.IsAbs(name) || path.Clean(name) != name || strings.Contains(name, "\\") || strings.ContainsAny(name, "\x00\r\n") || name == ".." || strings.HasPrefix(name, "../") || header.Size < 0 || header.Size > 1<<30 {
			return errors.New("unsafe release archive")
		}
		if header.Typeflag != tar.TypeReg && header.Typeflag != tar.TypeRegA && header.Typeflag != tar.TypeDir {
			return errors.New("release archive links and special files are forbidden")
		}
		if name != expected {
			continue
		}
		if found || header.Typeflag == tar.TypeDir || header.Size != m.BinaryBytes {
			return errors.New("invalid release binary entry")
		}
		found = true
		f, e := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0755)
		if e != nil {
			return e
		}
		if e = f.Chmod(0755); e != nil {
			f.Close()
			return e
		}
		h := sha256.New()
		n, e := io.Copy(io.MultiWriter(f, h), tr)
		if e != nil || n != m.BinaryBytes || hex.EncodeToString(h.Sum(nil)) != m.BinarySHA256 {
			f.Close()
			return errors.New("release binary digest mismatch")
		}
		if e = f.Sync(); e != nil {
			f.Close()
			return e
		}
		if e = f.Close(); e != nil {
			return e
		}
	}
	if !found || expanded.N <= 0 {
		return errors.New("release binary missing or archive too large")
	}
	// Consume the gzip footer so truncated/corrupt compressed streams cannot be
	// accepted merely because tar reached its end marker.
	if _, err = io.Copy(io.Discard, expanded); err != nil || expanded.N <= 0 {
		return errors.New("invalid gzip trailer")
	}
	return nil
}
func commitMatches(actual, expected string) bool {
	return actual == expected || (len(actual) >= 12 && len(actual) < 40 && strings.HasPrefix(expected, actual))
}
