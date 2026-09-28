# Plugin requirements

## External process contract

The monitor SHALL consume versioned JSON observations from configured local Unix
sockets. A plugin SHALL declare its identity, protocol version, and capabilities.
Unsupported versions or inconsistent declarations SHALL produce a diagnostic.
The core SHALL NOT start, download, upgrade, or supervise plugin executables.

Scenario: systemd restarts a failed plugin. The core reconnects and resumes fresh
observations without restarting healthy built-in telemetry.

## Existing telemetry semantics

The initial contract SHALL use the existing CPU, RAM, storage, GPU, allocation,
and owner telemetry types. Units, sources, scope, time, and unavailable readings
SHALL remain explicit. Missing data SHALL NOT become measured zero.

Scenario: an adapter has a current allocation inventory but unresolved device
identity. It reports incomplete resolution; the browser does not infer free capacity.

## Environment independence

Platform and workload identity SHALL support values beyond Coder and workspace.
Kubernetes API objects, labels, Pod/cgroup parsing, and NVIDIA DRA checkpoint
formats SHALL be isolated in adapters rather than required by the public model.

Scenario: a non-Coder fixture plugin supplies valid current-model observations
without adding platform-specific branches to the collector or dashboard.

## Failure isolation

Plugin I/O SHALL have bounded response sizes and request durations. Failed,
invalid, or expired observations SHALL affect only their owning capabilities.
Source identity SHALL prevent collisions between configured plugins.

Scenario: a plugin hangs or returns malformed JSON. Host monitoring continues,
and the failed capability is visible as unavailable or stale.

## Defaults and compatibility

No plugin configuration SHALL be required for existing standalone monitoring.
Existing Kubernetes bridge deployments SHALL retain a documented compatibility
path. The versioned Yggdrasil uplink SHALL NOT acquire plugin-private metadata.

## Conformance

The public SDK SHALL include fixtures and checks for version/capability agreement,
valid and invalid observations, staleness, and independent source identities.
The example plugin SHALL be runnable without Kubernetes credentials or a GPU.

## Build and validation

Ordinary build commands SHALL bundle and compile without vulnerability audits.
CI SHALL select dependent checks for changed paths and run all lanes for unknown
inputs. Its final required result SHALL reject missing, failed, cancelled, or
unexpectedly skipped selected jobs. Release validation SHALL retain artifact
verification and updater recovery checks.
