# Changelog

## Unreleased

### Added

- Yggdrasil enrollment saves and renews per-machine credentials, with durable
  recovery after lost responses. Portable uplink v2 retains custom plugin metric
  sources, units, and scopes; existing token-file deployments keep uplink v1.
- Versioned external environment plugins use the public telemetry model and
  independently sampled capabilities, with a non-Coder fixture example.
- Explicit plugin composition, offline configuration inspection, bounded
  endpoint checks, structured CLI errors, and `/api/v1/plugins` health reporting.
- A full-width Live GPU capacity panel above the Resources GPU boards shows
  additional native and MIG allocations feasible for this host. Independent
  read-only Kubernetes DRA state includes reservations from every namespace;
  profile counts are alternatives and do not reserve resources.
- Separate private bridge and public monitor capacity endpoints retain explicit
  stale, unavailable, and unsupported states. Standard bridge chart installs
  enable read-only capacity access, with `gpuCapacity.enabled` as an opt-out.
- Utilization-driven GPU, CPU, RAM, and storage particles use bounded shared
  rendering, stop for missing or stale telemetry, and respect reduced motion.

### Changed

- Uplink connections honor `HTTPS_PROXY` and `NO_PROXY`, including existing v1
  token-file deployments; TLS continues to verify the configured server origin.
- Local API and CLI snapshot projections share empty-collection and unresolved
  reference normalization. Source, platform, and workload-kind identifiers are
  extensible; strict generated clients need regeneration. The separate Yggdrasil
  uplink v1 schema remains locked, with local compatibility diagnostics for
  observations it cannot represent. Enrolled agents use the separately locked v2 schema.
- Build commands bundle and compile; deterministic checks, tests, specialized
  integration lanes, and dependency audits are separate. CI selects dependent
  jobs and rejects an unexpectedly skipped required lane.
- Public model types and Kubernetes attribution now have explicit package
  boundaries. Current contributor/agent instructions replace validation diaries
  and obsolete rename/branding checks.
- GPU details use a visible labeled control. The motherboard gains a soft edge
  glow and stays centered beside long host details. Its static section headings
  remain accessible navigation targets; Focus board toggles a CPU closeup and
  the whole-board view.

### Fixed

- Long-range history retains successful skipped samples and aggregates a resource
  once when several requested series refer to it. Explicit outages stay visible.
- Detail panels complete closing when background scheduling stalls their animation.
- Chart hover positions update through a shared animation frame with cached
  tooltip dimensions, preserving historical samples and missing-data gaps.
- Full GPU workloads use the same chip icon as SM ACTIVE while retaining the
  GPU ACTIVE label and its physical GPU activity measurement.

## 0.4.1 - 2026-09-07

### Fixed

- The advanced `--with-updater` installer accepts current GitHub CLI versions by
  using one exact certificate identity selector while retaining the release tag,
  source commit, signer commit, OIDC issuer, and hosted-runner checks.

- Regenerated the embedded dashboard after updating its dependencies so source
  builds and published binaries contain the same frontend.

### Changed

- Updated the Kubernetes attribution bridge build image to Go 1.27.1.
- Updated Lucide icons, React DOM types, Oxfmt, Oxlint, PostCSS, and Vitest.

## 0.4.0 - 2026-09-07

### Added

- Host-wide CPU identity, utilization, and load; RAM capacity and utilization;
  aggregate storage capacity and throughput; and bounded per-filesystem capacity.
- CPU-only operation across snapshots, watch output, the TUI, browser, history,
  diagnostics, and health reporting. `doctor --require-gpu` retains strict GPU
  validation for deployments that require NVIDIA hardware.
- An in-process, latest-only Yggdrasil uplink. `leviathan serve` projects the
  existing immutable collector stream onto the independent `uplink-v1` contract;
  it never starts a second collector or stores an offline queue.
- An opt-in hardened-root systemd drop-in for credential delivery and a narrowly
  allowed Yggdrasil destination IP or CIDR.
- Balanced whole-machine capacity cards and CPU, RAM, storage I/O/space, and
  physical-GPU history panels, with every GPU chart visible and direct keyboard/touch sample inspection.
- An interactive motherboard combines CPU, RAM, and Storage inspection, with
  all measurements visible beside the board and utilization-driven cyan glow.
  The schematic RAM bank and SSD area represent aggregate telemetry rather than
  inferred physical inventory. Mobile layouts stack the scene above the details.
- CPU/RAM hardware details, responsive filesystem cards, and interactive fanless
  3D GPU boards with selectable MIG chip regions and theme-aware green accents.
- A local 90-day health observation journal and read-only `/api/v1/status`
  report, with observed coverage, explicit unknown periods, persistence status,
  and separate host uptime and monitor runtime.
- Optional per-owner CPU cores, RAM usage, and storage I/O charts, including
  CPU-only Coder workspaces. An independent cgroup v2 collector uses bounded,
  metadata-only Pod inventory from the bridge's private `/v1/workloads` endpoint.
- Receipt-based Yggdrasil connection history, saved in isolated daily sidecars
  that preserve the legacy health journal and rollback compatibility.
- Shared NVIDIA, AMD, Intel, and generic GPU identity icons across the dashboard.
- Signed per-host managed updates and automatic setup through Yggdrasil, with
  native Linux updaters, prerequisite checks, systemd recovery, and rollback.
- Dynamic NVIDIA DRA attribution through private allocation handoffs and optional
  driver checkpoint resolution, validated against live GPU and MIG identities.

### Changed

- Capacity cards share aligned rows and thin bottom bars; GPU availability keeps
  its unassigned headline with a compact occupied-resource count. GPU metrics use
  the cyan gauge while device identities retain vendor marks. Mobile GitHub and
  theme actions are directly visible, and the cadence popup omits sampling prose.

- The browser workbench now uses Overview, Resources, Workloads, and Status.
  Workloads combines workspace assignments and owner resource use; process
  collection remains in the API and CLI. Legacy Diagnostics, Operations, and
  process links resolve to their new views.
- Status shows compact, directly inspectable daily bars for Yggdrasil, Host,
  and GPU telemetry. Missing observations remain visible, and unsupported or
  unknown collection displays as No data without changing historical records.
- GPU capacity shows resources without observed assignments, separates reserved
  devices, and keeps incomplete availability explicit. Overview capacity and charts
  put CPU and RAM before GPU and Storage. Resources groups host measurements in
  the motherboard panel above GPU boards. Overview and Workloads plots share compact, equal-height panels;
  desktop GPU legends support scrolling, arrow controls, and keyboard access.
  Mobile charts show every legend label in two columns, with wrapping names and
  values below each label.
- Browser update speeds of 0.5s, 1s, and 2s are saved per browser and selected
  through a glass control. Display preferences do not change host sampling or
  retained history. Overview capacity cards share the navigation's rounded cyan
  hover glow and reduced-motion behavior.
- Assignment integration appears once in Workloads; provider details are
  disclosed on demand. Reserved assignments remain distinct from active usage.
- Snow accumulates in 1–2 separated piles with randomized heights and spacing.
  Arrangements refresh on page load and remain stable through telemetry updates,
  navigation, and resizing.
- GPU resources expose a realistic 3D board and chip with drag rotation, zoom,
  hover summaries, and click/tap inspection. One locally bundled Three.js renderer
  serves independent cameras; accessible controls and a static fallback preserve
  inspection without WebGL. Mobile Interact/Done keeps normal scrolling available.
- GPU boards have a dim green edge glow and closer full-board framing that keeps
  the entire board visible. Graphics scroll with their cards without bouncing.
  Neutral overhead lighting makes the chip and surrounding components easier to see.
  Focus chip is enabled initially and restored by Reset; toggle it off to view the whole board.
- GPU resources always show all boards, with green Assigned and grey Unassigned
  badges. Chip regions share those colors and glow with fresh SM activity;
  restrained particles indicate activity without changing camera framing or picking.
  Shared GI activity stays explicit, and reduced motion keeps the effect static.
- Host history preserves independent sample timestamps and missing values;
  incomplete capacity readings stay explicit rather than becoming zero.

### Fixed

- Independently sampled GPU, host, and workload series no longer acquire false
  line breaks when another series reports a measurement. Charts preserve real
  gaps represented by explicitly unavailable samples, including in detail views.
- View changes restore scrolling and keyboard focus as soon as the destination
  mounts, before software-rendered GPU scenes can delay the next frame.
  Interrupting an animation applies the latest navigation immediately and
  prevents an obsolete transition callback from changing the destination.

### Security and privacy

- Uplink credentials use the `yv1` lookup-and-secret format, are read from a
  private regular file for every request, and are never accepted in TOML,
  environment variables, or process arguments.
- Uplink observations exclude processes, users, command lines, workload
  attribution and owner telemetry, backing-device paths, filesystem UUIDs, and raw diagnostic
  details. Filesystem identifiers are deterministic opaque hashes.
- HTTPS uploads reject redirects, cookies, ambient proxies, oversized bodies,
  and malformed or mismatched receipts. Requests time out after five seconds.

### Compatibility

- Local API v1 remains additive. A v0.4 server always emits the top-level
  `system` object; clients may treat its absence as a legacy server.
- `/healthz` returns `200 degraded` when only system or GPU telemetry is usable
  and `503 unavailable` only when neither domain has a valid snapshot.
