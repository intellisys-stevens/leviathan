<div align="center">

<h1><img src="web/public/leviathan-mark.svg" alt="Leviathan frost-dragon mark" width="48" height="48" valign="middle"> Leviathan</h1>

**Whole-machine Linux monitoring for CPU, RAM, storage, and NVIDIA GPUs.**

[![CI](https://github.com/intellisys-stevens/leviathan/actions/workflows/ci.yml/badge.svg)](https://github.com/intellisys-stevens/leviathan/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/intellisys-stevens/leviathan?display_name=tag&color=14b8a6)](https://github.com/intellisys-stevens/leviathan/releases/latest)
![Go](https://img.shields.io/badge/Go-1.27-00ADD8?logo=go&logoColor=white)
![Linux](https://img.shields.io/badge/Linux-amd64%20%7C%20arm64-334155?logo=linux&logoColor=white)
[![License: MIT](https://img.shields.io/badge/license-MIT-22c55e)](LICENSE)

</div>

Leviathan is a Linux-only, read-only monitor for CPU, RAM, persistent local
storage, and the physical GPU → GPU Instance (GI) → Compute Instance (CI)
hierarchy. One Go binary includes an interactive TUI, scriptable output, and a
local React dashboard. An optional in-process uploader sends a sanitized
machine observation to Yggdrasil, while an optional Kubernetes bridge adds
scheduler-authoritative workspace assignments.

## ✨ Highlights

- MIG-aware topology, profiles, memory, activity, and parent-GPU telemetry.
- Host-wide CPU utilization and load, RAM capacity/utilization, aggregate disk
  throughput, and sanitized per-filesystem capacity from procfs and statfs.
- Independent system and GPU workers: CPU-only hosts remain operational, and a
  failed GPU sample does not stop host telemetry publication.
- NVML GPM with optional DCGM fallback, including exact PCIe transfer rates.
- Compact CPU, RAM, GPU assignment, and storage capacity cards, with all
  utilization and transfer charts visible in Overview.
- Four-view browser workbench for Overview, Resources, Workloads, and Status,
  with responsive layouts, keyboard navigation, and accessible dark/light themes.
- Interactive, fanless 3D GPU boards expose a selectable central chip. MIG
  compute instances form logical chip regions, with keyboard and touch controls.
  Their equal-area layout does not imply physical silicon placement or equal capacity.
- Optional Coder workspace attribution through Kubernetes DRA.
- Optional [per-owner CPU, RAM, and storage I/O charts](docs/workload-telemetry.md),
  including CPU-only workspaces, using independent cgroup v2 accounting.
- Explicit unavailable, stale, permission-denied, and error states—never fake zeros.
- GPU-connected process collection remains available through the API and CLI,
  with optional Coder workspace labels and no container-runtime socket.
- Twelve-hour bounded in-memory host and GPU history: the latest hour stays at
  collector cadence, while older 4h/12h views use gap-preserving compact trends.
  All dashboard views refresh every 0.5 seconds without changing host sampling.
- Ninety days of private local health observations that survive restarts,
  with explicit unknown periods, observation coverage, and separate host uptime.

## 🚀 Quick start

### Standalone monitoring

This one-line installer installs Leviathan and its updater for your current user:

```bash
curl -fsSL https://github.com/intellisys-stevens/leviathan/releases/latest/download/install.sh | sh
leviathan serve
```

Open [http://127.0.0.1:1397](http://127.0.0.1:1397). The installer uses
`~/.local/bin` without `sudo` and prints PATH guidance when needed. The updater
remains unconfigured until this host is connected to Yggdrasil. To install
only Leviathan, append `-s -- --without-updater` after `sh`.

No GPU is required for host monitoring. To preview GPU/MIG views with fixture
data:

```bash
leviathan --fixture blackwell serve
```

### Managed through Yggdrasil

1. In Yggdrasil, select the host and open **Install Leviathan and updater**.
2. Select the initial stable release and choose **Copy install command**.
3. Run the command on that host within 15 minutes, using root or sudo.

The command installs both components, generates configuration, enrolls the host,
starts the services, and reports readiness in Yggdrasil. No manual JSON, release
hashes, signing-key files, network ranges, Python or GitHub CLI are needed on
the host. A sudo password prompt may still appear.

An existing supported service keeps its version, user and configuration.
Adopting an existing preview requires the explicit checkbox in Yggdrasil; it
never downgrades the host. Repeat the same command to resume an interrupted
setup. Later version updates still require an explicit request in Yggdrasil.

This requires the setup endpoints and a compatible signed stable release.
See [managed installation](docs/managed-updates.md) for requirements, recovery
and the retained advanced installer flags.

## 🧭 Interfaces

| Command                                          | Purpose                                                    |
| ------------------------------------------------ | ---------------------------------------------------------- |
| `leviathan` or `leviathan tui`                   | Interactive terminal monitor                               |
| `leviathan snapshot -f table\|json`              | One current snapshot                                       |
| `leviathan watch -f table\|jsonl`                | Continuous scriptable output                               |
| `leviathan serve`                                | Local dashboard on `127.0.0.1:1397`                        |
| `leviathan doctor -f text\|json [--require-gpu]` | Capability and permission report; optionally require a GPU |
| `leviathan version`                              | Version, commit, and build time                            |

The TUI supports arrows or `j`/`k`, `Tab`, `/`, `Enter`, `p`, `?`, and `q`.
Use `NO_COLOR=1`, `--no-color`, or `--ascii` for terminal fallbacks.

## 🖥️ Browser workbench

| View        | What it shows                                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Overview    | CPU, RAM, unassigned GPU resources, and storage capacity; compact CPU/RAM and GPU charts followed by storage I/O or space usage  |
| Resources   | Interactive motherboard with CPU, RAM, and filesystem measurements; GPU boards with selectable MIG chip regions and assignment/activity indicators |
| Workloads | Per-owner CPU, RAM, GPU, and storage I/O telemetry; workspace assignments and integration status |
| Status | Yggdrasil connection and host/GPU telemetry, 90 days of minute observations, host uptime, monitor runtime, and diagnostic details |

GPU availability means resources without assignments in the configured workspace
integration. Allocated and reserved devices are excluded; incomplete or stale
observations stay explicit. It does not establish scheduler eligibility, quotas,
or how many additional users can be admitted. Unused VRAM is not free allocation
capacity. MIG capacity counts existing compute instances;
memory remains shared within each GPU instance.

Capacity cards share aligned rows and bottom bars. GPU metrics use the cyan gauge;
vendor marks identify devices in Resources, Workloads, and detail headers.
The mobile header exposes GitHub and the theme switch directly. Its View updates
popup keeps the hostname and connection state. The refresh rate is fixed at 0.5s
for every browser; older saved cadence preferences are ignored. Charts keep
collecting every sample while offscreen, but pause SVG redraws until they approach
the viewport or receive keyboard focus. Repeated unchanged measurements reuse the
existing chart data; no samples are skipped to achieve the display cadence.

Overview and Workloads charts share aligned, equal-height panels with single-row GPU legends.
Swipe the legend or use its arrow buttons to reach additional series; keyboard
Left/Right and Home/End move focus through them. Select a legend item to highlight
its series. Enlarged text can grow naturally.
Charts support direct tap and keyboard inspection (Left/Right, Home/End). Escape
or Live returns to current values.

Resources combines a motherboard on the left with all CPU, RAM, and Storage
measurements on the right; smaller screens stack the view above the measurements.
Select the CPU, RAM bank, or storage area to highlight its information, or use the
matching heading button. Zoom, Focus selected, and Reset control the view without
changing which measurements remain visible. CPU utilization and memory used
control cyan glow on a fixed 0–100% scale. Missing, estimated, or stale readings
use neutral styling. The board is illustrative: RAM modules represent aggregate
memory and the SSD-shaped storage area represents mounted filesystems, not an
observed inventory of slots or drives. Filesystem capacity, available space, and
the most-utilized mount remain visible beside the board.
Storage uses a compact summary and filesystem rows, with the fullest mount
marked inline.

GPU boards use locally bundled Three.js with
NVIDIA-green accents. Drag to rotate; use Zoom, Focus chip, or Reset view controls.
On phones, tap Interact to rotate or pinch, then Done to restore page scrolling.
Select a chip region or its keyboard-accessible button to open details. Hover or
focus shows assignment and shared GI telemetry, never fabricated per-CI memory.
A static board and the same inspection buttons remain available without WebGL
and in forced colors. Camera positions persist while navigating. Resources always
shows every GPU, including when opened from the Overview capacity tile.

Assigned chip regions and their badges use NVIDIA green; unassigned regions use
grey. Fresh SM activity increases the glow and adds a soft particle shimmer.
MIG regions use their shared GI activity, not inferred per-CI utilization. Idle
regions stay dim; unavailable readings remain distinct from zero in details.
Reserved resources use amber and unknown assignments use a dashed neutral badge.
Particles stop for stale data, hidden or offscreen views, and reduced motion.

Accumulated snow has 1–2 piles per panel, with varied heights and spacing. Each
page load generates fresh arrangements; polling, navigation, and resizing keep
them stable. Accumulation is decorative and follows the existing theme and
accessibility visibility preferences.

CPU, RAM, and storage bars show measured usage. The GPU bar shows the share of
existing allocation units that are assigned or reserved; its headline counts
unassigned resources. Partial readings stay labeled;
storage covers the persistent local filesystems visible to the collector.

Status reports **healthy observations** and **coverage**, not a service SLA.
Unknown periods are never filled as healthy or failed. Host uptime comes from
the Linux host; monitor runtime describes the current Leviathan process. See
[host monitoring](docs/host-monitoring.md#health) and
[local persistence setup](docs/deployment.md).

## 🛠️ Deployment

Leviathan deliberately binds to loopback. For SSH and Tailscale access,
user-scoped systemd installation, hardened host-wide process discovery, and
post-install verification, see the [deployment guide](docs/deployment.md).

## 🧩 Optional Coder attribution

Leviathan can display which Coder user/workspace has been assigned each full GPU
or MIG compute instance. The optional bridge publishes sanitized Kubernetes DRA
assignments without using a Coder token or container-runtime socket. An
assignment describes scheduler intent; it does not prove active GPU use.

See [Kubernetes and Coder attribution](docs/kubernetes-attribution.md) for setup,
prerequisites, RBAC, privacy, limits, and rollback.

## 🔐 Security and privacy

Leviathan is read-only, exposes no GPU mutation endpoint, and refuses
non-loopback dashboard addresses. Local metric history stays in memory; the optional
uplink sends only a sanitized machine observation. Command arguments are hidden
unless explicitly enabled. Review the [security and privacy model](docs/security-and-privacy.md),
[process permissions](docs/permissions.md), and [security policy](SECURITY.md)
before enabling host-wide or Kubernetes-integrated operation.

## ⚙️ Configuration

Precedence is CLI flag → `LEVIATHAN_*` environment variable → XDG TOML file →
default. See [the example configuration](docs/config.example.toml) or run
`leviathan <command> --help` for the complete reference.

Provider modes are `auto`, `nvml`, `dcgm`, and `fake`. Use `--no-profile` when a
profiler such as Nsight owns the profiling hardware. Configure the optional
Yggdrasil uploader through the `[uplink]` TOML block in the
[uplink guide](docs/uplink-v1.md); its bearer token remains in a private
credential file.

## 📚 Documentation

| Topic | Reference |
| --- | --- |
| Deployment and remote access | [docs/deployment.md](docs/deployment.md) |
| Architecture and metric semantics | [docs/architecture.md](docs/architecture.md) |
| Host CPU, RAM, and storage telemetry | [docs/host-monitoring.md](docs/host-monitoring.md) |
| Container and process visibility | [docs/permissions.md](docs/permissions.md) |
| Optional Kubernetes/Coder attribution | [docs/kubernetes-attribution.md](docs/kubernetes-attribution.md) |
| Yggdrasil telemetry uplink | [docs/uplink-v1.md](docs/uplink-v1.md) |
| Install and enroll the managed updater | [docs/managed-updates.md](docs/managed-updates.md) |
| Security and privacy model | [docs/security-and-privacy.md](docs/security-and-privacy.md) |
| v0.4.0 changes | [CHANGELOG.md](CHANGELOG.md) |
| Upgrade from v0.2.1 | [docs/migration-v0.3.md](docs/migration-v0.3.md) |
| OpenAPI 3.1 contract | [api/openapi.yaml](api/openapi.yaml) |
| Yggdrasil-owned uplink contract vendor | [api/uplink-v1-openapi.yaml](api/uplink-v1-openapi.yaml) |
| Development workflow | [CONTRIBUTING.md](CONTRIBUTING.md) |
| Security boundary | [SECURITY.md](SECURITY.md) |

## 🧑‍💻 Development

```bash
git clone https://github.com/intellisys-stevens/leviathan.git
cd leviathan
make bootstrap
make generate       # regenerate local API types and uplink DTOs
make test           # Go, race, vet, frontend, and license checks
make vulncheck      # Go and npm vulnerability checks
make soak           # accelerated collector soak
```

Release archives include Linux `amd64` and `arm64` binaries, the systemd
template and hardened root drop-in, checksums, SPDX SBOMs, provenance
attestations, and dependency notices.

## 📄 License

Leviathan is released under the [MIT License](LICENSE). Embedded fonts,
shadcn-derived components, and other dependencies retain their original
licenses; see [NOTICE](NOTICE) and [`licenses/`](licenses/).
