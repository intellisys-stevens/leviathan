#!/usr/bin/env python3
"""Exercise the shell installer against pinned offline release/helper fixtures."""

import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location("stamp_installer", SCRIPTS / "stamp-installer.py")
STAMP = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(STAMP)
COMMIT = "a" * 40
VERSION = "0.4.0"
BASE = "https://github.com/intellisys-stevens/leviathan/releases/download/v" + VERSION

HELPER = r'''#!/bin/sh
set -eu
printf '%s\n' "$@" > "$FIXTURE_ARGUMENTS"
[ "$1" = setup ] || exit 20
shift
directory=
without=false
managed=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --install-dir) directory=$2; shift 2 ;;
    --without-updater) without=true; shift ;;
    --control-origin) managed=true; shift 2 ;;
    --ticket-stdin) cat > "$FIXTURE_TICKET"; shift ;;
    --version | --commit | --archive-url | --archive-sha256) shift 2 ;;
    *) exit 21 ;;
  esac
done
[ "${FIXTURE_HELPER_FAILURE:-0}" = 0 ] || exit 29
if [ "$managed" = false ]; then
  mkdir -p "$directory"
  printf '%s\n' "monitor-FIXTURE_ARCH" > "$directory/leviathan"
  if [ "$without" = false ]; then
    cp "$0" "$directory/leviathan-updater"
    chmod 0755 "$directory/leviathan-updater"
  fi
fi
'''


class DefaultInstallTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.release = self.root / "release"
        self.bin = self.root / "fake-bin"
        self.home = self.root / "home"
        self.staging = self.root / "staging"
        for directory in (self.release, self.bin, self.home, self.staging):
            directory.mkdir()
        self.environment = {key: value for key, value in os.environ.items() if not key.startswith(("LEVIATHAN_", "MIG" + "LENS_"))}
        self.environment.update({"PATH": str(self.bin) + ":/usr/bin:/bin", "HOME": str(self.home), "TMPDIR": str(self.staging), "FIXTURE_RELEASE": str(self.release), "FIXTURE_REQUESTS": str(self.root / "requests"), "FIXTURE_ARGUMENTS": str(self.root / "arguments"), "FIXTURE_TICKET": str(self.root / "ticket"), "FIXTURE_TEMP": str(self.staging)})
        checksum = shutil.which("sha256sum")
        self.assertIsNotNone(checksum, "installer tests require sha256sum")
        (self.bin / "sha256sum").symlink_to(checksum)
        self.write_command("uname", '#!/bin/sh\ncase "$1" in -s) echo "${FIXTURE_OS:-Linux}";; -m) echo "${FIXTURE_ARCH:-x86_64}";; esac\n')
        self.write_command("getconf", '#!/bin/sh\nprintf "%s\\n" "${FIXTURE_LIBC:-glibc 2.34}"\n')
        self.write_command("id", '#!/bin/sh\nprintf "%s\\n" "${FIXTURE_UID:-1000}"\n')
        self.write_command("mktemp", '#!/bin/sh\n[ "$1" = -d ] || exit 30\nexec /usr/bin/mktemp -d "$FIXTURE_TEMP/install.XXXXXX"\n')
        self.write_command("curl", r'''#!/bin/sh
set -eu
output=
url=
printf '%s\n' "$@" >> "$FIXTURE_REQUESTS"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) output=$2; shift 2 ;;
    --proto | --connect-timeout | --max-time | --max-filesize) shift 2 ;;
    -*) shift ;;
    *) url=$1; shift ;;
  esac
done
[ -n "$url" ] && [ -n "$output" ] || exit 31
[ "${FIXTURE_CURL_FAILURE:-0}" = 0 ] || exit 32
cp "$FIXTURE_RELEASE/${url##*/}" "$output"
''')
        for name in ("python3", "gh"):
            self.write_command(name, '#!/bin/sh\necho "unexpected dependency" >&2\nexit 33\n')
        for arch in ("amd64", "arm64"):
            (self.release / f"leviathan_linux_{arch}.tar.gz").write_bytes(f"signed-archive-{arch}".encode())
            (self.release / f"leviathan-updater_linux_{arch}").write_text(HELPER.replace("FIXTURE_ARCH", arch))
        self.installer = self.release / "install.sh"
        self.installer.write_text(STAMP.stamp((SCRIPTS / "install.sh").read_text(), self.release, VERSION, COMMIT))

    def write_command(self, name, contents):
        path = self.bin / name
        path.write_text(contents)
        path.chmod(0o755)

    def invoke(self, *arguments, source=False, stdin="", **environment):
        env = {**self.environment, **environment}
        result = subprocess.run(["/bin/sh", str(SCRIPTS / "install.sh" if source else self.installer), *arguments], input=stdin, text=True, env=env, capture_output=True, timeout=10)
        self.assertEqual(list(self.staging.iterdir()), [], "private downloaded helpers must be removed on success and failure")
        return result

    def successful(self, *arguments, **kwargs):
        result = self.invoke(*arguments, **kwargs)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result

    def requests(self):
        path = self.root / "requests"
        return path.read_text() if path.exists() else ""

    def helper_arguments(self):
        return (self.root / "arguments").read_text().splitlines()

    def assert_before_helper_failure(self, *arguments, **kwargs):
        result = self.invoke(*arguments, **kwargs)
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse((self.root / "arguments").exists())
        return result

    def test_default_installs_both_without_python_or_gh(self):
        self.successful()
        directory = self.home / ".local/bin"
        self.assertEqual((directory / "leviathan").read_text(), "monitor-amd64\n")
        self.assertTrue((directory / "leviathan-updater").is_file())
        self.assertEqual(self.helper_arguments(), ["setup", "--version", VERSION, "--commit", COMMIT, "--archive-url", BASE + "/leviathan_linux_amd64.tar.gz", "--archive-sha256", STAMP.hashlib.sha256(b"signed-archive-amd64").hexdigest(), "--install-dir", str(directory)])
        self.assertIn(BASE + "/leviathan-updater_linux_amd64", self.requests())
        self.assertIn("--proto\n=https\n", self.requests())
        self.assertNotIn("install.sh", self.requests())

    def test_explicit_opt_out_installs_only_monitor(self):
        self.successful("--without-updater")
        directory = self.home / ".local/bin"
        self.assertTrue((directory / "leviathan").is_file())
        self.assertFalse((directory / "leviathan-updater").exists())
        self.assertIn("--without-updater", self.helper_arguments())

    def test_architecture_flags_override_environment_and_preserve_spaces(self):
        directory = self.root / "chosen directory"
        self.successful("--version=v0.4.0", "--install-dir", str(directory), LEVIATHAN_VERSION="9.9.9", LEVIATHAN_INSTALL_DIR=str(self.root / "wrong"), FIXTURE_ARCH="aarch64", FIXTURE_LIBC="glibc 2.39")
        self.assertEqual((directory / "leviathan").read_text(), "monitor-arm64\n")
        self.assertIn(BASE + "/leviathan_linux_arm64.tar.gz", self.helper_arguments())
        self.assertFalse((self.root / "wrong").exists())

    def test_environment_defaults_are_preserved(self):
        directory = self.root / "custom"
        self.successful(LEVIATHAN_VERSION="v0.4.0", LEVIATHAN_INSTALL_DIR=str(directory))
        self.assertTrue((directory / "leviathan-updater").exists())

    def test_source_resolves_official_generated_release_then_verifies_helper(self):
        self.successful(source=True)
        self.assertIn("https://github.com/intellisys-stevens/leviathan/releases/latest/download/install.sh", self.requests())
        self.assertIn(BASE + "/leviathan-updater_linux_amd64", self.requests())
        self.assertTrue((self.home / ".local/bin/leviathan-updater").exists())

    def test_source_explicit_version_keeps_opt_out_and_directory(self):
        directory = self.root / "chosen"
        self.successful("--version", "v0.4.0", "--without-updater", "--install-dir", str(directory), source=True)
        self.assertIn(BASE + "/install.sh", self.requests())
        self.assertTrue((directory / "leviathan").exists())
        self.assertFalse((directory / "leviathan-updater").exists())

    def test_rejects_tampered_helper_before_execution(self):
        path = self.release / "leviathan-updater_linux_amd64"
        path.write_text(path.read_text() + "\necho modified\n")
        result = self.assert_before_helper_failure()
        self.assertIn("checksum verification failed", result.stderr)
        self.assertFalse((self.home / ".local/bin").exists())

    def test_managed_command_preserves_ticket_stdin_and_maps_alias(self):
        for option in ("--yggdrasil", "--control-origin"):
            with self.subTest(option=option):
                self.successful(option, "https://control.example", "--ticket-stdin", stdin="fixture-ticket\n", FIXTURE_UID="0")
                arguments = self.helper_arguments()
                self.assertEqual(arguments[-3:], ["--control-origin", "https://control.example", "--ticket-stdin"])
                self.assertNotIn("--install-dir", arguments)
                self.assertNotIn("fixture-ticket", " ".join(arguments))
                self.assertNotIn("fixture-ticket", self.requests())
                self.assertEqual((self.root / "ticket").read_text(), "fixture-ticket\n")

    def test_source_managed_command_retains_stdin_across_download(self):
        self.successful("--yggdrasil=https://control.example", "--ticket-stdin", source=True, stdin="fixture-ticket\n", FIXTURE_UID="0")
        self.assertEqual((self.root / "ticket").read_text(), "fixture-ticket\n")

    def test_rejects_bad_managed_arguments_and_nonroot_before_download(self):
        for arguments in (("--yggdrasil", "https://control.example"), ("--ticket-stdin",), ("--yggdrasil", "http://control.example", "--ticket-stdin"), ("--yggdrasil", "https://control.example", "--ticket-stdin", "--without-updater"), ("--yggdrasil", "https://control.example", "--ticket-stdin")):
            with self.subTest(arguments=arguments):
                self.assert_before_helper_failure(*arguments)
                self.assertEqual(self.requests(), "")

    def test_rejects_platform_glibc_version_and_home_before_download(self):
        cases = [((), {"FIXTURE_OS": "Darwin"}), ((), {"FIXTURE_ARCH": "riscv64"}), ((), {"FIXTURE_LIBC": "glibc 2.33"}), ((), {"FIXTURE_LIBC": "musl 1.2.5"}), ((), {"HOME": ""}), (("--version", "0.4.0-preview"), {}), (("--version", "bad"), {}), (("--version", "00.4.0"), {}), (("--version",), {}), (("--unknown",), {})]
        for arguments, env in cases:
            with self.subTest(arguments=arguments, env=env):
                self.assert_before_helper_failure(*arguments, **env)
                self.assertEqual(self.requests(), "")

    def test_dangling_managed_link_is_not_overwritten(self):
        directory = self.home / ".local/bin"
        directory.mkdir(parents=True)
        target = directory / "leviathan"
        target.symlink_to("/opt/leviathan/current/leviathan")
        result = self.assert_before_helper_failure()
        self.assertIn("managed by leviathan-updater", result.stderr)
        self.assertEqual(os.readlink(target), "/opt/leviathan/current/leviathan")
        self.assertEqual(self.requests(), "")

    def test_old_or_mismatched_release_installer_is_rejected(self):
        original = self.installer.read_text()
        for content, arguments in (("#!/bin/sh\nexit 0\n", ()), (original.replace("release_version='0.4.0'", "release_version=''"), ()), (original.replace("release_version='0.4.0'", "release_version='0.5.0'"), ("--version", "0.4.0"))):
            with self.subTest(arguments=arguments):
                self.installer.write_text(content)
                self.assert_before_helper_failure(*arguments, source=True)

    def test_download_and_helper_failures_leave_no_staging_files(self):
        self.assert_before_helper_failure(FIXTURE_CURL_FAILURE="1")
        result = self.invoke(FIXTURE_HELPER_FAILURE="1")
        self.assertEqual(result.returncode, 29)
        self.assertFalse((self.home / ".local/bin").exists())


if __name__ == "__main__":
    unittest.main()
