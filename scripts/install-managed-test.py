#!/usr/bin/env python3
"""Combined installer trust gates use real signed archives and an isolated host."""

import base64
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("managed", Path(__file__).with_name("install-managed.py"))
managed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(managed)


class ManagedInstallTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.calls = []
        self.attestation_failure = False
        self.prerelease = False
        self.key = self.root / "test-private.pem"
        # Deterministic disposable fixture, never a production signing key.
        der = bytes.fromhex("302e020100300506032b657004220420") + b"test-only-ed25519-seed-00000000000"[:32]
        self.key.write_bytes(b"-----BEGIN PRIVATE KEY-----\n" + base64.b64encode(der) + b"\n-----END PRIVATE KEY-----\n")
        self.key.chmod(0o600)
        self.public = self.root / "public.pem"
        subprocess.run(["openssl", "pkey", "-in", str(self.key), "-pubout", "-out", str(self.public)], check=True, capture_output=True)
        self.archive = self.root / "leviathan_linux_amd64.tar.gz"
        self.manifest = self.root / "leviathan_linux_amd64.manifest.json"
        self.binary = bytearray(128)
        self.binary[:6] = b"\x7fELF\x02\x01"
        self.binary[18:20] = (62).to_bytes(2, "little")
        self.make_archive()
        self.m = {
            "schema": "leviathan-release-v1", "version": "1.2.3", "commit": "a" * 40,
            "os": "linux", "arch": "amd64", "minimumGlibc": "2.34", "minimumUpdater": 1,
            "configProfile": "leviathan-config-v1", "stateProfile": "leviathan-state-v1",
            "archiveSha256": managed.digest(self.archive), "binarySha256": hashlib.sha256(self.binary).hexdigest(),
            "archiveBytes": self.archive.stat().st_size, "binaryBytes": len(self.binary),
        }
        self.sign_manifest()
        self.config = self.root / "updater.json"
        self.config.write_text(json.dumps({"trustedReleaseKeyFiles": [str(self.public)]}))
        self.config.chmod(0o600)
        self.token = self.root / "token"
        self.token.write_bytes(b"yenr1_disposable-test-token")
        self.token.chmod(0o600)
        self.args = managed.parser().parse_args([
            "--with-updater", "--version", "v1.2.3", "--commit", "a" * 40,
            "--updater-config", str(self.config), "--token-file", str(self.token),
            "--release-public-key", str(self.public), "--yggdrasil-cidr", "203.0.113.10/32",
        ])

    def install(self):
        return managed.install(self.args, self.runner, uid=os.getuid(), boundary=self.root,
                               temporary_parent=self.root, architecture="amd64")

    def make_archive(self, name="leviathan_1.2.3_linux_amd64/leviathan", kind=tarfile.REGTYPE):
        with tarfile.open(self.archive, "w:gz") as archive:
            member = tarfile.TarInfo(name)
            member.mode, member.type = 0o755, kind
            if kind == tarfile.SYMTYPE:
                member.linkname = "/tmp/outside"
                archive.addfile(member)
            else:
                member.size = len(self.binary)
                archive.addfile(member, io.BytesIO(self.binary))
            for file in ("leviathan-updater", "scripts/bootstrap-updater.py", "contrib/systemd/leviathan@.service", "contrib/systemd/leviathan-updater.service", "contrib/systemd/leviathan-updater-recover.service"):
                entry = tarfile.TarInfo("leviathan_1.2.3_linux_amd64/" + file)
                entry.mode, entry.size = 0o755, 10
                archive.addfile(entry, io.BytesIO(b"test-bytes"))

    def sign_manifest(self):
        message, signature = self.root / "message", self.root / "signature"
        message.write_bytes(b"leviathan-release-v1\n" + managed.canonical(self.m))
        subprocess.run(["openssl", "pkeyutl", "-sign", "-inkey", str(self.key), "-rawin", "-in", str(message), "-out", str(signature)], check=True, capture_output=True)
        envelope = {
            "keyId": hashlib.sha256(managed.key_bytes(self.public)).hexdigest()[:32],
            "manifest": self.m, "signature": base64.urlsafe_b64encode(signature.read_bytes()).rstrip(b"=").decode(),
        }
        self.manifest.write_bytes(managed.canonical(envelope) + b"\n")

    def runner(self, command):
        self.calls.append(command)
        if command[:3] == ["gh", "release", "view"]:
            self.assertEqual(command[3:6], ["v1.2.3", "--repo", "intellisys-stevens/leviathan"])
            return json.dumps({"tagName": "v1.2.3", "isDraft": False, "isPrerelease": self.prerelease}).encode()
        if command[:3] == ["gh", "release", "download"]:
            self.assertEqual(command[3:6], ["v1.2.3", "--repo", "intellisys-stevens/leviathan"])
            directory = Path(command[command.index("--dir") + 1])
            shutil.copyfile(self.archive, directory / self.archive.name)
            shutil.copyfile(self.manifest, directory / self.manifest.name)
            return b""
        if command[:3] == ["gh", "attestation", "verify"]:
            required = {
                "--repo": "intellisys-stevens/leviathan",
                "--signer-workflow": "github.com/intellisys-stevens/leviathan/.github/workflows/release.yml",
                "--source-ref": "refs/tags/v1.2.3", "--source-digest": "a" * 40, "--signer-digest": "a" * 40,
                "--cert-identity": "https://github.com/intellisys-stevens/leviathan/.github/workflows/release.yml@refs/tags/v1.2.3",
            }
            for flag, value in required.items():
                self.assertEqual(command[command.index(flag) + 1], value)
            self.assertIn("--deny-self-hosted-runners", command)
            self.assertNotEqual(Path(command[3]).parent, self.root)
            if self.attestation_failure:
                raise managed.InstallError("provenance rejected")
            return b"verified"
        if command[:2] == ["openssl", "pkeyutl"]:
            self.assertEqual(sum(c[:3] == ["gh", "attestation", "verify"] for c in self.calls), 2)
            return managed.run(command)
        if command == ["getconf", "GNU_LIBC_VERSION"]:
            return b"glibc 2.34"
        if command[0] == sys.executable and command[2].endswith("/scripts/bootstrap-updater.py"):
            self.assertEqual(sum(c[:3] == ["gh", "attestation", "verify"] for c in self.calls), 2)
            self.assertTrue(any(c[:2] == ["openssl", "pkeyutl"] for c in self.calls))
            self.assertEqual(command[1], "-I")
            self.assertIn("--enable-managed-updates", command)
            self.assertEqual(command[command.index("--token-file") + 1], str(self.token))
            self.assertNotIn(self.token.read_text(), repr(command))
            candidate = Path(command[command.index("--agent-binary") + 1])
            self.assertEqual(candidate.read_bytes(), self.binary)
            self.assertEqual(Path(command[2]).read_bytes(), b"test-bytes")
            return b"fixture bootstrap completed"
        self.fail("unexpected command: " + repr(command))

    def helper_ran(self):
        return any(c[0] == sys.executable for c in self.calls)

    def test_verified_release_runs_exact_helper_after_all_trust_gates(self):
        self.assertEqual(self.install(), "fixture bootstrap completed")
        self.assertTrue(self.helper_ran())
        self.assertFalse(list(self.root.glob("leviathan-install-*")))
        download = next(c for c in self.calls if c[:3] == ["gh", "release", "download"])
        self.assertEqual(download.count("--pattern"), 2)
        helper = next(c for c in self.calls if c[0] == sys.executable)
        self.assertEqual(helper[helper.index("--release-commit") + 1], "a" * 40)

    def test_dry_run_and_preview_are_explicitly_forwarded_without_token_contents(self):
        self.args.dry_run, self.args.allow_preview = True, True
        self.install()
        helper = next(c for c in self.calls if c[0] == sys.executable)
        self.assertIn("--dry-run", helper)
        self.assertIn("--allow-preview", helper)
        self.assertNotIn("yenr1_disposable-test-token", repr(self.calls))

    def test_provenance_or_prerelease_failure_never_executes_helper(self):
        for prerelease in (False, True):
            with self.subTest(prerelease=prerelease):
                self.attestation_failure, self.prerelease = True, prerelease
                with self.assertRaises(managed.InstallError):
                    self.install()
                self.assertFalse(self.helper_ran())
                self.assertFalse(any(c[0] == "openssl" for c in self.calls))

    def test_tampering_and_unsafe_archive_members_fail_before_execution(self):
        for tamper in ("archive", "signature", "wrong_commit", "unsafe_path", "symlink", "hardlink", "wrong_arch", "missing_helper", "wrong_profile"):
            with self.subTest(tamper=tamper):
                self.setUp()
                if tamper == "archive": self.archive.write_bytes(self.archive.read_bytes() + b"tampered")
                if tamper == "signature":
                    signed = json.loads(self.manifest.read_bytes())
                    signed["signature"] = "A" * 86
                    self.manifest.write_bytes(managed.canonical(signed) + b"\n")
                if tamper == "wrong_commit":
                    self.m["commit"] = "b" * 40
                    self.sign_manifest()
                if tamper == "wrong_profile":
                    self.m["configProfile"] = "incompatible-v9"
                    self.sign_manifest()
                if tamper in ("unsafe_path", "symlink", "hardlink", "wrong_arch", "missing_helper"):
                    if tamper == "unsafe_path": self.make_archive("leviathan_1.2.3_linux_amd64/../outside")
                    if tamper == "symlink": self.make_archive(kind=tarfile.SYMTYPE)
                    if tamper == "hardlink": self.make_archive(kind=tarfile.LNKTYPE)
                    if tamper == "wrong_arch":
                        self.binary[18:20] = (183).to_bytes(2, "little")
                        self.make_archive()
                    if tamper == "missing_helper":
                        with tarfile.open(self.archive, "w:gz") as archive:
                            member = tarfile.TarInfo("leviathan_1.2.3_linux_amd64/leviathan")
                            member.mode, member.size = 0o755, len(self.binary)
                            archive.addfile(member, io.BytesIO(self.binary))
                    self.m["archiveBytes"], self.m["archiveSha256"] = self.archive.stat().st_size, managed.digest(self.archive)
                    self.sign_manifest()
                with self.assertRaises((managed.InstallError, OSError)):
                    self.install()
                self.assertFalse(self.helper_ran())
                self.assertFalse(list(self.root.glob("leviathan-install-*")))

    def test_local_input_validation_fails_before_github(self):
        for case in ("latest", "prerelease", "commit", "install_dir", "cidr", "key_not_registered", "public_token", "wrong_key", "symlink"):
            with self.subTest(case=case):
                self.setUp()
                if case == "latest": self.args.version = "latest"
                if case == "prerelease": self.args.version = "v1.2.3-rc.1"
                if case == "commit": self.args.commit = "main"
                if case == "install_dir": self.args.install_dir = "/root/.local/bin"
                if case == "cidr": self.args.yggdrasil_cidr = []
                if case == "key_not_registered": self.config.write_text('{"trustedReleaseKeyFiles": []}')
                if case == "public_token": self.token.chmod(0o644)
                if case == "wrong_key": self.public.write_bytes(b"not a key")
                if case == "symlink":
                    self.token.unlink()
                    self.token.symlink_to(self.public)
                with self.assertRaises(managed.InstallError):
                    self.install()
                self.assertEqual(self.calls, [])

    def test_missing_required_flag_is_an_argument_error(self):
        arguments = ["--with-updater", "--version", "v1.2.3"]
        with self.assertRaises(SystemExit), patch("sys.stderr", io.StringIO()):
            managed.parser().parse_args(arguments)

    def test_missing_dependency_fails_before_network_or_host_mutation(self):
        with patch.object(managed.os, "geteuid", return_value=0), patch.object(managed.sys, "platform", "linux"), patch.object(managed.shutil, "which", return_value=None), patch.object(managed, "parser") as parser, patch.object(managed, "install") as install, patch("sys.stderr", io.StringIO()) as error:
            parser.return_value.parse_args.return_value = self.args
            self.assertEqual(managed.main(), 1)
            self.assertIn("required command not found: gh", error.getvalue())
            install.assert_not_called()

    def test_untrusted_working_directory_and_pythonpath_cannot_inject_imports(self):
        hostile = self.root / "hostile"
        hostile.mkdir()
        marker = self.root / "injected"
        for name in ("json.py", "hashlib.py", "sitecustomize.py"):
            (hostile / name).write_text("from pathlib import Path\nPath(" + repr(str(marker)) + ").write_text('injected')\nraise RuntimeError('untrusted import')\n")
        installer = Path(__file__).resolve().with_name("install.sh")
        environment = os.environ.copy()
        environment["PYTHONPATH"] = str(hostile)
        for extra in (["--help"], ["--dry-run", "--version", "v1.2.3"]):
            result = subprocess.run(["/bin/sh", str(installer), "--with-updater", *extra], cwd=hostile, env=environment, capture_output=True)
            self.assertFalse(marker.exists())
            self.assertNotIn(b"untrusted import", result.stderr)
            if extra == ["--help"]:
                self.assertEqual(result.returncode, 0)
                self.assertIn(b"--with-updater", result.stdout)

    def test_embedded_installer_verifier_is_current(self):
        subprocess.run([sys.executable, str(Path(__file__).with_name("sync-managed-installer.py")), "--check"], check=True, capture_output=True)


if __name__ == "__main__":
    unittest.main()
