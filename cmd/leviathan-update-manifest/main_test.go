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
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/intellisys-stevens/leviathan/internal/updateprotocol"
)

func fixture(t *testing.T, entry string, kind byte, machine uint16) (string, []byte) {
	t.Helper()
	file := filepath.Join(t.TempDir(), "archive.tar.gz")
	f, err := os.Create(file)
	if err != nil {
		t.Fatal(err)
	}
	gz := gzip.NewWriter(f)
	tw := tar.NewWriter(gz)
	b := make([]byte, 128)
	copy(b, "\x7fELF")
	b[4], b[5] = 2, 1
	binary.LittleEndian.PutUint16(b[18:], machine)
	h := &tar.Header{Name: entry, Typeflag: kind, Mode: 0755, Size: int64(len(b))}
	if kind == tar.TypeSymlink {
		h.Size, h.Linkname = 0, "/usr/local/bin/leviathan"
	}
	if err := tw.WriteHeader(h); err != nil {
		t.Fatal(err)
	}
	if h.Size > 0 {
		if _, err := tw.Write(b); err != nil {
			t.Fatal(err)
		}
	}
	for _, err := range []error{tw.Close(), gz.Close(), f.Close()} {
		if err != nil {
			t.Fatal(err)
		}
	}
	return file, b
}

func TestSignedArchiveIdentity(t *testing.T) {
	archive, binaryData := fixture(t, "leviathan_1.2.3_linux_amd64/leviathan", tar.TypeReg, 62)
	seed := bytes.Repeat([]byte{7}, ed25519.SeedSize) // Test fixture only.
	key := ed25519.NewKeyFromSeed(seed)
	keyFile := filepath.Join(t.TempDir(), "key")
	if err := os.WriteFile(keyFile, []byte(base64.StdEncoding.EncodeToString(seed)), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	err := run([]string{"--archive", archive, "--version", "v1.2.3", "--commit", strings.Repeat("a", 40), "--arch", "amd64", "--key-file", keyFile}, &out)
	if err != nil {
		t.Fatal(err)
	}
	var signed updateprotocol.SignedManifest
	if err := json.Unmarshal(out.Bytes(), &signed); err != nil {
		t.Fatal(err)
	}
	pub := key.Public().(ed25519.PublicKey)
	m, err := updateprotocol.VerifyManifest(signed, map[string]ed25519.PublicKey{updateprotocol.KeyID(pub): pub})
	if err != nil {
		t.Fatal(err)
	}
	archiveData, _ := os.ReadFile(archive)
	a, b := sha256.Sum256(archiveData), sha256.Sum256(binaryData)
	if m.ArchiveSHA256 != hex.EncodeToString(a[:]) || m.BinarySHA256 != hex.EncodeToString(b[:]) || m.ArchiveBytes != int64(len(archiveData)) || m.BinaryBytes != int64(len(binaryData)) || m.Commit != strings.Repeat("a", 40) {
		t.Fatalf("signed identity does not match archive: %+v", m)
	}
	if err := run([]string{"--archive", archive}, &out); err == nil {
		t.Fatal("missing key was accepted")
	}
	if err := os.Chmod(keyFile, 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := readPrivateKey(keyFile); err == nil {
		t.Fatal("publicly readable private key was accepted")
	}
}

func TestRejectUnsafeArchives(t *testing.T) {
	for _, tc := range []struct {
		name, entry string
		kind        byte
		machine     uint16
	}{
		{"traversal", "leviathan_1.2.3_linux_amd64/../leviathan", tar.TypeReg, 62},
		{"absolute", "/leviathan_1.2.3_linux_amd64/leviathan", tar.TypeReg, 62},
		{"wrong_version", "leviathan_1.2.4_linux_amd64/leviathan", tar.TypeReg, 62},
		{"link", "leviathan_1.2.3_linux_amd64/leviathan", tar.TypeSymlink, 62},
		{"wrong_arch", "leviathan_1.2.3_linux_amd64/leviathan", tar.TypeReg, 183},
	} {
		t.Run(tc.name, func(t *testing.T) {
			archive, _ := fixture(t, tc.entry, tc.kind, tc.machine)
			m := updateprotocol.Manifest{Version: "1.2.3", Arch: "amd64"}
			if inspectArchive(archive, &m) == nil {
				t.Fatal("unsafe archive was accepted")
			}
		})
	}
}
