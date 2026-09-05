<div align="center">

<h1><img src="web/public/leviathan-mark.svg" alt="Leviathan frost-dragon mark" width="48" height="48" valign="middle"> Leviathan</h1>

**Whole-machine Linux monitoring with MIG-first NVIDIA GPU visibility.**

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
- Four-view browser workbench for Overview, Resources, Workloads, and Operations,
  with a mobile-native layout and accessible dark/light themes.
- Optional Coder workspace attribution through Kubernetes DRA.
- Explicit unavailable, stale, permission-denied, and error states—never fake zeros.
- GPU-connected processes visible in the current PID namespace, with optional
  Coder workspace labels and no container-runtime socket.
- Twelve-hour bounded in-memory host and GPU history: the latest hour stays at
  collector cadence, while older 4h/12h views use gap-preserving compact trends.
  Browser view updates are local to each operator and do not change host
  sampling.

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

| Command | Purpose |
| --- | --- |
| `leviathan` or `leviathan tui` | Interactive terminal monitor |
| `leviathan snapshot -f table\|json` | One current snapshot |
| `leviathan watch -f table\|jsonl` | Continuous scriptable output |
| `leviathan serve` | Local dashboard on `127.0.0.1:1397` |
| `leviathan doctor -f text\|json [--require-gpu]` | Capability and permission report; optionally require a GPU |
| `leviathan version` | Version, commit, and build time |

The TUI supports arrows or `j`/`k`, `Tab`, `/`, `Enter`, `p`, `?`, and `q`.
Use `NO_COLOR=1`, `--no-color`, or `--ascii` for terminal fallbacks.

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
non-loopback dashboard addresses. Local history stays in memory; the optional
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
