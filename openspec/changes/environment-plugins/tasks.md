# Implementation checks

- [x] Preserve the original worktree and reconcile Resources/capacity/tooltip work
  onto current main without replacing published release fixes.
- [x] Move public model and Kubernetes attribution source into explicit packages.
- [x] Add public plugin protocol, manifest, observations, and conformance example.
- [x] Connect configured plugin capabilities to the monitor and diagnostics.
- [x] Verify non-Coder identities and legacy Kubernetes compatibility.
- [x] Separate build/check/test commands and dependency-aware CI lanes.
- [x] Replace stale policy and validation documents with current procedures.
- [x] Run focused regression, conformance, and integration checks on final source.

Publication and deployment are separate operations and are not completion tasks
for this source refactor.

Validation includes the full Linux arm64 Go race suite and vet, plugin and
Kubernetes fixture tests, a separately built plugin served to the actual CLI/API,
457 frontend unit tests, generated-source checks, production browser replay,
installer/update integrity and rollback fixtures, and Helm checks. Original WIP
tracked and untracked sources were verified unchanged.

The native macOS tooltip profile passes the existing p95 budget; the matched
Docker comparison does not establish a latency improvement. Measurements and
variance are recorded in [the performance guide](../../../docs/performance.md).
Live NVIDIA/Kubernetes behavior and disposable Linux systemd/reboot acceptance
were not exercised here. They remain environment acceptance checks before release;
no production deployment or publication was performed.
