# Host monitoring

Leviathan v0.4 adds CPU, RAM, and storage to every local snapshot under the
top-level `system` object. Collection is Linux-only and read-only. It continues
on CPU-only machines and runs independently from the NVIDIA provider.

## Sources and cadence

| Domain | Source | Semantics |
| --- | --- | --- |
| CPU | `/proc/stat`, `/proc/loadavg`, `/proc/cpuinfo` | Aggregate utilization, 1/5/15-minute load, model, and logical processor count |
| RAM | `/proc/meminfo` | Integral total, used, and available bytes plus utilization |
| Storage capacity | `/proc/self/mountinfo` and `statfs` | Aggregate and per-filesystem integral capacity |
| Storage I/O | `/proc/diskstats` | Aggregate read/write bytes per second for directly mounted block devices |

Host samples follow the configured collector interval, one second by default.
Mount topology is rediscovered every ten seconds by default; capacity is read on
each host sample. The browser display cadence changes rendering only and does
not start or reconfigure another collector.

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
