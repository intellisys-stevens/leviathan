#!/usr/bin/env python3
"""Select CI jobs from changed paths and verify every selected job completed."""

import argparse
import json
import os
import subprocess
import sys


JOBS = {
    "frontend": "frontend",
    "browser": "frontend-browser",
    "go": "go",
    "race": "race",
    "systemd": "automatic-setup-systemd",
    "bridge": "bridge-image",
    "distribution": "distribution-validation",
    "archive": "release-archive-dry-run",
    "security": "security",
}
ALL = set(JOBS)
GO = {"go", "race"}
WEB = {"frontend", "browser", "go"}
DISTRIBUTION = {"distribution", "archive", "frontend", "go", "systemd", "bridge"}


def classify(paths, full=False):
    if full:
        return ALL.copy()
    lanes = set()
    for path in paths:
        # Shared contracts and adapter code can affect every consumer and package.
        if path.startswith(("api/", "model/", "plugin/", "adapters/", "examples/", "internal/plugins/")):
            lanes |= ALL - {"security"}
        elif path.startswith((".github/", "scripts/")) or path in {"Makefile", "go.mod", "go.sum"}:
            lanes |= ALL
        elif path in {"web/package.json", "web/package-lock.json"}:
            lanes |= WEB | {"security"}
        elif path.startswith("licenses/") or path in {"LICENSE", "NOTICE"}:
            lanes.add("security")
        elif path.startswith(("charts/", "contrib/")):
            lanes |= DISTRIBUTION
        elif path.startswith(("web/", "internal/webui/")):
            lanes |= WEB
        elif path.startswith(("cmd/", "internal/")):
            lanes |= GO
            # Installation acceptance exercises real monitor health and startup.
            if not path.startswith(("internal/render/", "internal/tui/")):
                lanes.add("systemd")
            if path.startswith(("cmd/leviathan-kubernetes-bridge/", "internal/kubernetesbridge/", "internal/gpucapacity/")):
                lanes |= {"bridge", "distribution", "archive", "frontend"}
            if path.startswith(("cmd/leviathan-updater/", "cmd/leviathan-update-manifest/", "internal/updater/", "internal/updateprotocol/", "internal/cli/")):
                lanes |= DISTRIBUTION
        elif path.startswith(("docs/", "openspec/")) or path in {
            "README.md", "CONTRIBUTING.md", "AGENTS.md", "SECURITY.md", "CHANGELOG.md",
        }:
            continue
        else:
            # New source roots and build inputs must not silently skip coverage.
            return ALL.copy()
    return lanes


def changed_paths(base, head):
    if not base or set(base) == {"0"}:
        return None
    try:
        value = subprocess.check_output(
            ["git", "diff", "--name-only", "-z", base, head], stderr=subprocess.DEVNULL,
        )
    except (OSError, subprocess.CalledProcessError):
        return None
    return [path.decode("utf-8", errors="surrogateescape") for path in value.split(b"\0") if path]


def check_results(expected, results):
    if not isinstance(expected, list) or not all(name in JOBS.values() for name in expected):
        return ["invalid or missing expected job list"]
    required = {"changes", "secrets", *expected}
    errors = []
    for name in sorted(required):
        result = results.get(name, {}).get("result", "missing")
        if result != "success":
            errors.append(f"{name}: expected success, got {result}")
    for name, job in results.items():
        if name not in required and job.get("result") not in {"success", "skipped"}:
            errors.append(f"{name}: {job.get('result', 'missing')}")
    return errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["classify", "gate"])
    args = parser.parse_args()
    if args.command == "gate":
        try:
            errors = check_results(json.loads(os.environ["EXPECTED_JOBS"]), json.loads(os.environ["JOB_RESULTS"]))
        except (KeyError, ValueError, TypeError, AttributeError):
            errors = ["invalid or missing CI result data"]
        if errors:
            print("\n".join(errors), file=sys.stderr)
            return 1
        print("Every selected CI job succeeded; remaining jobs were deliberately skipped.")
        return 0

    event = os.environ.get("GITHUB_EVENT_NAME", "workflow_dispatch")
    base = os.environ.get("BASE_SHA", "")
    paths = changed_paths(base, "HEAD")
    full = event in {"schedule", "workflow_dispatch"} or os.environ.get("GITHUB_REF") == "refs/heads/main" or paths is None
    lanes = classify(paths or [], full=full)
    output = {key: str(key in lanes).lower() for key in JOBS}
    output["expected"] = json.dumps([JOBS[key] for key in sorted(lanes)], separators=(",", ":"))
    output["base"] = base if paths is not None else ""
    lines = "\n".join(f"{key}={value}" for key, value in output.items()) + "\n"
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as stream:
            stream.write(lines)
    print(lines, end="")
    return 0


if __name__ == "__main__":
    sys.exit(main())
