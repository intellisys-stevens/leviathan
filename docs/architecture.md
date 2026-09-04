# Architecture

![Leviathan data flow](assets/architecture.svg)

The editable diagram source is `assets/architecture.mmd`.

## Runtime shape

Core Leviathan is one Linux process and one executable. Independent,
non-overlapping system and GPU workers publish into one immutable snapshot
coordinator. The TUI, streaming CLI, HTTP server, history buffer, and optional
uplink consume those snapshots; they never start another collector. A blocked
GPU call cannot delay CPU, RAM, or storage publication. Slow consumers receive
the newest complete snapshot rather than building a queue. An optional
Kubernetes bridge is a separate least-privilege process and communicates only
through a configured local Unix socket.

Each domain loop is synchronous within that domain. Expensive GPM/DCGM entities
are staggered across ticks, `/proc` GPU-process inventory is cached at its own
default two-second cadence, and filesystem discovery defaults to ten seconds.
Cached metrics retain their true sample time and expire to `stale`. If a poll
takes longer than its interval, the next deadline is advanced past the current
time, so overlapping calls and accumulated lag are impossible. A GPU provider
error triggers one immediate full retry. Persistent errors publish a
retained-topology snapshot whose formerly available dynamic values are `stale`
and `null`, while the other telemetry domain remains current.

The browser receives every server-sent snapshot. Each browser independently
chooses whether React commits every sample or only the newest pending snapshot
once per one or two seconds; this presentation preference is stored locally and
does not mutate host collection. Operators can still change the process-local
collector cadence through the settings API or startup configuration. A host
cadence update resets the next deadline and never starts a second provider poll.

## Domain invariants

- CPU utilization and disk throughput are counter deltas. Initial samples,
  invalid elapsed time, counter resets, and topology changes remain unavailable
  until a new baseline exists. Disk throughput is also unavailable unless every
  selected persistent filesystem has a matching block-device counter; capacity
  remains usable for non-block persistent filesystems.
- RAM uses `MemAvailable`; the documented older-kernel fallback is marked
  `estimated` rather than `available`.
- Filesystem IDs are deterministic and opaque. Device paths and filesystem UUIDs
  are not retained in the public model.
- The hierarchy is always GPU → GI → CI. A one-CI GI may be flattened only by
  presentation code.
- GPM/DCGM activity and GI memory stay on the GI. They are never divided or
  copied onto child CIs.
- Temperature, power, and clocks stay on the physical GPU.
- PCIe RX/TX is stored as bytes per second at its measured physical-GPU or GI
  scope. DRAM/memory activity remains a percentage and is not relabeled as
  framebuffer bandwidth.
- A missing value is a nil pointer and serializes as JSON `null`; it is never
  replaced with zero.
- Every measurement has source, scope, sample time, and status.
- Stable device UUIDs remain API identifiers for history and attribution joins,
  while routine dashboard views use the numeric GPU/GI/CI hierarchy. Internal
  `@gN` generations keep history from joining a removed and later recreated GI
  or CI.
- Provider merge precedence is GPM → DCGM → NVML, but an available lower-level
  value wins over an unavailable higher-level value.

## Providers

`internal/system` reads `/proc/stat`, `/proc/loadavg`, `/proc/cpuinfo`,
`/proc/meminfo`, `/proc/self/mountinfo`, and `/proc/diskstats`, plus `statfs` for
capacity. It excludes network, pseudo, overlay, tmpfs, and other ephemeral
filesystems, collapses device aliases, and applies a deterministic 256-entry
limit. See [host monitoring](host-monitoring.md).

`internal/provider/nvml` uses NVIDIA's Go NVML binding for discovery, physical
metrics, memory, MIG attributes, power limits, and GPM activity/PCIe rates. It
deliberately does not call NVML's host-process or placement APIs and never
executes `nvidia-smi`. Device handles are discovered on each sample, so live
topology changes are visible without restarting.

`internal/provider/dcgm` decorates an NVML snapshot. It creates a local DCGM
GI entity group, refreshes that group at the configured topology interval,
and merges profiling fields only where GPM lacks an available canonical
metric. Blank DCGM profiling sentinels produce a paused/conflict diagnostic.

`internal/provider/fake` supplies sanitized deterministic scenarios for UI,
contract, and resilience tests.

## Optional scheduler attribution

The attribution decorator is disabled unless an absolute Unix-socket path is
configured. When enabled, it polls a versioned, bounded JSON document in the
background and enriches snapshots without entering the NVIDIA sampling path.
Unavailable or stale attribution never fails a GPU sample or `/healthz`.

The separate Kubernetes bridge watches DRA ResourceClaims in explicitly
configured namespaces and NVIDIA ResourceSlices. It joins the complete
`(driver, pool, device)` identity and emits only hashed workload and consumer
scope references, Coder display names, and physical-GPU or compute-instance
UUID assignments. An assignment is not evidence of active execution. See
[Kubernetes attribution](kubernetes-attribution.md).

## GPU processes

The workspace decorator enumerates numeric entries from Leviathan's current
`/proc` view and compares each process' file-descriptor device metadata with
`/dev/nvidia-uvm`. Identity fields are resolved only after a match. An open UVM
handle includes idle CUDA contexts; it does not prove current kernel execution,
GPU memory consumption, or GPU/GI/CI ownership. Leviathan excludes itself.

For matches, the collector resolves PID, user, executable path with `comm`
fallback, and start time; command arguments are read only when explicitly
enabled. PID plus start time provides a stable identity across PID reuse.
Processes that disappear mid-sample are skipped, while partially readable rows
retain explicit status and diagnostics. Unreadable FD directories are reported
in aggregate, while a readable namespace with zero matches is healthy.

The process list is top-level snapshot data. It is neither associated with a
GPU nor stored in history. With attribution configured, Leviathan reads the
cgroup path of each detected GPU client, recognizes Kubernetes Pod UIDs in
cgroup v1/v2 systemd or cgroupfs layouts, and joins a one-way hash to the
bridge's consumer scope. Only the resulting workload reference enters the
public snapshot. No device ownership is inferred, and Leviathan does not inspect
container runtimes, process environments, Pod objects, or another PID
namespace.

## History and reconfiguration

History uses two bounded in-memory tiers. Per-entity raw rings retain at most the
latest hour at the real collector cadence. In parallel, deterministic
epoch-aligned 30-second buckets retain count, sum, latest, minimum, maximum, and
gap state for the configured long window. The default retention is twelve
hours. Rings allocate only the points they contain and inactive entity
generations expire after their final retained sample, keeping steady operation
and rapid UUID churn bounded.

Host metrics use the reserved `@host` entity; filesystem capacity uses each
opaque filesystem ID. Domain-specific publications do not copy the other
domain's last values into a new history timestamp. System and GPU timelines are
tracked independently so a global publication-sequence jump does not create a
false gap. Mixed aligned queries return the timestamp union with missing values
left absent; CPU-only long-range host history does not depend on GPU samples.

Switching to a faster cadence grows every raw ring while preserving chronology.
The compact tier is independent of sampling cadence. Capacity never shrinks
during the process lifetime, so a later slower cadence cannot discard already
retained samples. Queries still enforce custom operator retention.

The history API maps a stable current UUID to its internal generation key and
then removes that suffix from the response. Old generations naturally expire
but cannot contaminate the current chart. Windows through one hour return raw
samples. Four-hour queries return 30-second means (at most 480 points), and
twelve-hour queries use count-weighted two-minute rollups (at most 360 points).
Only plotted means cross the existing wire format; gaps, unavailable metrics,
and generation boundaries remain absent rather than being interpolated.

`POST /api/v1/history/aligned` serves overview history for multiple requested
entities on one shared timestamp grid. Every response row represents one
timestamp across the requested series. Its required `maxPoints` value is
validated from 50 through 5000 and strictly caps the number of shared rows.
Leviathan never interpolates or carries values forward: a missing measurement
remains absent, and a failed collector attempt is retained as an empty shared
row so clients render a real gap. The legacy single-entity
`GET /api/v1/history` endpoint remains available for detail views and API
compatibility.

## Yggdrasil uplink

When configured, the uploader is another subscriber owned by
`leviathan serve`. Every process start creates a random 128-bit stream ID and
each logical upload has a monotonic sequence. The runner sends only the newest
sanitized projection, preserves an attempt's identity across retries, and keeps
no disk queue. Its default 15-second cadence has randomized startup and jitter;
retry backoff starts at five seconds, honors bounded `Retry-After`, and caps at
five minutes. Network requests run outside both collector workers.

The local snapshot model and the `uplink-v1` wire model are independent
contracts. The projection omits processes, users, command lines, workload
attribution, provider machine identity, device paths, filesystem UUIDs, and raw
diagnostic detail. Yggdrasil resolves the authoritative machine identity from
the bearer credential rather than trusting a payload field.

## API and browser boundary

`api/openapi.yaml` is the local API contract source. `go generate ./internal/api`
produces its Go wire types and `npm run generate:api` produces TypeScript types.
The independent uplink uses the provenance-locked vendor copy at
`api/uplink-v1-openapi.yaml`; `go generate ./internal/uplink` produces its local
Go DTOs without importing Yggdrasil code.

The server binds only to loopback after an explicit address check. GPU state
and telemetry have no mutation routes; the sole mutation changes the current
process' sampling cadence and requires JSON. A read-only version endpoint
reports linker-supplied build metadata. Security headers deny framing and
restrict scripts, fonts, images, and connections to local embedded assets. No
CORS headers are emitted. Negotiated gzip covers JSON, embedded text assets,
and flush-safe SSE. SSE sends sequence IDs, reconnect guidance, the latest
snapshot, and effective settings on every new subscription.

Health is domain-aware. It is `ok` when every enabled domain is current,
`degraded` with HTTP 200 while at least one system or GPU domain remains usable,
and `unavailable` with HTTP 503 only when no telemetry domain has a valid
snapshot.

The React client owns one `EventSource` and keeps the last complete snapshot
during reconnects. Its GPU perspective organizes host-wide topology and
telemetry by device. Its People perspective groups scheduler assignments by
Coder user and workspace without treating reserved or allocated resources as
evidence of active use. Charts and processes remain host-wide; a process may
show its joined workspace but never claims a particular GPU, GI, or CI.

The overview loads one aligned history batch per panel and refetches whenever
the exact panel, topology, or selected range changes in either direction. Raw
windows merge newer SSE samples by timestamp; compact 4h/12h windows retain the
last complete plot and refresh only on the next aggregate boundary. Stale
responses are ignored. The shared grid keeps series comparable while preserving
real gaps. Single-entity detail views continue to use the legacy history query.
The browser-local window can be 5, 15, or 30 minutes and 1, 4, or 12 hours,
subject to configured retention. Deterministic epoch-aligned display buckets
keep closed curve geometry stable. The overview chart bundle and GI/CI detail
drawer are lazy-loaded.

## Shutdown

The command context cancels the collector and optional uploader. Both polling
workers exit, GPM samples are freed, DCGM field/entity groups are destroyed, an
in-flight upload receives cancellation, and the HTTP server receives a bounded
graceful shutdown.
