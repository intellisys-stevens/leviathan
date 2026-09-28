# Working in Leviathan

Leviathan monitors one Linux host. Start with the owning component and run the
smallest check that exercises the behavior being changed.

| Area | Source |
| --- | --- |
| Public telemetry types | `model/` |
| External plugin protocol and example | `plugin/v1/`, `examples/fixture-plugin/` |
| Plugin connection and sampling | `internal/plugins/` |
| Host/GPU collection and history | `internal/collector/`, `internal/provider/`, `internal/system/`, `internal/history/` |
| Kubernetes identity and DRA adapters | `adapters/kubernetes/`, `internal/kubernetesbridge/` |
| CLI and HTTP API | `internal/cli/`, `internal/api/`, `api/` |
| Browser | `web/src/`, `web/e2e/` |
| Installation and updates | `internal/updater/`, `scripts/`, `contrib/`, `charts/` |

`make build` bundles and compiles. `make check` runs static and contract checks;
`make test` runs Go/frontend unit tests and CI-selection tests. Neither performs
dependency audits. Use `make test-conformance`, `test-race`, `test-browser`,
`test-install`, `test-updater-bootstrap`, or `helm-check` for the affected boundary.
Full monitor tests require Linux; fixture tests do not require NVIDIA hardware.
See [CONTRIBUTING.md](CONTRIBUTING.md) for prerequisites and the CI lane table.

Edit source rather than generated `internal/api/wire.gen.go`,
`web/src/api.gen.ts`, `internal/webui/dist/`, or the embedded Python section of
`scripts/install.sh`. Use `make generate`, `make frontend`, or
`python3 scripts/sync-managed-installer.py` for the corresponding output.

Keep metric units, source, scope, timestamps, and unavailable states explicit.
Preserve CPU-only operation and isolate optional adapter failures. Environment
labels, Kubernetes objects, and scheduler-specific resolution belong to adapters.
Plugins are external processes supervised by systemd or Kubernetes.

Use fixtures for regressions involving missing data, concurrency, ownership,
protocol compatibility, or updater recovery. Avoid tests that freeze source
spelling, implementation structure, or decorative geometry. Preserve signature,
host-identity, path-integrity, and rollback behavior when changing installation.

The active change specification is under `openspec/changes/environment-plugins`.
Archived specifications are historical records; current procedures live in `docs/`.
