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
during reconnects. Its four hash-addressed views have separate responsibilities:

| View | Responsibility |
| --- | --- |
| Overview | CPU, RAM, unassigned GPU units, and mounted-storage capacity; all activity charts |
| Resources | An interactive motherboard with CPU/RAM/filesystem facts, followed by physical GPU → GI → CI inspection |
| Workloads | Per-owner CPU, RAM, GPU, and storage I/O telemetry, workspace assignments, and integration status |
| Status | Yggdrasil connection, host/GPU telemetry observations, host uptime, monitor runtime, and diagnostic details |

Capacity cards use logical processor counts and measured RAM/storage usage. GPU
availability counts one existing unit per full GPU or observed MIG compute
instance. Allocated and reserved assignments consume units; unresolved or stale
observations leave unassigned capacity unknown. Resources always displays every
GPU and its complete observed topology; the Overview tile opens this full list.
Capacity counts describe observed workspace assignment coverage, not scheduler
admission eligibility.

GPU resource cards contain a fanless procedural Three.js board with an exposed
chip. Every observed compute instance becomes one selectable region; four
instances form a 2×2 layout. Other counts use balanced equal-area rows without
inventing slots. The layout does not encode physical silicon or computing power.
Full GPUs have one undivided chip; empty MIG configurations stay explicitly empty.
Hover and keyboard focus expose assignment state and shared GI memory/SM
telemetry; click, tap, or Enter opens the existing details. Shared GI readings
are not split among CIs. Native controls remain available without hover.
Assignment badges share their theme-aware hue with chip regions: green for
assigned, grey for unassigned, amber for reserved, and neutral for unknown.
Fresh measured SM activity controls brightness on a fixed 0–100% scale. CIs use
their GI's shared SM reading; non-MIG GPUs use physical GPU SM activity. Retained
snapshots, unavailable or estimated readings never animate as measured activity.
Opening the event stream alone does not establish freshness: a newer SSE
snapshot must reach the display first. Interruptions and malformed events
invalidate pending freshness. A silent stream expires after the greater of five
seconds or three sampling/display intervals; duplicate snapshots and settings
events cannot extend that deadline.

An internal hardware-scene adapter supplies motherboard and GPU model creation,
pick targets, named camera frames, appearance updates, and disposal. The
motherboard has stable CPU, memory, and storage targets; it does not infer DIMM
inventory or filesystem-to-drive placement. Its CPU and RAM glow uses available
live host utilization only, with intensity `0.15 + 0.65 × utilization / 100`.
Estimated and retained measurements remain readable with explicit status but
use neutral illumination. Storage selection is static. Selection outlines stay
independent of utilization, and updates do not rebuild model geometry.

One lazy shared renderer draws visible scenes using independent cameras and
scissor rectangles. Its HTML shell renders immediately and loading status stays
outside the control layout, so inspection targets do not move as graphics load.
The viewport-sized canvas lives in a clipped, absolute page layer outside
transformed view containers. Its existing pixels scroll with the cards between
frames; the canvas origin and scene clipping update together on redraw, avoiding
scroll lag. GPU initial view and Reset focus on the chip; the Focus chip toggle
also exposes the complete board. Full-board framing
fits cached component bounds with a small margin so the bracket and PCIe contacts
remain visible. The motherboard initially frames its complete board; Focus
selected frames the selected category, and Reset restores the whole board.
CPU, RAM, and Storage facts stay visible together. Category selection and each
scene's camera survive Resources navigation, and capacity links focus the
corresponding native heading button. Loading and graphics fallback retain the
same panel footprint and HTML inspection controls.
Scroll, resize, and view transitions invalidate its geometry. GPU identity retains camera
state across navigation. Topology generations replace model regions;
ordinary polling refreshes metrics and region appearance without rebuilding
geometry. Positive live activity adds sparse procedural particles close to each
region. Ambient draws are capped at 30 fps and run only for visible active views;
hidden tabs, stale data, zero activity, and reduced motion stop the shimmer.
Interactions still redraw immediately. Decorative effects are excluded from
raycasting and physical board framing. Hover/focus changes an outline, not the
activity brightness. There is no continuous rotation.
OrbitControls constrain elevation above the PCB, disable
panning, and allow full azimuth rotation. Phones require Interact before drag or
pinch; Done restores page scrolling. Native zoom, focus-chip, and reset controls
provide gesture alternatives. Selection requires the same region before/after a
short single-pointer press; drag, cancellation, and multi-touch do not select.

Materials and lighting adapt to both themes, with a dim NVIDIA-green perimeter
rim and soft halo that remain independent of chip and assignment state. Neutral
overhead and side lighting illuminate the chip, packages, and mounting bracket
while preserving dark recesses. Reduced
motion applies highlighting immediately and disables inertia. Graphics failure
or forced colors displays a static exposed-board diagram and retains the same
HTML actions. All geometry, labels, and libraries are bundled locally under the
existing CSP. Snow remains on the stationary card edge, using a page-load seed
and stable surface identity. GPU processes and attribution remain in the API and
CLI; the dashboard has no Processes panel. Legacy `#diagnostics` and `#operations` resolve to
Status and `#processes` to Workloads.

CPU, RAM, storage space, and disk read/write history share one aligned `@host`
request. GPU chart panels use aligned batches for their selected entities.
Host raw windows merge newer measurements by their own sample timestamps;
GPU-only publications do not create CPU/RAM history points. Compact 4h/12h
windows refresh on the next aggregate boundary. Range changes retain complete
history while loading, expose a scoped retry on failure, and ignore superseded
responses. Missing values remain gaps. Percentage axes use 0–100%; storage I/O
uses bytes per second and separate read/write series.

Single-entity detail views continue to use the legacy history query. The
browser-local window can be 5, 15, or 30 minutes and 1, 4, or 12 hours, subject
to configured retention. Deterministic epoch-aligned display buckets keep
closed curve geometry stable. Host/GPU chart bundles and the GI/CI detail drawer
are lazy-loaded by view. All Overview panels appear immediately in two columns
at desktop widths and one on phones. Their headings and plots align, with a
single-row legend beneath each plot. Dense GPU legends scroll horizontally;
arrow controls and keyboard navigation keep every series accessible without
changing panel height. Enlarged text and diagnostic feedback may grow naturally.
Tap a plot to select a timestamp, or use
Left/Right and Home/End on its keyboard focus target. The cursor and equal-width
legend cells show selected values; Escape or Live restores current values.
Selection reuses loaded history, preserves gaps, and requires no extra request.

## Local health observations

The read-only `/api/v1/status` report is separate from `/healthz` and metric
history. A local recorder keeps one telemetry-state observation per minute,
retaining ninety UTC dates. System and GPU telemetry are evaluated with their
own observation times. Yggdrasil connection observations use validated upload
receipts and independent monotonic freshness. Workspace diagnostics stay in
Workloads. Restart gaps and unobserved minutes remain unknown; underlying
unsupported and unknown states display as No data.

The dashboard computes healthy observations as operational observations divided
by operational, degraded, and unavailable observations. Coverage reports the
share of expected minutes with operational, degraded, or unavailable observations.
Unknown and unsupported samples are excluded. These are observation statistics, not externally measured
service availability or an SLA. Linux host uptime and the current monitor's
runtime are displayed separately. Monitor runtime comes from the process
monotonic clock, so wall-clock corrections do not change its elapsed duration.
Older status responses without this optional duration display an unavailable
runtime instead of deriving it from wall-clock timestamps.

Metric curves remain in memory with their existing bounded retention. The
private local health journal can survive monitor restarts; a saving failure is
reported independently and leaves current telemetry available. See
[host monitoring](host-monitoring.md#health) and
[deployment](deployment.md) for operating details.

## Shutdown

The command context cancels the collector and optional uploader. Both polling
workers exit, GPM samples are freed, DCGM field/entity groups are destroyed, an
in-flight upload receives cancellation, and the HTTP server receives a bounded
graceful shutdown.
