#!/usr/bin/env python3
"""Release pin and public-key publication policy regressions (offline fixtures)."""

import base64
import hashlib
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parent
sys.dont_write_bytecode = True


def module(name):
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), SCRIPTS / (name + ".py"))
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


stamp = module("stamp-installer")
keys = module("validate-update-public-keys")


class ReleaseInstallerTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = (SCRIPTS / "install.sh").read_text()
        for arch in ("amd64", "arm64"):
            (self.root / f"leviathan_linux_{arch}.tar.gz").write_bytes(f"archive-{arch}".encode())
            (self.root / f"leviathan-updater_linux_{arch}").write_bytes(f"helper-{arch}".encode())

    def test_both_architectures_are_pinned_without_circular_installer_hash(self):
        generated = stamp.stamp(self.source, self.root, "v0.4.0", "a" * 40)
        self.assertIn("release_version='0.4.0'", generated)
        self.assertIn("release_commit='" + "a" * 40 + "'", generated)
        for arch in ("amd64", "arm64"):
            for kind, content in (("archive", f"archive-{arch}"), ("updater", f"helper-{arch}")):
                pin = hashlib.sha256(content.encode()).hexdigest()
                self.assertIn(f"release_{arch}_{kind}_sha256='{pin}'", generated)
        self.assertEqual(stamp.stamp(generated, self.root, "0.4.0", "a" * 40), generated)
        subprocess.run(["sh", "-n"], input=generated, text=True, check=True)
        self.assertIn("release_version=''", self.source)

    def test_requires_exact_stable_build_and_all_regular_assets(self):
        for version, commit in (("0.4.0-preview", "a" * 40), ("01.4.0", "a" * 40), ("0.4.0", "main"), ("0.4.0", "A" * 40)):
            with self.subTest(version=version, commit=commit), self.assertRaises(ValueError):
                stamp.stamp(self.source, self.root, version, commit)
        asset = self.root / "leviathan-updater_linux_arm64"
        asset.unlink()
        with self.assertRaises(ValueError):
            stamp.stamp(self.source, self.root, "0.4.0", "a" * 40)
        asset.symlink_to(self.root / "leviathan-updater_linux_amd64")
        with self.assertRaises(ValueError):
            stamp.stamp(self.source, self.root, "0.4.0", "a" * 40)
        asset.unlink()
        asset.touch()
        with self.assertRaises(ValueError):
            stamp.stamp(self.source, self.root, "0.4.0", "a" * 40)

    def test_rejects_ambiguous_template_and_source_overwrite(self):
        for source in (self.source.replace(stamp.START, ""), self.source + stamp.START + stamp.END):
            with self.assertRaises(ValueError):
                stamp.stamp(source, self.root, "0.4.0", "a" * 40)
        source = self.root / "template.sh"
        source.write_text(self.source)
        result = subprocess.run([sys.executable, str(SCRIPTS / "stamp-installer.py"), "--version", "0.4.0", "--commit", "a" * 40, "--directory", str(self.root), "--source", str(source), "--output", str(source)], capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(source.read_text(), self.source)

    def test_cli_generates_executable_release_asset(self):
        subprocess.run([sys.executable, str(SCRIPTS / "stamp-installer.py"), "--version", "v0.4.0", "--commit", "a" * 40, "--directory", str(self.root)], check=True)
        result = self.root / "install.sh"
        self.assertEqual(result.stat().st_mode & 0o777, 0o755)
        self.assertEqual(result.read_text(), stamp.stamp(self.source, self.root, "0.4.0", "a" * 40))


class PublicKeyPolicyTest(unittest.TestCase):
    def test_roots_are_present_unique_and_canonical(self):
        valid = base64.b64encode(bytes(range(32))).rstrip(b"=").decode()
        self.assertEqual(keys.validate(valid), valid)
        for value in ("", valid + "=", valid + "," + valid, " " + valid, "invalid", valid[:-1], ",".join([valid] * 9)):
            with self.subTest(value=value), self.assertRaises(ValueError):
                keys.validate(value)

    def test_known_fixture_key_never_enters_production(self):
        public = base64.b64encode(keys.TEST_KEY).rstrip(b"=").decode()
        with self.assertRaisesRegex(ValueError, "test release root"):
            keys.validate(public)
        self.assertEqual(keys.validate(public, allow_test=True), public)
        environment = os.environ.copy()
        environment.pop("LEVIATHAN_UPDATE_PUBLIC_KEYS", None)
        script = [sys.executable, str(SCRIPTS / "validate-update-public-keys.py")]
        self.assertNotEqual(subprocess.run(script, env=environment, capture_output=True).returncode, 0)
        environment["LEVIATHAN_UPDATE_PUBLIC_KEYS"] = public
        self.assertNotEqual(subprocess.run(script, env=environment, capture_output=True).returncode, 0)
        self.assertEqual(subprocess.run(script + ["--allow-test-key"], env=environment, capture_output=True).returncode, 0)

    def test_signer_must_match_embedded_roots_and_key_id(self):
        # RFC 8032's published test seed is an intentional non-secret fixture.
        seed = bytes.fromhex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
        with tempfile.TemporaryDirectory() as temporary:
            signer = Path(temporary) / "published-test-vector.key"
            public = base64.b64encode(keys.TEST_KEY).rstrip(b"=").decode()
            identity = hashlib.sha256(keys.TEST_KEY).hexdigest()[:32]
            for private in (seed, seed + keys.TEST_KEY):
                signer.write_bytes(base64.b64encode(private) + b"\n")
                signer.chmod(0o600)
                self.assertEqual(keys.validate(public, True, signer, identity), public)
                environment = os.environ.copy()
                environment["LEVIATHAN_UPDATE_PUBLIC_KEYS"] = public
                result = subprocess.run([sys.executable, str(SCRIPTS / "validate-update-public-keys.py"), "--allow-test-key", "--signing-key-file", str(signer), "--expected-key-id", identity], env=environment, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout, public + "\n")
                self.assertNotIn(base64.b64encode(private).decode(), result.stdout + result.stderr)
            with self.assertRaisesRegex(ValueError, "does not match"):
                keys.validate(public, True, signer, "0" * 32)
            with self.assertRaisesRegex(ValueError, "does not match"):
                keys.validate(base64.b64encode(bytes(range(32))).rstrip(b"=").decode(), True, signer, identity)
            with self.assertRaisesRegex(ValueError, "test release root"):
                keys.validate(public, False, signer, identity)

    def test_signer_rejects_malformed_or_publicly_readable_inputs(self):
        seed = bytes.fromhex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
        with tempfile.TemporaryDirectory() as temporary:
            signer = Path(temporary) / "published-test-vector.key"
            for encoded in (b"", b"bad", base64.b64encode(b"short"), base64.b64encode(seed + bytes(32)), b"x" * 4097, b"-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----\n"):
                signer.write_bytes(encoded)
                signer.chmod(0o600)
                with self.subTest(encoded=encoded[:20]), self.assertRaises(ValueError):
                    keys.signer_public_key(signer)
            signer.write_bytes(base64.b64encode(seed))
            signer.chmod(0o644)
            with self.assertRaisesRegex(ValueError, "private regular"):
                keys.signer_public_key(signer)
            signer.chmod(0o600)
            link = Path(temporary) / "linked.key"
            link.symlink_to(signer)
            with self.assertRaises(OSError):
                keys.signer_public_key(link)


if __name__ == "__main__":
    unittest.main()
