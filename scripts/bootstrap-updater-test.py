#!/usr/bin/env python3
"""Isolated bootstrap tests: never execute systemctl or a real updater."""

import base64
from concurrent.futures import ThreadPoolExecutor, TimeoutError
import copy
import importlib.util
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import threading
import unittest

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("bootstrap", Path(__file__).with_name("bootstrap-updater.py"))
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)


class BootstrapTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.calls = []
        self.fail_enroll = False
        self.version = "0.4.0"
        self.updater_version = "0.4.0"
        self.environment_files = "/etc/leviathan/leviathan.env (ignore_errors=yes)"
        self.environment = ""
        self.extra_args = ""
        self.config_args = "--config /etc/leviathan/config.toml"
        self.host = bootstrap.Host(self.root, self.root / "root/package", self.run_command, os.getuid(), lambda *a, **kw: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("203.0.113.10", 443))])
        self.config = {
            "schema": "leviathan-updater-config-v1", "controlPlaneURL": "https://yggdrasil.example.com",
            "machine": {"platformId": "kubernetes", "scopeId": "cluster", "machineId": "host"},
            "rootDirectory": "/opt/leviathan", "stateDirectory": "/var/lib/leviathan-updater",
            "service": "leviathan@root.service", "apiURL": "http://127.0.0.1:1397",
            "agentConfigFile": "/etc/leviathan/config.toml", "agentEnvironmentFile": "/etc/leviathan/leviathan.env",
            "trustedReleaseKeyFiles": ["/etc/leviathan-updater/release-public.pem"],
        }
        self.write("/root/config.json", json.dumps(self.config).encode(), 0o600)
        self.write("/root/token", b"yenr1_one-time-test-token", 0o600)
        self.write("/root/leviathan-updater", b"fake-updater-not-executed", 0o755)
        self.write("/usr/local/bin/leviathan", b"original-binary", 0o755)
        self.write("/etc/leviathan/config.toml", b"# existing config\n", 0o600)
        self.write("/etc/leviathan/leviathan.env", b"# existing environment\n", 0o644)
        self.write("/etc/systemd/system/leviathan@root.service.d/10-hardening.conf", b"[Service]\nIPAddressDeny=any\nCapabilityBoundingSet=CAP_SYS_PTRACE\n", 0o644)
        der = bytes.fromhex("302a300506032b6570032100") + b"r" * 32
        self.write("/etc/leviathan-updater/release-public.pem", b"-----BEGIN PUBLIC KEY-----\n" + base64.b64encode(der) + b"\n-----END PUBLIC KEY-----\n", 0o644)
        for name in ("leviathan-updater.service", "leviathan-updater-recover.service"):
            source = Path(__file__).resolve().parent.parent / "contrib/systemd" / name
            self.write("/root/package/contrib/systemd/" + name, source.read_bytes(), 0o644)
        self.args = bootstrap.parser().parse_args([
            "--config", "/root/config.json", "--updater-binary", "/root/leviathan-updater",
            "--token-file", "/root/token", "--yggdrasil-cidr", "203.0.113.10/32", "--enable-managed-updates",
        ])

    def write(self, name, data, mode):
        path = self.host.path(name)
        path.parent.mkdir(parents=True, mode=0o755, exist_ok=True)
        path.write_bytes(data)
        path.chmod(mode)
        return path

    def run_command(self, command):
        self.calls.append(command)
        if command[:2] == ["systemctl", "show"]:
            return "User=root\nActiveState=active\nFragmentPath=/etc/systemd/system/leviathan@.service\n" + f"EnvironmentFiles={self.environment_files}\nEnvironment={self.environment}\n" + "ExecStart={ path=/usr/local/bin/leviathan ; argv[]=/usr/local/bin/leviathan " + self.config_args + " --listen 127.0.0.1:1397 serve " + self.extra_args + " ; ignore_errors=no ; }\n"
        if command[-1] == "version":
            return self.updater_version + "\n"
        if "version" in command:
            return json.dumps({"version": self.version, "commit": "a" * 40})
        if "enroll" in command:
            identity = self.host.path("/var/lib/leviathan-updater/identity.json")
            if not identity.exists():
                self.write("/var/lib/leviathan-updater/identity.json", b"same-private-identity", 0o600)
            if self.fail_enroll:
                raise bootstrap.BootstrapError("network unavailable")
        if "adopt" in command:
            original = self.host.path("/usr/local/bin/leviathan")
            self.write("/opt/leviathan/releases/adopted/leviathan", original.read_bytes(), 0o755)
            current = self.host.path("/opt/leviathan/current")
            if not current.exists():
                current.symlink_to("releases/adopted")
        return "active\n"

    def test_adopts_binary_preserving_service_hardening(self):
        old_hardening = self.host.path("/etc/systemd/system/leviathan@root.service.d/10-hardening.conf").read_bytes()
        bootstrap.bootstrap(self.args, self.host)
        self.assertEqual(os.readlink(self.host.path("/usr/local/bin/leviathan")), "/opt/leviathan/current/leviathan")
        self.assertEqual(self.host.path("/opt/leviathan/releases/adopted/leviathan").read_bytes(), b"original-binary")
        self.assertEqual(self.host.path("/etc/systemd/system/leviathan@root.service.d/10-hardening.conf").read_bytes(), old_hardening)
        dependency = self.host.path("/etc/systemd/system/leviathan@root.service.d/30-updater-recovery.conf").read_text()
        self.assertIn("Requires=leviathan-updater-recover.service", dependency)
        self.assertNotIn("[Service]", dependency)
        network = self.host.path("/etc/systemd/system/leviathan-updater.service.d/10-network.conf").read_text()
        self.assertEqual(network, "[Service]\nIPAddressAllow=203.0.113.10/32\n")
        self.assertIn(["systemctl", "enable", "--now", "leviathan-updater.service"], self.calls)
        self.assertFalse(any(c[0] == "systemctl" and any(v in c for v in ("restart", "stop")) for c in self.calls))

    def test_failed_enrollment_preserves_original_and_reuses_identity(self):
        self.fail_enroll = True
        with self.assertRaisesRegex(bootstrap.BootstrapError, "existing executable and service were preserved"):
            bootstrap.bootstrap(self.args, self.host)
        self.assertFalse(self.host.path("/usr/local/bin/leviathan").is_symlink())
        self.assertEqual(self.host.path("/usr/local/bin/leviathan").read_bytes(), b"original-binary")
        identity = self.host.path("/var/lib/leviathan-updater/identity.json").read_bytes()
        self.assertFalse(any("adopt" in c or "enable" in c for c in self.calls))
        self.fail_enroll = False
        bootstrap.bootstrap(self.args, self.host)
        self.assertEqual(self.host.path("/var/lib/leviathan-updater/identity.json").read_bytes(), identity)

    def test_managed_rerun_skips_adoption(self):
        bootstrap.bootstrap(self.args, self.host)
        self.calls.clear()
        bootstrap.bootstrap(self.args, self.host)
        self.assertTrue(any("status" in c for c in self.calls))
        self.assertFalse(any("adopt" in c for c in self.calls))

    def test_preflight_rejects_unsafe_inputs_before_mutation(self):
        for case in ("no_opt_in", "public_token", "preview", "allow_all", "combined_allow_all", "wrong_network", "invalid_key", "conflicting_binary", "unknown_updater", "hidden_config"):
            with self.subTest(case=case):
                self.setUp()
                if case == "no_opt_in": self.args.enable_managed_updates = False
                if case == "public_token": self.host.path("/root/token").chmod(0o644)
                if case == "preview": self.version = "0.5.0-rc.1"
                if case == "allow_all": self.args.yggdrasil_cidr = ["0.0.0.0/0"]
                if case == "combined_allow_all": self.args.yggdrasil_cidr = ["0.0.0.0/1", "128.0.0.0/1"]
                if case == "wrong_network": self.args.yggdrasil_cidr = ["192.0.2.10/32"]
                if case == "invalid_key": self.host.path("/etc/leviathan-updater/release-public.pem").write_bytes(b"not a public key")
                if case == "conflicting_binary": self.write("/usr/local/bin/leviathan-updater", b"unrelated", 0o755)
                if case == "unknown_updater": self.updater_version = "dev"
                if case == "hidden_config":
                    self.write("/root/agent.toml", b"# hidden by ProtectHome\n", 0o600)
                    self.config["agentConfigFile"] = "/root/agent.toml"
                    self.host.path("/root/config.json").write_text(json.dumps(self.config))
                with self.assertRaises(bootstrap.BootstrapError):
                    bootstrap.bootstrap(self.args, self.host)
                self.assertFalse(self.host.path("/etc/leviathan-updater/config.json").exists())
                self.assertFalse(any("adopt" in c or "enroll" in c or "enable" in c for c in self.calls))
                self.assertEqual(self.host.path("/usr/local/bin/leviathan").read_bytes(), b"original-binary")

    def test_preview_explicit_opt_in_and_dry_run(self):
        self.version = "0.5.0-rc.1"
        self.args.allow_preview = True
        self.args.dry_run = True
        bootstrap.bootstrap(self.args, self.host)
        self.assertFalse(self.host.path("/usr/local/bin/leviathan-updater").exists())
        self.args.dry_run = False
        bootstrap.bootstrap(self.args, self.host)
        self.assertTrue(any("--allow-preview" in c for c in self.calls))

    def test_unmodeled_environment_and_arguments_fail_before_mutation(self):
        for case in ("empty_registry", "extra_file", "inline_environment", "duplicate_config", "extra_flag", "implicit_config", "mismatched_env_config"):
            with self.subTest(case=case):
                self.setUp()
                if case == "empty_registry":
                    self.config["agentEnvironmentFile"] = ""
                    self.host.path("/root/config.json").write_text(json.dumps(self.config))
                if case == "extra_file": self.environment_files += " /etc/other.env (ignore_errors=no)"
                if case == "inline_environment": self.environment = "LEVIATHAN_CONFIG=/etc/other.toml"
                if case == "duplicate_config": self.extra_args = "--config /etc/other.toml"
                if case == "extra_flag": self.extra_args = "--show-command-line"
                if case == "implicit_config":
                    self.config["agentConfigFile"] = ""
                    self.host.path("/root/config.json").write_text(json.dumps(self.config))
                    self.config_args = ""
                if case == "mismatched_env_config":
                    self.host.path("/etc/leviathan/leviathan.env").write_text("LEVIATHAN_CONFIG=/etc/other.toml\n")
                with self.assertRaises(bootstrap.BootstrapError):
                    bootstrap.bootstrap(self.args, self.host)
                self.assertFalse(self.host.path("/etc/leviathan-updater/config.json").exists())
                self.assertFalse(any("adopt" in c or "enroll" in c or "enable" in c for c in self.calls))

    def test_literal_environment_can_select_registered_config(self):
        self.config_args = ""
        self.host.path("/etc/leviathan/leviathan.env").write_text('LEVIATHAN_CONFIG="/etc/leviathan/config.toml"\n')
        bootstrap.bootstrap(self.args, self.host)
        self.assertTrue(self.host.path("/usr/local/bin/leviathan").is_symlink())


class FreshBootstrapTest(unittest.TestCase):
    write = BootstrapTest.write

    def setUp(self):
        BootstrapTest.setUp(self)
        self.host.path("/usr/local/bin/leviathan").unlink()
        hardening = self.host.path("/etc/systemd/system/leviathan@root.service.d/10-hardening.conf")
        hardening.unlink()
        hardening.parent.rmdir()
        template = Path(__file__).resolve().parent.parent / "contrib/systemd/leviathan@.service"
        self.write("/root/package/contrib/systemd/leviathan@.service", template.read_bytes(), 0o644)
        hardening_source = template.parent / "leviathan@root.service.d/10-hardening.conf"
        self.write("/root/package/contrib/systemd/leviathan@root.service.d/10-hardening.conf", hardening_source.read_bytes(), 0o644)
        self.write("/root/agent", b"signed-new-baseline", 0o755)
        self.args.agent_binary, self.args.release_commit = "/root/agent", "a" * 40
        self.host.health = self.health
        self.fail_health, self.fail_start, self.foreign_service = False, False, False
        self.health_count = 0
        self.unit = "/etc/systemd/system/leviathan@root.service"

    def run_command(self, command):
        if command[:2] == ["systemctl", "show"]:
            self.calls.append(command)
            if "--property=LoadState,FragmentPath,ActiveState,User" in command:
                if self.foreign_service:
                    return "LoadState=loaded\nActiveState=inactive\nUser=root\nFragmentPath=/etc/systemd/system/unrelated.service\n"
                if not self.host.path(self.unit).exists():
                    return "LoadState=not-found\nActiveState=inactive\nFragmentPath=\n"
                return "LoadState=loaded\nActiveState=active\nUser=root\nFragmentPath=" + self.unit + "\n"
            return BootstrapTest.run_command(self, command)
        if command[:2] == ["id", "-u"]:
            self.calls.append(command)
            return "0\n"
        if "config-check" in command:
            self.calls.append(command)
            return '{"valid":true,"configProfile":"leviathan-config-v1","stateProfile":"leviathan-state-v1"}'
        if "adopt" in command:
            self.calls.append(command)
            baseline = Path(command[command.index("--binary") + 1])
            self.write("/opt/leviathan/releases/adopted/leviathan", baseline.read_bytes(), 0o755)
            current = self.host.path("/opt/leviathan/current")
            if not current.exists(): current.symlink_to("releases/adopted")
            return "adopted\n"
        if command == ["systemctl", "enable", "--now", "leviathan@root.service"] and self.fail_start:
            self.calls.append(command)
            raise bootstrap.BootstrapError("fixture startup failure")
        return BootstrapTest.run_command(self, command)

    def health(self, config, metadata, binary_sha):
        self.health_count += 1
        self.assertEqual(config, self.config)
        self.assertEqual(metadata["commit"], self.args.release_commit)
        self.assertEqual(self.host.path("/opt/leviathan/releases/adopted/leviathan").read_bytes(), b"signed-new-baseline")
        if self.fail_health:
            raise bootstrap.BootstrapError("fixture wrong running build")

    def test_fresh_install_enrolls_before_adoption_and_starts_exact_service(self):
        result = bootstrap.bootstrap(self.args, self.host)
        self.assertIn("Installed leviathan@root.service", result)
        calls = [" ".join(c) for c in self.calls]
        enroll = next(i for i, c in enumerate(calls) if " enroll " in c)
        adopt = next(i for i, c in enumerate(calls) if " adopt " in c)
        start = next(i for i, c in enumerate(calls) if c == "systemctl enable --now leviathan@root.service")
        self.assertLess(enroll, adopt)
        self.assertLess(adopt, start)
        unit = self.host.path(self.unit).read_text()
        self.assertIn("User=root\n", unit)
        self.assertIn("ExecStart=/usr/local/bin/leviathan --config /etc/leviathan/config.toml --listen 127.0.0.1:1397 serve", unit)
        self.assertIn("ProtectSystem=full", unit)
        self.assertTrue(json.loads(self.host.path("/var/lib/leviathan-updater/bootstrap.json").read_bytes())["complete"])
        self.assertEqual(self.health_count, 1)
        self.calls.clear()
        bootstrap.bootstrap(self.args, self.host)
        self.assertFalse(any("adopt" in c for c in self.calls))
        self.assertNotIn(["systemctl", "enable", "--now", "leviathan@root.service"], self.calls)

    def test_dry_run_has_no_persistent_side_effects(self):
        before = sorted(str(p.relative_to(self.root)) for p in self.root.rglob("*"))
        self.args.dry_run = True
        self.assertIn("fresh installation", bootstrap.bootstrap(self.args, self.host))
        self.assertEqual(before, sorted(str(p.relative_to(self.root)) for p in self.root.rglob("*")))
        self.assertFalse(any("enroll" in c or "adopt" in c or "enable" in c for c in self.calls))

    def test_conflicting_concurrent_bootstrap_rechecks_under_single_host_lock(self):
        second_config = copy.deepcopy(self.config)
        second_config["machine"]["machineId"] = "different-host"
        self.write("/root/config-second.json", json.dumps(second_config).encode(), 0o600)
        second_args = copy.copy(self.args)
        second_args.config = "/root/config-second.json"
        entered, proceed = threading.Event(), threading.Event()
        old_runner = self.host.runner
        def runner(command):
            if "enroll" in command:
                entered.set()
                if not proceed.wait(5):
                    raise bootstrap.BootstrapError("fixture synchronization timeout")
            return old_runner(command)
        self.host.runner = runner
        with ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(bootstrap.bootstrap, self.args, self.host)
            self.assertTrue(entered.wait(5))
            second = pool.submit(bootstrap.bootstrap, second_args, self.host)
            try:
                with self.assertRaises(TimeoutError):
                    second.result(timeout=0.05)
            finally:
                proceed.set()
            first.result(timeout=5)
            with self.assertRaises(bootstrap.BootstrapError):
                second.result(timeout=5)
        self.assertEqual(json.loads(self.host.path("/etc/leviathan-updater/config.json").read_bytes()), self.config)
        self.assertEqual(sum("enroll" in c for c in self.calls), 1)

    def test_file_appearing_after_preflight_is_compared_and_preserved(self):
        path = "/etc/leviathan-updater/conflict"
        self.write(path, b"owner-created-after-preflight", 0o600)
        with self.assertRaisesRegex(bootstrap.BootstrapError, "conflicting installation file"):
            self.host.install(path, b"installer-content", 0o600)
        self.assertEqual(self.host.path(path).read_bytes(), b"owner-created-after-preflight")

    def test_unsafe_bootstrap_lock_fails_before_preflight(self):
        self.host.path("/run").mkdir()
        self.host.path("/run/leviathan-bootstrap.lock").symlink_to(self.host.path("/root/token"))
        with self.assertRaises(OSError):
            bootstrap.bootstrap(self.args, self.host)
        self.assertEqual(self.calls, [])

    def test_interrupt_after_updater_start_preserves_subsequently_updated_monitor(self):
        old_runner = self.host.runner
        def runner(command):
            if command == ["systemctl", "is-active", "leviathan-updater.service"]:
                raise bootstrap.BootstrapError("fixture interruption after updater start")
            return old_runner(command)
        self.host.runner = runner
        with self.assertRaises(bootstrap.BootstrapError):
            bootstrap.bootstrap(self.args, self.host)
        self.assertTrue(json.loads(self.host.path("/var/lib/leviathan-updater/bootstrap.json").read_bytes())["complete"])
        self.write("/opt/leviathan/releases/new-approved-release/leviathan", b"newer-approved-running-binary", 0o755)
        current = self.host.path("/opt/leviathan/current")
        current.unlink()
        current.symlink_to("releases/new-approved-release")
        self.calls.clear()
        self.host.runner = old_runner
        bootstrap.bootstrap(self.args, self.host)
        self.assertEqual(self.health_count, 1)
        self.assertEqual(os.readlink(current), "releases/new-approved-release")
        self.assertFalse(any(c[0] == "systemctl" and "leviathan@root.service" in c and any(action in c for action in ("enable", "restart", "stop")) for c in self.calls))
        self.assertFalse(any("adopt" in c for c in self.calls))

    def test_fresh_lost_enrollment_preserves_absence_and_reuses_identity(self):
        self.fail_enroll = True
        with self.assertRaises(bootstrap.BootstrapError):
            bootstrap.bootstrap(self.args, self.host)
        self.assertFalse(self.host.path("/usr/local/bin/leviathan").is_symlink())
        self.assertFalse(self.host.path(self.unit).exists())
        identity = self.host.path("/var/lib/leviathan-updater/identity.json").read_bytes()
        self.fail_enroll = False
        bootstrap.bootstrap(self.args, self.host)
        self.assertEqual(identity, self.host.path("/var/lib/leviathan-updater/identity.json").read_bytes())

    def test_failed_start_or_health_is_explicit_and_identically_retryable(self):
        for failure in ("fail_start", "fail_health"):
            with self.subTest(failure=failure):
                self.setUp()
                setattr(self, failure, True)
                with self.assertRaisesRegex(bootstrap.BootstrapError, "installation is incomplete"):
                    bootstrap.bootstrap(self.args, self.host)
                self.assertIn(["systemctl", "stop", "leviathan@root.service"], self.calls)
                self.assertFalse(json.loads(self.host.path("/var/lib/leviathan-updater/bootstrap.json").read_bytes())["complete"])
                identity = self.host.path("/var/lib/leviathan-updater/identity.json").read_bytes()
                self.calls.clear()
                setattr(self, failure, False)
                bootstrap.bootstrap(self.args, self.host)
                self.assertFalse(any("adopt" in c for c in self.calls))
                self.assertEqual(identity, self.host.path("/var/lib/leviathan-updater/identity.json").read_bytes())

    def test_existing_inactive_service_or_dropin_is_preserved(self):
        for failure in ("foreign_service", "dropin", "unmanaged_binary"):
            with self.subTest(failure=failure):
                self.setUp()
                if failure == "foreign_service": self.foreign_service = True
                if failure == "dropin": self.write("/etc/systemd/system/leviathan@root.service.d/90-owner.conf", b"[Service]\nPrivateTmp=true\n", 0o644)
                if failure == "unmanaged_binary":
                    self.write("/usr/local/bin/leviathan", b"existing-no-service", 0o755)
                    self.extra_args = "--unknown-option"
                with self.assertRaises(bootstrap.BootstrapError):
                    bootstrap.bootstrap(self.args, self.host)
                self.assertFalse(self.host.path("/var/lib/leviathan-updater/bootstrap.json").exists())
                self.assertFalse(any("enroll" in c or "adopt" in c or "enable" in c for c in self.calls))

    def test_invalid_config_and_unreadable_nonroot_toml_fail_before_enrollment(self):
        for failure in ("invalid_config", "unknown_user", "unreadable_toml", "systemd_specifier"):
            with self.subTest(failure=failure):
                self.setUp()
                old_runner = self.host.runner
                def runner(command):
                    if failure == "invalid_config" and "config-check" in command:
                        raise bootstrap.BootstrapError("fixture invalid configuration")
                    if command[:2] == ["id", "-u"]:
                        if failure == "unknown_user":
                            raise bootstrap.BootstrapError("fixture unknown Unix user")
                        if failure == "unreadable_toml": return "12345\n"
                    if command[:2] == ["id", "-G"]: return "12345\n"
                    return old_runner(command)
                self.host.runner = runner
                if failure == "systemd_specifier":
                    self.config["agentConfigFile"] = "/etc/leviathan/%i.toml"
                    self.host.path("/root/config.json").write_text(json.dumps(self.config))
                with self.assertRaises(bootstrap.BootstrapError):
                    bootstrap.bootstrap(self.args, self.host)
                self.assertFalse(self.host.path("/etc/leviathan-updater/config.json").exists())
                self.assertFalse(any("enroll" in c or "adopt" in c or "enable" in c for c in self.calls))

    def test_changed_pending_binary_or_unit_is_not_overwritten(self):
        for failure in ("binary", "unit", "dropin"):
            with self.subTest(failure=failure):
                self.setUp()
                self.fail_health = True
                with self.assertRaises(bootstrap.BootstrapError): bootstrap.bootstrap(self.args, self.host)
                self.calls.clear()
                if failure == "binary": self.host.path("/root/agent").write_bytes(b"other release")
                if failure == "unit": self.host.path(self.unit).write_text("[Service]\nExecStart=/bin/other\n")
                if failure == "dropin": self.write("/etc/systemd/system/leviathan@root.service.d/99-other.conf", b"[Service]\nExecStartPost=/bin/other\n", 0o644)
                with self.assertRaises(bootstrap.BootstrapError): bootstrap.bootstrap(self.args, self.host)
                self.assertFalse(any("enable" in c or "adopt" in c or "enroll" in c for c in self.calls))

    def test_combined_existing_preview_is_adopted_without_installing_package_agent(self):
        self.write("/usr/local/bin/leviathan", b"existing-preview", 0o755)
        self.version = "1.9.0-rc.1"
        # Only the existing binary reports the preview; packaged binary remains stable.
        old_runner = self.host.runner
        def runner(command):
            if command[0] == str(self.host.path("/root/agent")) and "version" in command:
                return json.dumps({"version": self.updater_version, "commit": "a" * 40})
            return old_runner(command)
        self.host.runner = runner
        with self.assertRaisesRegex(bootstrap.BootstrapError, "preview adoption"):
            bootstrap.bootstrap(self.args, self.host)
        self.args.allow_preview = True
        bootstrap.bootstrap(self.args, self.host)
        self.assertEqual(self.host.path("/opt/leviathan/releases/adopted/leviathan").read_bytes(), b"existing-preview")
        self.assertFalse(self.host.path(self.unit).exists())
        self.assertNotIn(["systemctl", "enable", "--now", "leviathan@root.service"], self.calls)


if __name__ == "__main__":
    unittest.main()
