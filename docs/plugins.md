# Environment plugins

The unreleased source supports built-in collectors and independently supervised
plugins through the same observation contract. CPU, RAM, storage, GPU, workload
identity, allocation, and capacity retain their existing telemetry types.
Platform names and workload kinds can describe environments other than Coder.
Published v0.4.1 does not understand this configuration.

## Try the fixture

Build a separate plugin executable from the repository root:

```bash
go build -o bin/fixture-plugin ./examples/fixture-plugin
go build -o bin/leviathan ./cmd/leviathan
mkdir -p /tmp/leviathan-plugin-example
bin/fixture-plugin --socket /tmp/leviathan-plugin-example/plugin.sock --id example
```

Keep that process running. Save this as `/tmp/leviathan-plugin-example/config.toml`:

```toml
[[plugins]]
id = "example"
socket = "/tmp/leviathan-plugin-example/plugin.sock"
interval = "1s"
```

In another terminal, use the source-built monitor:

```bash
bin/leviathan --config /tmp/leviathan-plugin-example/config.toml config-check
bin/leviathan --config /tmp/leviathan-plugin-example/config.toml plugins list -f json
bin/leviathan --config /tmp/leviathan-plugin-example/config.toml --error-format=json plugins check -f json
bin/leviathan --config /tmp/leviathan-plugin-example/config.toml serve
```

The example reports synthetic host/GPU/process readings, an `example-batch` job,
owner measurements, a GPU assignment, and a capacity row. It does not measure the host and requires no GPU,
Kubernetes credentials, or Coder deployment. Its imports are the public
[`model`](../model) and [`plugin/v1`](../plugin/v1) packages; another Go module can
use those packages without importing Leviathan's `internal` implementation.

## Configure composition

With no `plugins` array, existing settings select the familiar composition:
`host`, `nvidia`, and `processes`; fixture mode selects `fake`. An attribution
socket adds `coder-kubernetes`, with `workload-cgroups` and `gpu-capacity` selected
by their existing settings. No plugin file or external process is required for
standalone monitoring.

An explicit `[[plugins]]` array replaces that composition. Include every source
you want. For example, keep host monitoring while taking GPUs and environment
metadata from the example process:

```toml
[[plugins]]
id = "host"
builtin = "host"

[[plugins]]
id = "example"
socket = "/tmp/leviathan-plugin-example/plugin.sock"
capabilities = ["gpu", "workload-inventory", "allocations", "gpu-capacity"]
interval = "2s"
```

| Field | Meaning |
| --- | --- |
| `id` | Unique configured instance, 1–64 letters/digits, dots, underscores, or hyphens; first character alphanumeric |
| `builtin` or `socket` | Exactly one registered built-in name or clean absolute Unix socket path |
| `capabilities` | Optional subset of the source's advertised capabilities; omitted or empty selects all |
| `dependencies` | Instance IDs that must initialize first; missing, disabled, and cyclic dependencies are rejected |
| `interval` | Poll interval from `250ms` through `60s`; defaults to the monitor interval |
| `disabled` | Excludes the instance; defaults to `false` |

Configuration supports up to 32 instances and takes effect after restart.
Built-ins are `host`, `nvidia`, `processes`, `fake`, `coder-kubernetes`,
`workload-cgroups`, and `gpu-capacity`. NVIDIA provider selection still uses
`provider`; Coder adapters still use the existing attribution socket/checkpoint
settings. Changing an instance ID changes its external resource namespace and
history identity. Configure one source for each measured resource: conflicting
host, GPU, process, or allocation claims produce diagnostics and withheld data.

## Inspect and automate

`config-check` validates configuration without starting collectors or touching
credentials, listeners, or saved history. `plugins list` and `plugins inspect ID`
inspect local configuration without opening plugin endpoints; external
capabilities remain unknown until a connection is checked. `plugins check`
opens configured sources, checks each enabled capability, and closes them.
Each open/read has a two-second deadline; checking several instances can take
longer than two seconds overall.

Use `-f json` for plugin command output and `--error-format=json` for structured
stderr. Error codes are `invalid_config`, `plugin_check_failed`, `timeout`,
`canceled`, and `command_failed`; failures return a nonzero process exit status.
For a running monitor, `GET /api/v1/plugins` returns instance/capability states,
cadence, observed time, last success, and diagnostics. `GET /api/v1/gpu-capacity`
and existing snapshot/history endpoints expose the resulting telemetry. The
browser API remains loopback-only; its schema is in [OpenAPI](../api/openapi.yaml).

## Implement the protocol

A plugin exposes HTTP over a local Unix socket. The portable
[OpenAPI contract](../api/plugin-v1.yaml) defines manifests, capability payloads,
and source-local references. The SDK additionally checks stateful revision
ordering and freshness; the monitor resolves resource joins.

| Request | Response |
| --- | --- |
| `GET /plugin/v1/manifest` | Implementation ID/version, `protocol_version: "1"`, and capability revisions |
| `GET /plugin/v1/observations/{capability}` | One observation containing exactly that capability's payload |

Capability names are `host`, `gpu`, `processes`, `workload-inventory`,
`allocations`, `workload-measurements`, and `gpu-capacity`; each currently uses
revision `"1"`. Unknown protocol versions or capability revisions are rejected.
The implementation ID identifies the plugin package; observation `instance_id`
must match the configured `id`. Pass the same value through the example's `--id`.

Each observation includes a session ID, a positive revision, its actual source
timestamp, and status. A new process session permits revisions to restart.
Within a session and capability, revisions and source times cannot move
backward. Returning cached data must retain its revision and timestamp. The
monitor marks observations stale after three polling intervals, rather than
treating another HTTP read as a new measurement.

Use the public model's units, hardware scopes, provenance, null values, and
availability states. Resource references explicitly name the producing instance,
resource ID, and optional generation. Missing targets or changed generations
remain unresolved; allocation records never establish GPU execution. Capacity
profile counts describe alternatives and are not additive admission guarantees.

Go implementations implement `plugin/v1.Source`. `ServeUnix` handles the local
HTTP server and session ID; `CheckSource` provides lifecycle and advertised
capability checks for tests. Sources must honor context cancellation and allow
concurrent reads of different capabilities. The client bounds JSON documents to
4 MiB and rejects malformed payloads, inconsistent capability data, non-finite
numbers, invalid identities, future timestamps, and backward observations.

```bash
make test-conformance
go test ./adapters/kubernetes/... ./internal/kubernetesbridge
```

These fixtures exercise protocol behavior. An environment-specific adapter also
needs tests for its actual inventory, identity mapping, stale data, and authority
boundaries. Use [`examples/fixture-plugin`](../examples/fixture-plugin) as the
minimal implementation and [`plugin/v1`](../plugin/v1) as the wire reference.

## Operate and migrate

systemd or Kubernetes starts, restarts, and upgrades each plugin. Leviathan only
connects to configured sockets; it does not download, execute, or supervise a
binary. In systemd, place the socket in a service-owned runtime directory. In
Kubernetes, mount a shared socket directory into the plugin and monitor, keeping
cluster credentials with the adapter. The example creates a `0600` socket, so
run both processes with the same effective user or deliberately provide another
socket permission policy in your server.

The supervisor must handle a stale socket after an unclean exit; `ServeUnix`
does not replace an existing socket. Set startup ordering when necessary, and
inspect `/api/v1/plugins` after a restart. Failure of one capability does not
stop unrelated sampling. Protocol validation bounds incoming data; it does not
sandbox the plugin executable or grant it host/Kubernetes permissions.

Existing Coder/Kubernetes bridge `/v1` and `/v2` socket deployments remain supported
through the built-in adapters. Their namespace mapping, Pod/cgroup joins, and
NVIDIA DRA checkpoint logic stay in Kubernetes-specific packages. Keep the current
`attribution_socket`, `attribution_checkpoint_path`, and `workload_telemetry`
settings to retain full dynamic MIG resolution.

The source-built bridge also serves the new `/plugin/v1/` endpoints. Its
`--plugin-id` (default `coder-kubernetes`) must match the configured instance;
`--gpu-instance-id` (default `nvidia`) must name the configured GPU producer.
The automatic composition calls that producer `hardware`, so set
`--gpu-instance-id hardware` when using that identity. The bridge advertises
allocations, plus workload inventory or capacity when those features are enabled.
Direct plugin allocations resolve static device references; dynamic MIG
bindings report incomplete `host_resolution_required` until processed by the
built-in checkpoint adapter. A published legacy-only bridge cannot be used as a
generic plugin endpoint. See [bridge deployment](kubernetes-attribution.md).

Before downgrading to v0.4.1, remove `[[plugins]]` and unreleased `[gpu_capacity]`
configuration; its older parser rejects them. Re-enable supported legacy
settings explicitly. Plugin-private identity and diagnostics are not added to
the separate versioned [Yggdrasil uplink](uplink-v1.md).

## Local client migration

Regenerate strict clients from `api/openapi.yaml` before using this source build.
Metric sources, workload platforms, and workload kinds accept additional strings;
the existing built-in values and fields remain valid. GPU resources may include a
`generation`, and `capabilities.gpu` describes GPU availability independently of
NVML. External resource IDs are qualified by configured instance ID; use returned
IDs and generations rather than constructing NVIDIA-specific identifiers.

HTTP snapshots, `snapshot -f json`, and `watch -f jsonl` now share normalization.
Collection fields use empty arrays rather than null; metric maps use empty objects.
Unresolved process workload references are omitted until their inventory exists.
Absent provider and measurement groups report unsupported, with null quantities
and source `unknown`; normalization preserves actual source timestamps, including
zero timestamps for never-observed fields. These changes affect consumers that
previously distinguished null from an empty collection or accepted dangling joins.

The Yggdrasil uplink retains its separately locked schema. Unsupported optional
observations are omitted with the local `uplink_omitted_observations` diagnostic.
If required host sources, units, or scopes cannot be represented, no envelope is
sent and `uplink_incompatible_host` explains the omission locally. A custom plugin
source is never relabeled as NVML, procfs, or synthetic to fit the uplink contract.
