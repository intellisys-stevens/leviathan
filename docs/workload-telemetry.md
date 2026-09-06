# Per-owner host telemetry

The optional workload collector measures host resources for Coder workspace
owners, including workspaces without GPU assignments. It samples independently
every two seconds; a failed GPU provider does not stop it. Measurements describe
cgroup accounting, not quotas, scheduling eligibility, or all activity by an OS user.

| Metric | Accounting source | Unit |
| --- | --- | --- |
| CPU used | Pod `cpu.stat` `usage_usec` delta / monotonic elapsed time | Logical-CPU equivalents (cores) |
| RAM used | Inclusive Pod `memory.current`, including charged cache | Bytes, displayed as GiB |
| Storage read/write | Inclusive Pod `io.stat` byte-counter deltas | B/s |

One Pod root is counted once, including all descendants. Pods are then totaled
by stable Coder owner ID. Missing controllers, inaccessible or absent Pod
cgroups, stale inventory, ownership conflicts, and incomplete accounting remain
unavailable. If only some Pods have a metric, the owner total for that metric is
null and marked Partial; measured zero is retained as zero. CPU and I/O need two
continuous samples. Counter resets, Pod recreation, device replacement or
mapping changes, and gaps longer than six seconds reset their baselines.

Storage accounting resolves physical backing devices through sysfs. Complete
physical counters take precedence over mapper totals, and whole-disk counters
take precedence over their partition counters. Distinct sibling partitions can
be summed when no whole-disk counter is present. Overlapping or incomplete
backing graphs remain unavailable. These are kernel-accounted block bytes;
they do not measure application filesystem requests, network storage, or SSD
wear. CPU and RAM remain available if storage mapping fails.

## Enable

First enable the bridge inventory, preserving the release's existing values:

```bash
helm upgrade leviathan-attribution ./charts/leviathan-attribution \
  --namespace leviathan-system --reuse-values \
  --set workloadInventory.enabled=true
```

The bridge image must support `/v1/workloads`. If the existing release pins an
older `image.tag`, override it with the matching new bridge image tag; reusing
values alone does not upgrade a pinned image.

The chart grants namespace-scoped Pod `get/list/watch` in `workspaceNamespaces`.
It does not grant Pod logs, exec, Secrets, or mutations. Pod requests use a node
field selector and `com.coder.resource=true`, and negotiate metadata-only JSON.
The dedicated transport rejects full Pod fallback responses. Event watches do
not retain an informer cache: they trigger bounded, authoritative metadata lists.
Names, labels and annotations outside the identity join are not persisted or
published. Required labels are:

- `com.coder.resource=true`
- `com.coder.workspace.id` and `com.coder.workspace.name`
- `com.coder.user.id` and `com.coder.user.username`

Enable `workload_telemetry = true` in the host's existing Leviathan TOML, or set
`LEVIATHAN_WORKLOAD_TELEMETRY=true`, together with its existing
`attribution_socket` / `LEVIATHAN_ATTRIBUTION_SOCKET`. The CLI equivalent is
`--workload-telemetry`. The collector reads `/sys/fs/cgroup` and `/sys`; it never
requests Kubernetes credentials or a container-runtime socket. The private
`GET /v1/workloads` endpoint shares the existing root-only Unix socket, while
`GET /v1/allocations` keeps its original schema and semantics.

The inventory refreshes on metadata events and at least every ten seconds.
The host reads it at most once every five seconds and rejects source observations
older than fifteen seconds. Read failures immediately invalidate live owner
measurements; the prior sanitized owner list can remain visible with stale
status. Missing or old bridges return explicit unavailable readings.

## API, history and limits

The local snapshot optionally includes `workloadTelemetry`, owner identities,
workspace membership, source timestamps and availability. Each metric carries
`source: cgroupfs` and `scope: workload_owner`. Raw Pod UIDs, namespace names,
scope hashes and cgroup/device paths are not public. Owner histories use entity
`owner:<owner-ref>` and metric names `cpu_cores`, `memory_used_bytes`,
`storage_read_bps`, and `storage_write_bps`. Their independent two-second timeline
uses the existing retention, rollups, range and gap machinery; absent values
are never carried forward from host or GPU publications.

The private document is bounded to 1 MiB, 128 owners, 1,024 workspaces and 4,096
Pods. Oversized or ambiguous inventories are unavailable or Partial rather than
silently truncated. At most 256 owner histories remain across owner churn, with
the oldest evicted first; active point counts follow the two-second cadence.
Discovery, device graphs, response bodies and retries are bounded. Fixtures and
fake providers do not enable the live collector.

The locked Yggdrasil Uplink v1 payload is unchanged and excludes this local
owner telemetry. To downgrade, first disable `workload_telemetry` (or its
environment/CLI equivalent), then restore the previous monitor and bridge
artifacts and chart values. Old monitors ignore the new endpoint, and new
monitors show unavailable owner readings against an older bridge. No owner
telemetry journal or migration is introduced; existing health journals and
their rollback behavior are unaffected.
