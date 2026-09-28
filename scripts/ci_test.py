#!/usr/bin/env python3
"""Coverage for dependency selection and required-job outcomes."""

import unittest
from unittest.mock import patch

import ci


class SelectionTests(unittest.TestCase):
    def test_documentation_needs_only_unconditional_checks(self):
        self.assertEqual(ci.classify(["README.md", "docs/architecture.md", "AGENTS.md"]), set())

    def test_browser_changes_cover_embedded_binary(self):
        self.assertTrue({"frontend", "browser", "go"} <= ci.classify(["web/src/App.tsx"]))
        self.assertTrue({"frontend", "browser", "go"} <= ci.classify(["internal/webui/dist/index.html"]))

    def test_shared_plugin_contract_covers_consumers_and_installation(self):
        for path in ["plugin/v1/protocol.go", "model/model.go", "adapters/kubernetes/attribution/client.go", "internal/plugins/runtime.go", "api/openapi.yaml"]:
            with self.subTest(path=path):
                self.assertTrue({"go", "race", "frontend", "browser", "systemd", "bridge", "archive"} <= ci.classify([path]))

    def test_go_health_changes_require_native_acceptance(self):
        self.assertTrue({"go", "race", "systemd"} <= ci.classify(["internal/collector/health.go"]))
        self.assertNotIn("systemd", ci.classify(["internal/tui/tui.go"]))

    def test_distribution_covers_transitive_prerequisites(self):
        for path in ["charts/leviathan-attribution/templates/rbac.yaml", "contrib/systemd/leviathan@.service", "internal/kubernetesbridge/capacity_builder.go", "internal/updater/apply.go", "internal/updateprotocol/manifest.go", "internal/cli/root.go"]:
            with self.subTest(path=path):
                self.assertTrue({"distribution", "archive", "frontend", "go", "bridge", "systemd"} <= ci.classify([path]))

    def test_dependency_changes_select_security_without_auditing_every_web_edit(self):
        self.assertTrue({"frontend", "browser", "go", "security"} <= ci.classify(["web/package-lock.json"]))
        self.assertNotIn("security", ci.classify(["web/src/App.tsx"]))
        self.assertEqual(ci.classify(["licenses/THIRD_PARTY_NOTICES.md"]), {"security"})

    def test_dependencies_workflows_unknown_paths_and_full_runs_are_conservative(self):
        for path in ["go.sum", "Makefile", ".github/workflows/ci.yml", "scripts/build-release.sh", "new-module/provider.go", ".new-build-input"]:
            with self.subTest(path=path):
                self.assertEqual(ci.classify([path]), ci.ALL)
        self.assertEqual(ci.classify([], full=True), ci.ALL)

    def test_missing_base_falls_back_to_full_instead_of_empty_diff(self):
        self.assertIsNone(ci.changed_paths("0" * 40, "HEAD"))
        with patch("ci.subprocess.check_output", side_effect=OSError("missing git")):
            self.assertIsNone(ci.changed_paths("missing", "HEAD"))


class GateTests(unittest.TestCase):
    def test_expected_jobs_must_succeed(self):
        for state in ["failure", "cancelled", "skipped", "missing"]:
            with self.subTest(state=state):
                jobs = {"changes": {"result": "success"}, "secrets": {"result": "success"}, "go": {"result": state}}
                self.assertTrue(ci.check_results(["go"], jobs))

    def test_unselected_jobs_may_skip_but_not_fail(self):
        jobs = {"changes": {"result": "success"}, "secrets": {"result": "success"}, "go": {"result": "skipped"}}
        self.assertEqual(ci.check_results([], jobs), [])
        jobs["go"]["result"] = "failure"
        self.assertTrue(ci.check_results([], jobs))

    def test_classifier_failure_or_missing_expected_jobs_cannot_pass(self):
        self.assertTrue(ci.check_results([], {"changes": {"result": "failure"}, "secrets": {"result": "success"}}))
        self.assertTrue(ci.check_results(None, {}))
        self.assertTrue(ci.check_results(["unknown-job"], {}))
        self.assertTrue(ci.check_results(["go"], {"changes": {"result": "success"}, "secrets": {"result": "success"}}))


if __name__ == "__main__":
    unittest.main()
