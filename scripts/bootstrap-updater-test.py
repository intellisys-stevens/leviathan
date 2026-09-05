#!/usr/bin/env python3
"""Isolated bootstrap tests: never execute systemctl or a real updater."""

import base64
import importlib.util
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
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


if __name__ == "__main__":
    unittest.main()
