# Host monitoring

Leviathan v0.4 adds CPU, RAM, and storage to every local snapshot under the
top-level `system` object. Collection is Linux-only and read-only. It continues
on CPU-only machines and runs independently from the NVIDIA provider.

## Sources and cadence

| Domain | Source | Semantics |
| --- | --- | --- |
| CPU | `/proc/stat`, `/proc/loadavg`, `/proc/cpuinfo` | Aggregate utilization, 1/5/15-minute load, model, and logical processor count |
| Host uptime | `/proc/uptime` | Optional provenance-bearing metric in seconds since host boot; independent from monitor runtime |
| RAM | `/proc/meminfo` | Integral total, used, and available bytes plus utilization |
| Storage capacity | `/proc/self/mountinfo` and `statfs` | Aggregate and per-filesystem integral capacity |
| Storage I/O | `/proc/diskstats` | Aggregate read/write bytes per second for directly mounted block devices |

Host samples follow the configured collector interval, one second by default.
Mount topology is rediscovered every ten seconds by default; capacity is read on
each host sample. All dashboard views render the latest available sample at the
browser's selected 0.5-, 1-, or 2-second display interval (0.5 seconds by default).
This preference never starts or reconfigures a collector; backend sampling and
retained history remain independent of browser display updates.

## Delta and fallback rules

CPU utilization and storage throughput are calculated from consecutive counter
samples and elapsed monotonic sample time. A first sample, non-positive elapsed
time, counter reset, CPU hotplug, or mounted-device topology change produces an
unavailable value while a new baseline is established. Leviathan never turns
these cases into zero. Aggregate throughput is also unavailable when any
selected persistent filesystem has no matching block-device counter (including
non-block persistent filesystems); filesystem capacity remains available.

RAM prefers the kernel's `MemAvailable`. When that field is absent, Leviathan
uses free memory, buffers, page cache, reclaimable slab, and shared-memory
adjustment. The resulting RAM record and utilization metric have `estimated`
status so consumers can distinguish the fallback.

## Filesystem selection and privacy

Leviathan reports persistent local filesystems visible in its mount namespace.
It excludes network filesystems, proc/sys/cgroup-style pseudo filesystems,
tmpfs/ramfs, overlay mounts, and other ephemeral types. Mounts backed by the
same device are collapsed deterministically, results are sorted by normalized
mount point, and at most 256 entries are emitted.

Each filesystem contains a normalized mount point, type, capacity, and an opaque
deterministic ID. Block-device paths and filesystem UUIDs are neither retained
nor exposed.

## Health

`/healthz` returns `ok` when every active telemetry domain is current,
`degraded` when at least one domain remains usable, and HTTP 503 only when no
domain has a valid snapshot. `leviathan doctor` treats a healthy CPU-only host
as successful with a warning; `leviathan doctor --require-gpu` makes GPU
availability mandatory.

`GET /api/v1/status` reports current component states, monitor start time, and
90 UTC days of minute observations. Status shows Yggdrasil connection, host
telemetry, and GPU telemetry. Workspace attribution remains available in its
existing API history but does not affect Status; workspace failures appear in
Workloads. Host uptime stays separate from healthy observations and coverage.
Healthy observations use operational / (operational + degraded + unavailable);
coverage uses that same measured denominator / expected minute slots.
Unsupported and unknown observations display as **No data**; they are excluded
from measured counts but remain in expected coverage. Partial days are hatched,
with their worst measured state determining the bar color. Unknown gaps never
imply availability. Persistence configuration, restart behavior, and
downgrade handling are described in [Deployment](deployment.md#persistent-health-history).
