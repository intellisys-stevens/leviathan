// leviathan-update-manifest signs immutable release metadata in protected CI.
// It never generates keys or executes a release binary.
package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path"
	"strings"

	"github.com/intellisys-stevens/leviathan/internal/updateprotocol"
)

func main() {
	if err := run(os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "leviathan-update-manifest:", err)
		os.Exit(1)
	}
}

func run(args []string, out io.Writer) error {
	f := flag.NewFlagSet("leviathan-update-manifest", flag.ContinueOnError)
	archive := f.String("archive", "", "local official native release archive")
	version := f.String("version", "", "stable release version or tag")
	commit := f.String("commit", "", "full 40-character lowercase source commit")
	arch := f.String("arch", "", "linux architecture: amd64 or arm64")
	keyFile := f.String("key-file", "", "mode-0600 file containing a base64 Ed25519 seed or private key")
	expectedKeyID := f.String("expected-key-id", "", "require this separately configured public key identifier")
	glibc := f.String("minimum-glibc", "2.34", "oldest supported glibc")
	if err := f.Parse(args); err != nil {
		return err
	}
	if f.NArg() != 0 || *archive == "" || *keyFile == "" {
		return errors.New("--archive and --key-file are required; unsigned managed releases are forbidden")
	}
	m := updateprotocol.Manifest{
		Schema: updateprotocol.ManifestSchema, Version: strings.TrimPrefix(*version, "v"),
		Commit: *commit, OS: "linux", Arch: *arch, MinimumGlibc: *glibc,
		MinimumUpdater: updateprotocol.ProtocolVersion, ConfigProfile: updateprotocol.ConfigProfile,
		StateProfile: updateprotocol.StateProfile,
	}
	if !updateprotocol.StableVersion(m.Version) || (m.Arch != "amd64" && m.Arch != "arm64") {
		return errors.New("a stable version and supported architecture are required")
	}
	key, err := readPrivateKey(*keyFile)
	if err != nil {
		return err
	}
	if *expectedKeyID != "" && updateprotocol.KeyID(key.Public().(ed25519.PublicKey)) != *expectedKeyID {
		return errors.New("signing key does not match the configured public key identifier")
	}
	if err = inspectArchive(*archive, &m); err != nil {
		return err
	}
	signed, err := updateprotocol.SignManifest(m, key)
	if err != nil {
		return fmt.Errorf("invalid release metadata: %w", err)
	}
	return json.NewEncoder(out).Encode(signed)
}

func readPrivateKey(name string) (ed25519.PrivateKey, error) {
	info, err := os.Lstat(name)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || info.Size() > 4096 {
		return nil, errors.New("signing key must be a private regular file with mode 0600 or stricter")
	}
	data, err := os.ReadFile(name)
	if err != nil {
		return nil, errors.New("cannot read signing key")
	}
	key, err := base64.StdEncoding.Strict().DecodeString(strings.TrimSpace(string(data)))
	if err != nil {
		return nil, errors.New("signing key must be standard base64")
	}
	if len(key) == ed25519.SeedSize {
		return ed25519.NewKeyFromSeed(key), nil
	}
	if len(key) == ed25519.PrivateKeySize && bytes.Equal(ed25519.NewKeyFromSeed(key[:ed25519.SeedSize]), key) {
		return ed25519.PrivateKey(key), nil
	}
	return nil, errors.New("signing key is not a valid Ed25519 seed or private key")
}

func inspectArchive(name string, m *updateprotocol.Manifest) error {
	info, err := os.Lstat(name)
	if err != nil || !info.Mode().IsRegular() || info.Size() < 1 || info.Size() > updateprotocol.MaxArchiveBytes {
		return errors.New("archive must be a bounded regular file")
	}
	f, err := os.Open(name)
	if err != nil {
		return err
	}
	defer f.Close()
	hash := sha256.New()
	n, err := io.Copy(hash, io.LimitReader(f, updateprotocol.MaxArchiveBytes+1))
	if err != nil || n != info.Size() {
		return errors.New("archive changed or exceeded its limit while reading")
	}
	m.ArchiveSHA256, m.ArchiveBytes = hex.EncodeToString(hash.Sum(nil)), n
	if _, err = f.Seek(0, io.SeekStart); err != nil {
		return err
	}
	gz, err := gzip.NewReader(f)
	if err != nil {
		return fmt.Errorf("invalid gzip archive: %w", err)
	}
	defer gz.Close()
	tr := tar.NewReader(io.LimitReader(gz, 2*updateprotocol.MaxArchiveBytes+1))
	root := "leviathan_" + m.Version + "_linux_" + m.Arch
	seen := make(map[string]bool)
	var expanded int64
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return fmt.Errorf("invalid tar archive: %w", err)
		}
		clean := strings.TrimSuffix(h.Name, "/")
		if path.Clean(clean) != clean || strings.Contains(clean, "\\") || !(clean == root || strings.HasPrefix(clean, root+"/")) || seen[clean] {
			return errors.New("archive contains an unsafe, duplicate, or unexpected path")
		}
		seen[clean] = true
		if h.Typeflag != tar.TypeReg && h.Typeflag != tar.TypeDir {
			return errors.New("archive contains a link or unsupported entry type")
		}
		expanded += h.Size
		if h.Size < 0 || expanded > 2*updateprotocol.MaxArchiveBytes || len(seen) > 100000 {
			return errors.New("expanded archive exceeds its limit")
		}
		if clean != root+"/leviathan" {
			continue
		}
		if h.Typeflag != tar.TypeReg || h.Mode&0111 == 0 || h.Size < 64 || h.Size > updateprotocol.MaxBinaryBytes {
			return errors.New("leviathan must be a bounded executable regular file")
		}
		var header [64]byte
		if _, err = io.ReadFull(tr, header[:]); err != nil {
			return err
		}
		machine := uint16(62)
		if m.Arch == "arm64" {
			machine = 183
		}
		if string(header[:4]) != "\x7fELF" || header[4] != 2 || header[5] != 1 || binary.LittleEndian.Uint16(header[18:20]) != machine {
			return errors.New("leviathan ELF architecture does not match release metadata")
		}
		binaryHash := sha256.New()
		_, _ = binaryHash.Write(header[:])
		copied, err := io.Copy(binaryHash, tr)
		if err != nil || copied+64 != h.Size {
			return errors.New("truncated leviathan binary")
		}
		m.BinarySHA256, m.BinaryBytes = hex.EncodeToString(binaryHash.Sum(nil)), h.Size
	}
	if m.BinarySHA256 == "" {
		return errors.New("archive does not contain its exact leviathan binary")
	}
	return nil
}
