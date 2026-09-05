#!/usr/bin/env python3
"""Explicit, one-time installation of the independent root host updater."""

import argparse
import base64
from contextlib import contextmanager
import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import shlex
import socket
import stat
import subprocess
import sys
import tempfile
import time
import urllib.request
from urllib.parse import urlsplit


class BootstrapError(Exception):
    pass


def fail(message):
    raise BootstrapError(message)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            fail("configuration contains a duplicate JSON member")
        result[key] = value
    return result


class Host:
    """Tests inject an isolated filesystem and command runner; CLI cannot."""

    def __init__(self, root=Path("/"), source_root=None, runner=None, uid=0, resolver=None, health=None):
        self.root = Path(root)
        self.source_root = source_root or Path(__file__).resolve().parent.parent
        self.runner = runner or self._run
        self.uid = uid
        self.resolver = resolver or socket.getaddrinfo
        self.health = health or self.verify_running

    def path(self, value):
        p = Path(value)
        if not p.is_absolute() or ".." in p.parts or not re.fullmatch(r"/[A-Za-z0-9_./@-]+", str(p)):
            fail("configuration and installation paths must be absolute, literal systemd-safe paths without traversal")
        return self.root / str(p).lstrip("/")

    def safe_path(self, path, *, file=False, private=False, missing=False):
        p = Path(path)
        stop = self.root if p.is_relative_to(self.root) else Path("/")
        chain = [p] + list(p.parents)
        for item in chain:
            if item == stop:
                break
            try:
                info = item.lstat()
            except FileNotFoundError:
                if missing:
                    continue
                fail(f"required path is absent: {item}")
            if stat.S_ISLNK(info.st_mode) or info.st_uid != self.uid or info.st_mode & 0o022:
                fail(f"path must be root-owned, non-symlink and not writable by group or others: {item}")
            if item == p and file and not stat.S_ISREG(info.st_mode):
                fail(f"regular file required: {item}")
            if (item != p or not file) and not stat.S_ISDIR(info.st_mode):
                fail(f"directory required: {item}")
            if item == p and private and info.st_mode & 0o077:
                fail(f"private file must have mode 0600 or stricter: {item}")

    @staticmethod
    def _run(command):
        result = subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
        if result.returncode:
            # Never echo enrollment credentials or untrusted process output.
            fail(f"command failed: {Path(command[0]).name} {command[-1] if command[0] == 'systemctl' else 'operation'}")
        return result.stdout

    def install(self, destination, data, mode):
        target = self.path(destination)
        self.safe_path(target, file=True, missing=True)
        if target.exists():
            if target.read_bytes() != data or stat.S_IMODE(target.stat().st_mode) != mode:
                fail(f"refusing a conflicting installation file: {destination}")
            return
        target.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix="." + target.name + ".", dir=target.parent)
        try:
            with os.fdopen(fd, "wb") as stream:
                os.fchmod(stream.fileno(), mode)
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            try:
                # Publish without replacing a file that appeared after preflight.
                os.link(temporary, target)
            except FileExistsError:
                self.safe_path(target, file=True)
                if target.read_bytes() != data or stat.S_IMODE(target.stat().st_mode) != mode:
                    fail(f"refusing a conflicting installation file: {destination}")
            self.sync_directory(target.parent)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    @contextmanager
    def bootstrap_lock(self):
        directory = self.path("/run")
        self.safe_path(directory, missing=True)
        directory.mkdir(mode=0o755, exist_ok=True)
        path = directory / "leviathan-bootstrap.lock"
        fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != self.uid or info.st_mode & 0o077:
                fail("bootstrap lock must be a root-owned private regular file")
            # Separate from the updater's transaction lock: enroll/adopt acquire
            # that lock internally. Holding this spans preflight and ALL writes.
            fcntl.flock(fd, fcntl.LOCK_EX)
            yield
        finally:
            os.close(fd)

    def replace_private(self, destination, data):
        target = self.path(destination)
        fd, temporary = tempfile.mkstemp(prefix="." + target.name, dir=target.parent)
        try:
            with os.fdopen(fd, "wb") as stream:
                os.fchmod(stream.fileno(), 0o600)
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, target)
            self.sync_directory(target.parent)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def verify_running(self, config, metadata, binary_sha):
        # First-install startup validation. Normal update transactions separately
        # require their full 60-second health window in the updater engine.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        deadline, previous = time.monotonic() + 30, None
        while time.monotonic() < deadline:
            try:
                pid = self.runner(["systemctl", "show", config["service"], "--property=MainPID", "--value"]).strip()
                if not re.fullmatch(r"[1-9][0-9]*", pid):
                    raise ValueError()
                with self.path("/proc/" + pid + "/exe").open("rb") as stream:
                    if hashlib.file_digest(stream, "sha256").hexdigest() != binary_sha:
                        raise ValueError()
                responses = []
                for suffix in ("/api/v1/version", "/healthz"):
                    with opener.open(config["apiURL"] + suffix, timeout=2) as response:
                        if response.status != 200 or response.url != config["apiURL"] + suffix:
                            raise ValueError()
                        responses.append(json.loads(response.read(65537)))
                build, health = responses
                if build.get("version") != metadata["version"] or build.get("commit") != metadata["commit"]:
                    raise ValueError()
                domains = health.get("domains", {})
                sampled = health.get("sampledAt")
                if health.get("status") not in ("ok", "degraded") or not isinstance(sampled, str) or not (domains.get("system", {}).get("available") or domains.get("gpu", {}).get("available")):
                    raise ValueError()
                if previous is not None and sampled > previous:
                    return
                previous = sampled
            except (BootstrapError, OSError, ValueError, TypeError, AttributeError):
                previous = None
            time.sleep(1)
        fail("new monitor did not produce the exact requested running build and advancing telemetry within 30 seconds")

    @staticmethod
    def sync_directory(directory):
        fd = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def public_key(path):
    if path.stat().st_size > 16384:
        fail("release public key exceeds its limit")
    raw = path.read_bytes()
    match = re.fullmatch(rb"\s*-----BEGIN PUBLIC KEY-----\s+([A-Za-z0-9+/=\s]+)-----END PUBLIC KEY-----\s*", raw)
    if not match:
        fail("release public key must be PKIX Ed25519 PEM")
    try:
        der = base64.b64decode(re.sub(rb"\s", b"", match[1]), validate=True)
    except ValueError:
        fail("invalid release public key encoding")
    if len(der) != 44 or der[:12] != bytes.fromhex("302a300506032b6570032100"):
        fail("release public key must be PKIX Ed25519 PEM")
    return der[12:]


def literal_environment(path):
    if path.stat().st_size > 256 << 10:
        fail("agent environment file exceeds its limit")
    values = []
    for line in path.read_bytes().decode("utf-8").split("\n"):
        line = line.strip()
        if not line or line.startswith(("#", ";")):
            continue
        name, equal, value = line.partition("=")
        if not equal or not re.fullmatch(r"LEVIATHAN_[A-Z0-9_]+", name):
            fail("agent environment must contain only literal LEVIATHAN_ assignments")
        value = value.strip()
        if any(char in value for char in ("\\", "\r", "\x00")):
            fail("agent environment contains unsupported escaping")
        if value.startswith(('"', "'")):
            if len(value) < 2 or value[-1] != value[0] or value[0] in value[1:-1]:
                fail("agent environment contains unsupported quoting")
            value = value[1:-1]
        elif '"' in value or "'" in value:
            fail("agent environment contains unsupported quoting")
        values.append((name, value))
    return values


def sandbox_readable(path):
    value = Path(path)
    if any(value == parent or value.is_relative_to(parent) for parent in (Path("/root"), Path("/home"), Path("/run/user"))):
        fail("registered runtime files must be outside home directories hidden by the updater sandbox; use root-owned /etc paths")


def fresh_service(config, listen, host):
    template = host.source_root / "contrib/systemd/leviathan@.service"
    host.safe_path(template, file=True)
    body = template.read_text()
    expected = "ExecStart=/usr/local/bin/leviathan --listen 127.0.0.1:1397 serve"
    if body.count(expected) != 1 or body.count("User=%i") != 1 or body.count("EnvironmentFile=-/etc/leviathan/leviathan.env") != 1:
        fail("packaged service template has an unexpected command or environment")
    user = config["service"][len("leviathan@"):-len(".service")]
    user_id = host.runner(["id", "-u", user]).strip()
    if not re.fullmatch(r"[0-9]+", user_id):
        fail("the named service Unix user must already exist")
    if user_id != "0":
        groups = host.runner(["id", "-G", user]).split()
        if not groups or any(not value.isdigit() for value in groups):
            fail("cannot resolve the named service user's groups")
        groups = {int(value) for value in groups}
        source = host.path(config["agentConfigFile"])
        for item in [source] + list(source.parents):
            if item == host.root:
                break
            info = item.stat()
            shift = 6 if info.st_uid == int(user_id) else 3 if info.st_gid in groups else 0
            required = 4 if item == source else 1
            if not ((info.st_mode >> shift) & required):
                fail("the named service user must be able to read its registered TOML and traverse its directories")
    body = body.replace("User=%i", "User=" + user).replace("for %i", "for " + user)
    body = body.replace(expected, "ExecStart=/usr/local/bin/leviathan --config " + config["agentConfigFile"] + " --listen " + listen + " serve")
    env = "EnvironmentFile=" + config["agentEnvironmentFile"] if config["agentEnvironmentFile"] else ""
    return body.replace("EnvironmentFile=-/etc/leviathan/leviathan.env", env).encode()


def fresh_hardening(config, cidrs, host):
    if config["service"] != "leviathan@root.service":
        return {}
    template = host.source_root / "contrib/systemd/leviathan@root.service.d/10-hardening.conf"
    host.safe_path(template, file=True)
    # Root-mode monitor retains the packaged limited capability set and
    # deny-all networking. The operator's explicit Yggdrasil ranges also permit
    # configured Uplink traffic; no other destination is granted by bootstrap.
    body = template.read_bytes() + b"\n" + "".join(f"IPAddressAllow={cidr}\n" for cidr in cidrs).encode()
    return {"/etc/systemd/system/leviathan@root.service.d/10-hardening.conf": (body, 0o644)}


def inspect_fresh_layout(config, host, files, pending):
    service = config["service"]
    for directory in ("/etc/systemd/system", "/run/systemd/system", "/usr/lib/systemd/system", "/lib/systemd/system"):
        for name in (service, "leviathan@.service", service + ".d", "leviathan@.service.d"):
            path = host.path(directory + "/" + name)
            if not path.exists() and not path.is_symlink():
                continue
            if not pending:
                fail("fresh installation refuses existing service files and drop-ins; use active-service adoption")
            if path.is_symlink():
                fail("fresh installation cannot resume through a service symlink")
            entries = list(path.iterdir()) if path.is_dir() else [path]
            for entry in entries:
                destination = "/" + str(entry.relative_to(host.root))
                if destination not in files:
                    fail("fresh installation refuses an unregistered service file or drop-in")
                host.safe_path(entry, file=True)
                if entry.read_bytes() != files[destination][0]:
                    fail("fresh installation refuses a changed service file or drop-in")


def pending_fresh(args, host, raw, metadata, source, unit):
    # An immutable intent identifies precisely which otherwise-absent service
    # this invocation may create or resume after a process/host interruption.
    intent = {"schema": "leviathan-bootstrap-v1", "mode": "fresh", "configSha256": hashlib.sha256(raw).hexdigest(),
              "binarySha256": hashlib.sha256(source.read_bytes()).hexdigest(), "unitSha256": hashlib.sha256(unit).hexdigest(),
              "version": metadata["version"], "commit": metadata["commit"]}
    path = host.path("/var/lib/leviathan-updater/bootstrap.json")
    host.safe_path(path, file=True, private=True, missing=True)
    if path.exists():
        if path.stat().st_size > 65536:
            fail("invalid bootstrap recovery record")
        try:
            previous = json.loads(path.read_bytes(), object_pairs_hook=unique_object)
        except (ValueError, TypeError):
            fail("invalid bootstrap recovery record")
        if not isinstance(previous, dict) or set(previous) != {"intent", "complete"} or previous.get("intent") != intent or type(previous.get("complete")) is not bool:
            fail("fresh bootstrap inputs differ from the retained recovery record")
        return intent, previous["complete"]
    return intent, None


def prepare(args, host):
    fresh, metadata, intent, unit, baseline, fresh_pending = False, None, None, None, None, False
    source = host.path(args.config)
    binary = host.path(args.updater_binary)
    token = host.path(args.token_file)
    for p in (source, binary, token):
        host.safe_path(p, file=True, private=p in (source, token))
    if not binary.stat().st_mode & 0o111:
        fail("updater binary must be executable")
    updater_version = host.runner([str(binary), "version"]).strip()
    if not re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", updater_version):
        fail("bootstrap updater must be an executable stable release build")
    if not 1 <= token.stat().st_size <= 512:
        fail("enrollment token file is empty or too large")
    raw_token = token.read_bytes().strip()
    if not raw_token.startswith(b"yenr1_") or len(raw_token) > 256:
        fail("file does not contain a recognized one-time updater enrollment token")
    if source.stat().st_size > 65536:
        fail("configuration is too large")
    raw = source.read_bytes()
    try:
        config = json.loads(raw, object_pairs_hook=unique_object)
    except (ValueError, TypeError):
        fail("invalid updater configuration JSON")
    fields = {"schema", "controlPlaneURL", "machine", "rootDirectory", "stateDirectory", "service", "apiURL", "agentConfigFile", "agentEnvironmentFile", "trustedReleaseKeyFiles"}
    if not isinstance(config, dict) or set(config) != fields:
        fail("updater configuration has missing or unknown fields")
    if config["schema"] != "leviathan-updater-config-v1" or config["rootDirectory"] != "/opt/leviathan" or config["stateDirectory"] != "/var/lib/leviathan-updater":
        fail("bootstrap requires the packaged schema and fixed /opt and /var/lib directories")
    service = config["service"]
    if not isinstance(service, str) or not re.fullmatch(r"leviathan@[A-Za-z0-9_][A-Za-z0-9_-]{0,63}\.service", service):
        fail("exactly one explicit leviathan@<user>.service is required")
    machine = config["machine"]
    if not isinstance(machine, dict) or set(machine) != {"platformId", "scopeId", "machineId"} or any(not isinstance(v, str) or not v or any(ord(c) <= 32 or ord(c) == 127 for c in v) for v in machine.values()):
        fail("a complete, explicit machine identity is required")
    if not re.fullmatch(r"[a-z][a-z0-9_-]{0,63}", machine["platformId"]) or len(machine["scopeId"].encode()) > 256 or len(machine["machineId"].encode()) > 512:
        fail("machine identity exceeds the update contract limits")
    origin = urlsplit(config["controlPlaneURL"])
    if origin.scheme != "https" or not origin.hostname or origin.username or origin.password or origin.path or origin.query or origin.fragment or "?" in config["controlPlaneURL"] or "#" in config["controlPlaneURL"]:
        fail("controlPlaneURL must be a single HTTPS origin")
    api = urlsplit(config["apiURL"])
    try:
        loopback = ipaddress.ip_address(api.hostname).is_loopback
        port = api.port or 80
    except (ValueError, TypeError):
        fail("apiURL must use an explicit loopback IP")
    if api.scheme != "http" or not loopback or api.username or api.password or api.path or api.query or api.fragment or "?" in config["apiURL"] or "#" in config["apiURL"]:
        fail("apiURL must be the existing loopback HTTP origin")
    cidrs = []
    for value in args.yggdrasil_cidr:
        try:
            network = ipaddress.ip_network(value, strict=True)
        except ValueError:
            fail("Yggdrasil allowlist entries must be exact IP CIDRs")
        if network.prefixlen == 0 or network.is_multicast or network.is_unspecified:
            fail("allow-all, multicast and unspecified network ranges are forbidden")
        if str(network) not in cidrs:
            cidrs.append(str(network))
    if not cidrs:
        fail("at least one explicit Yggdrasil network range is required")
    for family in (4, 6):
        networks = [ipaddress.ip_network(value) for value in cidrs if ipaddress.ip_network(value).version == family]
        if any(network.prefixlen == 0 for network in ipaddress.collapse_addresses(networks)):
            fail("the combined network ranges permit all addresses")
    addresses = {ipaddress.ip_address(item[4][0]) for item in host.resolver(origin.hostname, origin.port or 443, type=socket.SOCK_STREAM)}
    if not addresses or any(not any(address in ipaddress.ip_network(cidr) for cidr in cidrs) for address in addresses):
        fail("every current Yggdrasil origin address must be inside the supplied network allowlist")
    keys = config["trustedReleaseKeyFiles"]
    if not isinstance(keys, list) or not keys or len(keys) > 8 or any(not isinstance(key, str) for key in keys):
        fail("explicit pinned release public key files are required")
    public_keys = set()
    for key in keys:
        sandbox_readable(key)
        key_path = host.path(key)
        host.safe_path(key_path, file=True)
        key_value = public_key(key_path)
        if key_value in public_keys:
            fail("duplicate pinned release public key")
        public_keys.add(key_value)
    for field in ("agentConfigFile", "agentEnvironmentFile"):
        if not isinstance(config[field], str):
            fail("agent file paths must be strings")
        if config[field]:
            sandbox_readable(config[field])
            host.safe_path(host.path(config[field]), file=True)
            if host.path(config[field]).stat().st_size > 256 << 10:
                fail("agent configuration source exceeds its limit")
    if not config["agentConfigFile"]:
        fail("managed adoption requires an explicit root-owned agentConfigFile; HOME/XDG defaults are not a registered configuration")
    environment_values = literal_environment(host.path(config["agentEnvironmentFile"])) if config["agentEnvironmentFile"] else []
    environment_config = ""
    for name, value in environment_values:
        if name == "LEVIATHAN_CONFIG":
            if value != config["agentConfigFile"]:
                fail("literal LEVIATHAN_CONFIG does not match the updater registry")
            environment_config = value
    listen = f"[{api.hostname}]:{port}" if ":" in api.hostname else f"{api.hostname}:{port}"
    target = host.path("/usr/local/bin/leviathan")
    managed = target.is_symlink() and os.readlink(target) == "/opt/leviathan/current/leviathan"
    if args.agent_binary:
        baseline = host.path(args.agent_binary)
        host.safe_path(baseline, file=True)
        if not baseline.stat().st_mode & 0o111:
            fail("verified release Leviathan binary must be executable")
        try:
            metadata = json.loads(host.runner([str(baseline), "version", "--format", "json"]), object_pairs_hook=unique_object)
        except (ValueError, TypeError):
            fail("cannot read the release Leviathan build")
        if not isinstance(metadata, dict) or metadata.get("version") != updater_version or not re.fullmatch(r"[0-9a-f]{40}", args.release_commit or "") or metadata.get("commit") != args.release_commit:
            fail("the release agent and updater must match the exact reviewed stable build")
        check = ["env", "-i", "PATH=/usr/bin:/bin", "HOME=/nonexistent", "XDG_CONFIG_HOME=/nonexistent"]
        check += [name + "=" + value for name, value in environment_values]
        check += [str(baseline), "--config", str(host.path(config["agentConfigFile"])), "config-check"]
        try:
            result = json.loads(host.runner(check), object_pairs_hook=unique_object)
        except (ValueError, TypeError):
            fail("release configuration validation failed")
        if result != {"valid": True, "configProfile": "leviathan-config-v1", "stateProfile": "leviathan-state-v1"}:
            fail("release configuration/state compatibility check failed")
        # A first install has no existing binary or systemd service. A retained
        # incomplete intent additionally permits safe resumption of OUR unit.
        marker = host.path("/var/lib/leviathan-updater/bootstrap.json")
        if (not target.exists() and not target.is_symlink()) or marker.exists():
            unit = fresh_service(config, listen, host)
            intent, complete = pending_fresh(args, host, raw, metadata, baseline, unit)
            fresh = complete is not True
            fresh_pending = complete is not None
            if fresh:
                properties = host.runner(["systemctl", "show", service, "--property=LoadState,FragmentPath,ActiveState,User"])
                props = dict(line.split("=", 1) for line in properties.splitlines() if "=" in line)
                unit_path = "/etc/systemd/system/" + service
                if complete is None:
                    if props.get("LoadState") != "not-found" or props.get("FragmentPath") or props.get("ActiveState") not in ("inactive", "failed"):
                        fail("fresh installation requires an absent service and absent /usr/local/bin/leviathan")
                elif props.get("FragmentPath") and props.get("FragmentPath") != unit_path:
                    fail("the resumed service no longer uses the bootstrap-owned unit")
                if target.exists() or target.is_symlink():
                    if not managed:
                        fail("fresh installation refuses a replacement unmanaged binary")
                    if target.lstat().st_uid != host.uid:
                        fail("managed executable symlink must be root-owned")
                p = host.path(unit_path)
                host.safe_path(p, file=True, missing=True)
                if p.exists() and p.read_bytes() != unit:
                    fail("refusing to replace a changed fresh-install service")
    if not fresh:
        properties = host.runner(["systemctl", "show", service, "--property=User,ExecStart,FragmentPath,ActiveState,EnvironmentFiles,Environment,PassEnvironment,UnsetEnvironment"])
        props = dict(line.split("=", 1) for line in properties.splitlines() if "=" in line)
        if props.get("User") != service[len("leviathan@"):-len(".service")] or props.get("ActiveState") != "active" or not props.get("FragmentPath"):
            fail("the configured service must be installed, active and use its named Unix user")
        match = re.search(r"argv\[\]=(.*?) ;", props.get("ExecStart", ""))
        argv = shlex.split(match[1]) if match else []
        listen = f"[{api.hostname}]:{port}" if ":" in api.hostname else f"{api.hostname}:{port}"
        if not argv or argv[0] != "/usr/local/bin/leviathan" or "serve" not in argv:
            fail("the monitored service must execute /usr/local/bin/leviathan serve directly")
        options, position, serve = {}, 1, 0
        while position < len(argv):
            item = argv[position]
            if item == "serve":
                serve += 1
                position += 1
                continue
            name, equal, value = item.partition("=")
            if name not in ("--listen", "--config") or name in options:
                fail("service has unmodeled or duplicate command-line options")
            if not equal:
                position += 1
                if position >= len(argv):
                    fail("service command-line option lacks a value")
                value = argv[position]
            options[name] = value
            position += 1
        if serve != 1 or options.get("--listen") != listen or options.get("--config", environment_config) != config["agentConfigFile"]:
            fail("service listen/config arguments do not match the updater registry")
        environment_files = props.get("EnvironmentFiles", "").strip()
        wanted_environment = config["agentEnvironmentFile"]
        if (not wanted_environment and environment_files) or (wanted_environment and not re.fullmatch(re.escape(wanted_environment) + r" \(ignore_errors=(yes|no)\)", environment_files)):
            fail("service environment file does not match the updater registry")
        if any(props.get(name, "").strip() for name in ("Environment", "PassEnvironment", "UnsetEnvironment")):
            fail("service contains unmodeled environment overrides")
        if managed and target.lstat().st_uid != host.uid:
            fail("managed executable symlink must be root-owned")
        if not managed:
            host.safe_path(target, file=True)
            if not target.stat().st_mode & 0o111:
                fail("existing Leviathan binary must be executable")
            try:
                metadata = json.loads(host.runner([str(target), "version", "--format", "json"]), object_pairs_hook=unique_object)
                installed_version = metadata["version"]
            except (ValueError, KeyError, TypeError):
                fail("cannot read the exact installed Leviathan version")
            stable = r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"
            if not isinstance(installed_version, str) or not re.fullmatch(stable + r"(-[0-9A-Za-z.-]+)?", installed_version):
                fail("unknown or development builds cannot be silently adopted")
            if "-" in installed_version and not args.allow_preview:
                fail("preview adoption requires explicit --allow-preview")
    temporary_link = host.path("/usr/local/bin/.leviathan-managed-bootstrap")
    if temporary_link.exists() or temporary_link.is_symlink():
        if not temporary_link.is_symlink() or os.readlink(temporary_link) != "/opt/leviathan/current/leviathan" or temporary_link.lstat().st_uid != host.uid:
            fail("unexpected object at the bootstrap temporary symlink; inspect it before retrying")
    files = {
        "/etc/leviathan-updater/config.json": (raw, 0o600),
        "/usr/local/bin/leviathan-updater": (binary.read_bytes(), 0o755),
        "/etc/systemd/system/leviathan-updater.service.d/10-network.conf": (("[Service]\n" + "".join(f"IPAddressAllow={cidr}\n" for cidr in cidrs)).encode(), 0o644),
        f"/etc/systemd/system/{service}.d/30-updater-recovery.conf": (b"[Unit]\nRequires=leviathan-updater-recover.service\nAfter=leviathan-updater-recover.service\n", 0o644),
    }
    for name in ("leviathan-updater.service", "leviathan-updater-recover.service"):
        template = host.source_root / "contrib/systemd" / name
        host.safe_path(template, file=True)
        files[f"/etc/systemd/system/{name}"] = (template.read_bytes(), 0o644)
    if fresh:
        files["/etc/systemd/system/" + service] = (unit, 0o644)
        files.update(fresh_hardening(config, cidrs, host))
        inspect_fresh_layout(config, host, files, fresh_pending)
    for dest, (data, _) in files.items():
        p = host.path(dest)
        host.safe_path(p, file=True, missing=True)
        if p.exists() and p.read_bytes() != data:
            fail(f"refusing to overwrite existing bootstrap configuration or binary: {dest}")
    for directory in ("/opt/leviathan", "/var/lib/leviathan-updater"):
        host.safe_path(host.path(directory), missing=True)
    return config, files, managed, fresh, intent, metadata, baseline


def bootstrap(args, host):
    if args.dry_run:
        return apply_bootstrap(args, host)
    with host.bootstrap_lock():
        return apply_bootstrap(args, host)


def apply_bootstrap(args, host):
    config, files, managed, fresh, intent, metadata, baseline = prepare(args, host)
    if not args.enable_managed_updates:
        fail("explicit --enable-managed-updates is required; use --dry-run to review first")
    if args.dry_run:
        mode = "fresh installation" if fresh else "adoption of the current installation"
        return "Validated " + mode + "; no files, enrollment or services changed."
    for directory, mode in (("/opt/leviathan", 0o755), ("/var/lib/leviathan-updater", 0o700)):
        path = host.path(directory)
        path.mkdir(parents=True, mode=mode, exist_ok=True)
        path.chmod(mode)
    for directory in ("/usr/local/bin", "/etc/systemd/system"):
        host.safe_path(host.path(directory), missing=True)
        host.path(directory).mkdir(parents=True, mode=0o755, exist_ok=True)
    if fresh:
        host.install("/var/lib/leviathan-updater/bootstrap.json", json.dumps({"intent": intent, "complete": False}, sort_keys=True).encode(), 0o600)
    # Identical reruns preserve updater identity and registration. Conflicting
    # binaries, configuration, or unit contents fail during preflight.
    for destination in ("/etc/leviathan-updater/config.json", "/usr/local/bin/leviathan-updater"):
        host.install(destination, *files[destination])
    command = [str(host.path("/usr/local/bin/leviathan-updater")), "--config", str(host.path("/etc/leviathan-updater/config.json"))]
    if managed:
        host.runner(command + ["status"])
    try:
        host.runner(command + ["enroll", "--token-file", str(host.path(args.token_file))])
    except BootstrapError:
        fail("enrollment failed; the existing executable and service were preserved. Rerun with the same configuration to reuse the updater identity")
    if not managed:
        adoption = command + ["adopt", "--binary", str(baseline if fresh else host.path("/usr/local/bin/leviathan"))]
        if args.allow_preview:
            adoption.append("--allow-preview")
        host.runner(adoption)
        target = host.path("/usr/local/bin/leviathan")
        temporary = target.with_name(".leviathan-managed-bootstrap")
        if temporary.is_symlink():
            temporary.unlink()
        os.symlink("/opt/leviathan/current/leviathan", temporary)
        try:
            os.replace(temporary, target)
            host.sync_directory(target.parent)
        finally:
            if temporary.is_symlink():
                temporary.unlink()
    for destination, (data, mode) in files.items():
        host.install(destination, data, mode)
    host.runner(["systemctl", "daemon-reload"])
    if fresh:
        try:
            host.runner(["systemctl", "enable", "--now", config["service"]])
            host.runner(["systemctl", "is-active", config["service"]])
            host.health(config, metadata, intent["binarySha256"])
        except (BootstrapError, OSError, ValueError):
            # Only a unit created by this exact recorded first-install intent
            # may be stopped. Existing active services never enter this branch.
            try:
                host.runner(["systemctl", "stop", config["service"]])
            except BootstrapError:
                pass
            fail("new Leviathan service failed startup; installation is incomplete. Its baseline and enrollment identity were retained; inspect the service and rerun identical inputs")
    if fresh:
        # Publish completion before the autonomous updater can install a newer
        # approved release. An interrupted retry must never health-check the
        # original baseline and stop a subsequently updated monitor.
        host.replace_private("/var/lib/leviathan-updater/bootstrap.json", json.dumps({"intent": intent, "complete": True}, sort_keys=True).encode())
    host.runner(["systemctl", "enable", "--now", "leviathan-updater.service"])
    host.runner(["systemctl", "is-active", "leviathan-updater.service"])
    if fresh:
        return f"Installed {config['service']} and enrolled its updater; exact running build and advancing telemetry verified."
    return f"Managed updates enabled for {config['service']}; the running monitor and its security settings were preserved."


def parser():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--config", required=True, help="prepared root-owned updater JSON")
    p.add_argument("--updater-binary", required=True, help="verified, root-owned release updater binary")
    p.add_argument("--agent-binary", help="verified release agent; permits first installation when no service or binary exists")
    p.add_argument("--release-commit", help="exact verified 40-character source commit, required with --agent-binary")
    p.add_argument("--token-file", required=True, help="private one-time updater enrollment token")
    p.add_argument("--yggdrasil-cidr", action="append", default=[], help="explicit origin IP CIDR; repeat for each range")
    p.add_argument("--enable-managed-updates", action="store_true", help="explicitly adopt the existing installation and enable updates")
    p.add_argument("--allow-preview", action="store_true", help="explicitly adopt the installed preview; older stable releases remain ineligible")
    p.add_argument("--dry-run", action="store_true", help="validate without copying files or changing services")
    return p


def main():
    try:
        if os.geteuid() != 0 or sys.platform != "linux":
            fail("run this bootstrap as root on the intended Linux host")
        print(bootstrap(parser().parse_args(), Host()))
    except (BootstrapError, OSError, ValueError, TypeError) as error:
        print(f"leviathan updater bootstrap: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
