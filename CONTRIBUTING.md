# Contributing

Use Go 1.27+, Node.js 24+, a C compiler, Python 3, and `make`. Full monitor
tests run on Linux; fixture-based tests do not require NVIDIA hardware.
Helm and Chromium are needed only for their specialized checks.

```bash
make bootstrap
make check
make test
make build
```

`make build` bundles the dashboard and compiles the monitor, updater, and bridge.
It does not run tests or dependency audits. `make check` runs Go vet, frontend
lint/format/type checks, and contract verification. `make test` runs deterministic
Go/frontend unit tests and CI selection/gate tests. Once dependencies are installed,
the ordinary tests do not query vulnerability or license services.

| Change | Additional check |
| --- | --- |
| Go concurrency or lifecycle | `make test-race` |
| Plugin protocol or external adapter | `make test-conformance` |
| Browser behavior, layout, or graphics | `make test-browser`; see [browser workbench](docs/browser-workbench.md) |
| Installer/bootstrap | `make test-install test-updater-bootstrap` |
| Kubernetes packaging | `make helm-check` |
| Updater activation/recovery | Native systemd CI; [prepared-host procedure](docs/generated-updater-acceptance.md) |
| Release preparation | `make check-release` and native archive dry runs |

`make test-systemd` runs the prepared `/root/updater-package/automatic-setup.test`
fixture only when `LEVIATHAN_UPDATER_DISPOSABLE_HOST=1` is set. Use a disposable
Linux systemd host and the exact-source fixtures from CI; the test checks its
marker and refuses an existing installation. It is excluded from ordinary tests.

## Tests and semantics

Preserve independent CPU, RAM, storage, and GPU telemetry, including CPU-only
hosts. Metrics state their units, provider, hardware scope, sample time, and
availability. Missing or stale readings remain distinct from measured zero.
GPU assignment does not prove execution; capacity profile counts are alternatives,
not additive scheduler admission guarantees.

Add behavioral coverage for changed history, protocol, ownership, status, and
concurrency rules. Browser checks should cover keyboard/touch interaction,
missing samples, retained-history races, reduced motion, and narrow layouts.
Keep shared GI measurements distinct from CI identities and compare actual
WebGL output separately from the static fallback. Decorative changes usually
need visual review rather than exact source-text or geometry assertions.

## Generated files

`make generate` refreshes local Go/TypeScript API bindings and the vendored uplink
types. `make frontend` refreshes `internal/webui/dist`; commit it with browser
source changes. After editing `scripts/install-managed.py`, run
`python3 scripts/sync-managed-installer.py` to refresh its embedded copy.
Release installer pins are generated during packaging. The architecture SVG is
generated from `docs/assets/architecture.mmd`.

## CI

CI always validates its path classifier and scans changed commits for secrets.
Relevant source paths select frontend, browser, Go/race, installer, Helm,
container, and native systemd/archive jobs. Shared contracts include their
consumers; unknown paths conservatively select every lane. The final `required`
job fails if a selected job fails, is cancelled, or unexpectedly skips.

Main-branch pushes, manual runs, and the weekly schedule run every lane, including
dependency audits, license checks, and full-history secret scanning. Brokkr
routing uses repository-scoped Brokkr services for same-repository jobs and
reruns when `BROKKR_ENABLED=true`; fork PRs remain hosted. To use hosted
runners, disable that repository variable before starting a fresh run. Each
Brokkr service supplies a separate `PLAYWRIGHT_PORT`, and CI starts its own
server. The four software-rendered browser projects use independent hosted
runners. Native NVIDIA browser experiments remain separate, explicit manual
runs. Release validation retains signing, provenance, archive, and dependency
checks.

Use synthetic fixtures and report the platform, hardware path, and checks actually
run. See [AGENTS.md](AGENTS.md) for the source map and
[releasing](docs/releasing.md) for packaging and publication procedures.
