#!/usr/bin/env python3
"""Trusted managed installer source, embedded verbatim in install.sh.

Run scripts/sync-managed-installer.py after changing this file. This verifier
runs before any downloaded helper or executable. The module API permits fixture
injection; the command line always targets the real local Linux host.
"""

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile

REPOSITORY = "intellisys-stevens/leviathan"
WORKFLOW = ".github/workflows/release.yml"
SCHEMA = "leviathan-release-v1"
MAX_ARCHIVE = 512 << 20
MAX_BINARY = 256 << 20
MAX_MANIFEST = 256 << 10
FIELDS = ("schema", "version", "commit", "os", "arch", "minimumGlibc", "minimumUpdater", "configProfile", "stateProfile", "archiveSha256", "binarySha256", "archiveBytes", "binaryBytes")
STABLE = r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"


class InstallError(Exception):
    pass


def fail(message):
    raise InstallError(message)


def unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            fail("duplicate JSON member")
        value[key] = item
    return value


def decode(raw):
    try:
        return json.loads(raw, object_pairs_hook=unique_object)
    except (ValueError, TypeError, UnicodeError):
        fail("invalid JSON")


def canonical(value):
    # Match Go encoding/json, including HTML and line-separator escaping.
    data = json.dumps(value, separators=(",", ":"), ensure_ascii=False)
    for char, escaped in (("<", "\\u003c"), (">", "\\u003e"), ("&", "\\u0026"), ("\u2028", "\\u2028"), ("\u2029", "\\u2029")):
        data = data.replace(char, escaped)
    return data.encode()


def run(command):
    environment = os.environ.copy()
    environment["GH_HOST"] = "github.com"
    result = subprocess.run(command, env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if result.returncode:
        # Do not relay arbitrary release metadata or credential-bearing output.
        fail(f"verification command failed: {Path(command[0]).name} {command[1]}")
    return result.stdout


def bounded_file(path, maximum):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or not 1 <= info.st_size <= maximum:
        fail("input must be a bounded regular file, never a symlink")
    return info.st_size


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def stage_local(source, destination, maximum):
    bounded_file(source, maximum)
    with source.open("rb") as reader, destination.open("xb") as writer:
        total = 0
        while chunk := reader.read(1 << 20):
            total += len(chunk)
            if total > maximum:
                fail("input exceeded its limit while staging")
            writer.write(chunk)
    bounded_file(destination, maximum)


def key_bytes(key_file):
    bounded_file(key_file, 4096)
    match = re.fullmatch(rb"\s*-----BEGIN PUBLIC KEY-----\s+([A-Za-z0-9+/=\s]+)-----END PUBLIC KEY-----\s*", key_file.read_bytes())
    if not match:
        fail("pinned release key must be PKIX Ed25519 PEM")
    try:
        der = base64.b64decode(re.sub(rb"\s", b"", match[1]), validate=True)
    except ValueError:
        fail("invalid public key encoding")
    if len(der) != 44 or der[:12] != bytes.fromhex("302a300506032b6570032100"):
        fail("pinned release key must be PKIX Ed25519 PEM")
    return der[12:]


def verify_manifest(manifest_file, key_file, args, temporary, runner):
    bounded_file(manifest_file, MAX_MANIFEST)
    raw = manifest_file.read_bytes()
    signed = decode(raw)
    if not isinstance(signed, dict) or set(signed) != {"keyId", "manifest", "signature"}:
        fail("invalid signed manifest envelope")
    m = signed["manifest"]
    if not isinstance(m, dict) or set(m) != set(FIELDS):
        fail("manifest has missing or unknown fields")
    if m["schema"] != SCHEMA or m["version"] != args.tag[1:] or m["commit"] != args.commit or m["os"] != "linux" or m["arch"] != args.arch:
        fail("manifest version, source commit or platform differs from the selected official release")
    for field in ("archiveSha256", "binarySha256"):
        if not isinstance(m[field], str) or not re.fullmatch(r"[0-9a-f]{64}", m[field]):
            fail("invalid digest in manifest")
    if type(m["archiveBytes"]) is not int or not 1 <= m["archiveBytes"] <= MAX_ARCHIVE or type(m["binaryBytes"]) is not int or not 64 <= m["binaryBytes"] <= MAX_BINARY:
        fail("manifest size is outside update limits")
    if type(m["minimumUpdater"]) is not int or not 1 <= m["minimumUpdater"] <= 10000 or not isinstance(m["minimumGlibc"], str) or not re.fullmatch(r"(0|[1-9][0-9]*)(\.(0|[1-9][0-9]*)){1,2}", m["minimumGlibc"]):
        fail("invalid compatibility metadata")
    for field in ("configProfile", "stateProfile"):
        if not isinstance(m[field], str) or not re.fullmatch(r"[!-~]{1,64}", m[field]):
            fail("invalid compatibility profile")
    m = {name: m[name] for name in FIELDS}
    ordered = {"keyId": signed["keyId"], "manifest": m, "signature": signed["signature"]}
    expected = canonical(ordered)
    if raw not in (expected, expected + b"\n"):
        fail("manifest must preserve the exact canonical signed JSON")
    public = key_bytes(key_file)
    if signed["keyId"] != hashlib.sha256(public).hexdigest()[:32]:
        fail("manifest is not signed by the pinned release key")
    if not isinstance(signed["signature"], str) or not re.fullmatch(r"[A-Za-z0-9_-]{86}", signed["signature"]):
        fail("invalid Ed25519 signature encoding")
    signature = base64.urlsafe_b64decode(signed["signature"] + "==")
    if base64.urlsafe_b64encode(signature).rstrip(b"=").decode() != signed["signature"]:
        fail("signature encoding is not canonical")
    message_file, signature_file = temporary / "message", temporary / "signature"
    message_file.write_bytes(SCHEMA.encode() + b"\n" + canonical(m))
    signature_file.write_bytes(signature)
    runner(["openssl", "pkeyutl", "-verify", "-pubin", "-inkey", str(key_file), "-rawin", "-in", str(message_file), "-sigfile", str(signature_file)])
    return m, raw


def inspect_archive(archive, m, destination):
    if bounded_file(archive, MAX_ARCHIVE) != m["archiveBytes"] or digest(archive) != m["archiveSha256"]:
        fail("archive digest or byte count differs from the signed manifest")
    root = f"leviathan_{m['version']}_linux_{m['arch']}"
    expanded = 0
    with tarfile.open(archive, "r|gz") as tar:
        for count, member in enumerate(tar, 1):
            expanded += member.size
            if member.size < 0 or expanded > 2 * MAX_ARCHIVE or count > 100000:
                fail("expanded archive exceeds its limit")
    if shutil.disk_usage(destination).free < expanded + (16 << 20):
        fail("insufficient temporary free space for the verified release")
    seen, expanded, found = set(), 0, False
    # No extract/extractall call: even a verified archive never chooses a path.
    with tarfile.open(archive, "r|gz") as tar:
        for member in tar:
            name = member.name.rstrip("/")
            if name in seen or "\\" in name or PurePosixPath(name).is_absolute() or str(PurePosixPath(name)) != name or ".." in PurePosixPath(name).parts or not (name == root or name.startswith(root + "/")):
                fail("archive contains an unsafe, duplicate or unexpected path")
            seen.add(name)
            expanded += member.size
            if member.size < 0 or expanded > 2 * MAX_ARCHIVE or len(seen) > 100000:
                fail("expanded archive exceeds its limit")
            if member.type not in (tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.DIRTYPE):
                fail("archive links, devices and special entries are forbidden")
            relative = PurePosixPath(name).relative_to(root)
            target = destination.joinpath(*relative.parts)
            if member.isdir():
                target.mkdir(parents=True, mode=0o755, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, mode=0o755, exist_ok=True)
            # Never let tar set owners, special bits, links or destination paths.
            with tar.extractfile(member) as reader, target.open("xb") as writer:
                shutil.copyfileobj(reader, writer)
            target.chmod(0o755 if member.mode & 0o111 else 0o644)
            if name != root + "/leviathan":
                continue
            if not member.isfile() or not member.mode & 0o111 or member.size != m["binaryBytes"]:
                fail("signed Leviathan executable has an unexpected type, mode or size")
            with target.open("rb") as stream:
                header = stream.read(64)
                machine = 62 if m["arch"] == "amd64" else 183
                if len(header) != 64 or header[:6] != b"\x7fELF\x02\x01" or int.from_bytes(header[18:20], "little") != machine:
                    fail("Leviathan ELF architecture differs from the manifest")
                h = hashlib.sha256(header)
                for chunk in iter(lambda: stream.read(1 << 20), b""):
                    h.update(chunk)
            if h.hexdigest() != m["binarySha256"]:
                fail("Leviathan binary digest differs from the signed manifest")
            found = True
    if not found:
        fail("archive lacks the exact signed Leviathan executable")


def verify_provenance(file, args, runner):
    runner([
        "gh", "attestation", "verify", str(file), "--hostname", "github.com", "--repo", REPOSITORY,
        "--signer-workflow", f"github.com/{REPOSITORY}/{WORKFLOW}", "--source-ref", "refs/tags/" + args.tag,
        "--source-digest", args.commit, "--signer-digest", args.commit,
        "--cert-identity", f"https://github.com/{REPOSITORY}/{WORKFLOW}@refs/tags/{args.tag}",
        "--cert-oidc-issuer", "https://token.actions.githubusercontent.com",
        "--predicate-type", "https://slsa.dev/provenance/v1", "--deny-self-hosted-runners",
    ])



def trusted_file(path, maximum, private=False, uid=0, boundary=Path("/")):
    if not path.is_absolute() or ".." in path.parts or any(c.isspace() for c in str(path)):
        fail("local input paths must be absolute without whitespace or traversal")
    bounded_file(path, maximum)
    for item in [path] + list(path.parents):
        info = item.lstat()
        if stat.S_ISLNK(info.st_mode) or info.st_uid != uid or info.st_mode & 0o022:
            fail("local inputs and ancestors must be root-owned and not writable by group or others")
        if item == boundary:
            break
    if private and path.stat().st_mode & 0o077:
        fail("updater configuration and enrollment token require mode 0600 or stricter")


def install(args, runner=run, *, uid=0, boundary=Path("/"), temporary_parent=Path("/run"), architecture=None):
    if not args.with_updater or not re.fullmatch("v?" + STABLE, args.version) or not re.fullmatch(r"[0-9a-f]{40}", args.commit):
        fail("--with-updater requires an exact stable --version and full lowercase --commit; latest is not accepted")
    if args.install_dir and args.install_dir != "/usr/local/bin":
        fail("--with-updater uses /usr/local/bin; a different --install-dir is not supported")
    args.tag = "v" + args.version.removeprefix("v")
    machine = architecture or platform.machine()
    args.arch = {"x86_64": "amd64", "amd64": "amd64", "aarch64": "arm64", "arm64": "arm64"}.get(machine)
    if not args.arch:
        fail("managed installation supports Linux AMD64 and ARM64 only")
    if not args.yggdrasil_cidr:
        fail("at least one explicit --yggdrasil-cidr is required")
    config_file, token_file, key_file = map(Path, (args.updater_config, args.token_file, args.release_public_key))
    for path, maximum, private in ((config_file, 65536, True), (token_file, 512, True), (key_file, 4096, False)):
        trusted_file(path, maximum, private, uid, boundary)
    key_bytes(key_file)
    config = decode(config_file.read_bytes())
    if not isinstance(config, dict) or str(key_file) not in config.get("trustedReleaseKeyFiles", []):
        fail("the independently pinned release public key must also be registered in trustedReleaseKeyFiles")
    token = token_file.read_bytes().strip()
    if not token.startswith(b"yenr1_") or len(token) > 256:
        fail("a one-time updater enrollment token file is required")
    release = decode(runner(["gh", "release", "view", args.tag, "--repo", REPOSITORY, "--json", "tagName,isDraft,isPrerelease"]))
    if not isinstance(release, dict) or release.get("tagName") != args.tag or release.get("isDraft") is not False or release.get("isPrerelease") is not False:
        fail("GitHub release must be published, stable and match the selected tag")
    # /run is root-owned and not a shared writable /tmp ancestor. All transient
    # download and dry-run files disappear when this invocation returns.
    with tempfile.TemporaryDirectory(prefix="leviathan-install-", dir=temporary_parent) as temp:
        temporary = Path(temp)
        archive = temporary / f"leviathan_linux_{args.arch}.tar.gz"
        manifest_file = temporary / f"leviathan_linux_{args.arch}.manifest.json"
        pinned_key = temporary / "release-public.pem"
        stage_local(key_file, pinned_key, 4096)
        runner(["gh", "release", "download", args.tag, "--repo", REPOSITORY, "--pattern", archive.name, "--pattern", manifest_file.name, "--dir", str(temporary)])
        bounded_file(archive, MAX_ARCHIVE)
        bounded_file(manifest_file, MAX_MANIFEST)
        verify_provenance(archive, args, runner)
        verify_provenance(manifest_file, args, runner)
        m, _ = verify_manifest(manifest_file, pinned_key, args, temporary, runner)
        if m["minimumUpdater"] > 1 or m["configProfile"] != "leviathan-config-v1" or m["stateProfile"] != "leviathan-state-v1":
            fail("release requires a different updater or configuration/state compatibility profile")
        glibc = runner(["getconf", "GNU_LIBC_VERSION"]).decode().strip()
        if not re.fullmatch(r"glibc [0-9]+(\.[0-9]+){1,2}", glibc):
            fail("a supported glibc installation is required")
        version = lambda value: tuple(int(x) for x in value.split(".")) + (0,) * (3 - len(value.split(".")))
        if version(glibc[6:]) < version(m["minimumGlibc"]):
            fail("host glibc is older than the signed release requires")
        package = temporary / "package"
        package.mkdir(mode=0o700)
        inspect_archive(archive, m, package)
        for name in ("leviathan-updater", "scripts/bootstrap-updater.py", "contrib/systemd/leviathan@.service", "contrib/systemd/leviathan-updater.service", "contrib/systemd/leviathan-updater-recover.service"):
            bounded_file(package / name, MAX_BINARY)
        if not (package / "leviathan-updater").stat().st_mode & 0o111:
            fail("verified package lacks an executable updater")
        command = [sys.executable, "-I", str(package / "scripts/bootstrap-updater.py"),
                   "--config", str(config_file), "--updater-binary", str(package / "leviathan-updater"),
                   "--agent-binary", str(package / "leviathan"), "--release-commit", args.commit,
                   "--token-file", str(token_file), "--enable-managed-updates"]
        for cidr in args.yggdrasil_cidr:
            command.extend(["--yggdrasil-cidr", cidr])
        if args.allow_preview:
            command.append("--allow-preview")
        if args.dry_run:
            command.append("--dry-run")
        # The helper is part of the archive bound by the independent signature
        # and official workflow attestation. No downloaded code ran before here.
        output = runner(command).decode().strip()
        return output or "Verified managed installation completed."


def parser():
    p = argparse.ArgumentParser(description="Install Leviathan and its separately enrolled updater")
    p.add_argument("--with-updater", action="store_true", required=True)
    p.add_argument("--version", default=os.environ.get("LEVIATHAN_VERSION", "latest"))
    p.add_argument("--commit", required=True, help="reviewed full source commit of the stable release")
    p.add_argument("--install-dir", default=os.environ.get("LEVIATHAN_INSTALL_DIR", ""))
    p.add_argument("--updater-config", required=True, help="root-owned updater JSON with the exact host identity")
    p.add_argument("--token-file", required=True, help="private one-time updater enrollment token file")
    p.add_argument("--release-public-key", required=True, help="independently pinned PKIX Ed25519 public key")
    p.add_argument("--yggdrasil-cidr", action="append", default=[])
    p.add_argument("--allow-preview", action="store_true", help="adopt an existing preview without replacing it")
    p.add_argument("--dry-run", action="store_true", help="verify release and host inputs without installation or enrollment")
    return p


def main():
    try:
        args = parser().parse_args()
        if os.geteuid() != 0 or sys.platform != "linux":
            fail("run --with-updater as root on the intended Linux host; the installer never invokes sudo")
        if sys.version_info < (3, 11):
            fail("Python 3.11 or newer is required")
        for command in ("gh", "openssl", "systemctl", "getconf", "id", "env"):
            if not shutil.which(command):
                fail("required command not found: " + command)
        print(install(args))
    except InstallError as error:
        print("Leviathan managed installation: " + str(error), file=sys.stderr)
        return 1
    except (OSError, ValueError, TypeError, tarfile.TarError):
        # No token, credential-bearing command output, or raw configuration.
        print("Leviathan managed installation failed; verify dependencies, stable release provenance, pinned key and local inputs. No unverified package is installed.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
