<div align="center">

<h1><img src="web/public/leviathan-mark.svg" alt="Leviathan frost-dragon mark" width="48" height="48" valign="middle"> Leviathan</h1>

**MIG-first NVIDIA GPU monitoring for the terminal and browser.**

[![CI](https://github.com/intellisys-stevens/leviathan/actions/workflows/ci.yml/badge.svg)](https://github.com/intellisys-stevens/leviathan/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/intellisys-stevens/leviathan?display_name=tag&color=14b8a6)](https://github.com/intellisys-stevens/leviathan/releases/latest)
![Go](https://img.shields.io/badge/Go-1.27-00ADD8?logo=go&logoColor=white)
![Linux](https://img.shields.io/badge/Linux-amd64%20%7C%20arm64-334155?logo=linux&logoColor=white)
[![License: MIT](https://img.shields.io/badge/license-MIT-22c55e)](LICENSE)

</div>

Leviathan is a Linux-only, read-only monitor that understands the physical GPU →
GPU Instance (GI) → Compute Instance (CI) hierarchy. One Go binary includes an
interactive TUI, scriptable output, and a local React dashboard; an optional
Kubernetes bridge adds scheduler-authoritative workspace assignments.

## ✨ Highlights

- MIG-aware topology, profiles, memory, activity, and parent-GPU telemetry.
- NVML GPM with optional DCGM fallback, including exact PCIe transfer rates.
- Four-view browser workbench for Overview, Resources, Workloads, and Operations,
  with a mobile-native layout and accessible dark/light themes.
- Optional Coder workspace attribution through Kubernetes DRA.
- Explicit unavailable, stale, permission-denied, and error states—never fake zeros.
- GPU-connected processes visible in the current PID namespace, with optional
  Coder workspace labels and no container-runtime socket.
- Twelve-hour bounded in-memory history: the latest hour stays at collector
  cadence, while older 4h/12h views use gap-preserving compact trends. Browser
  view updates are local to each operator and do not change host sampling.

## 🚀 Quick start

```bash
curl -fsSL https://github.com/intellisys-stevens/leviathan/releases/latest/download/install.sh | sh
leviathan serve
```

Open [http://127.0.0.1:1397](http://127.0.0.1:1397). The installer uses
`~/.local/bin` without `sudo` and prints PATH guidance when needed.

No GPU available? Preview the dashboard with fixture data:

```bash
leviathan --fixture blackwell serve
```

## 🧭 Interfaces

| Command | Purpose |
| --- | --- |
| `leviathan` or `leviathan tui` | Interactive terminal monitor |
| `leviathan snapshot -f table\|json` | One current snapshot |
| `leviathan watch -f table\|jsonl` | Continuous scriptable output |
| `leviathan serve` | Local dashboard on `127.0.0.1:1397` |
| `leviathan doctor -f text\|json` | Capability and permission report |
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

Leviathan is read-only, exposes no GPU mutation endpoint, refuses non-loopback
dashboard addresses, and keeps telemetry in memory. Command arguments are hidden
unless explicitly enabled. Review the [security and privacy model](docs/security-and-privacy.md),
[process permissions](docs/permissions.md), and [security policy](SECURITY.md)
before enabling host-wide or Kubernetes-integrated operation.

## ⚙️ Configuration

Precedence is CLI flag → `LEVIATHAN_*` environment variable → XDG TOML file →
default. See [the example configuration](docs/config.example.toml) or run
`leviathan <command> --help` for the complete reference.

Provider modes are `auto`, `nvml`, `dcgm`, and `fake`. Use `--no-profile` when a
profiler such as Nsight owns the profiling hardware.

## 📚 Documentation

| Topic | Reference |
| --- | --- |
| Deployment and remote access | [docs/deployment.md](docs/deployment.md) |
| Architecture and metric semantics | [docs/architecture.md](docs/architecture.md) |
| Container and process visibility | [docs/permissions.md](docs/permissions.md) |
| Optional Kubernetes/Coder attribution | [docs/kubernetes-attribution.md](docs/kubernetes-attribution.md) |
| Security and privacy model | [docs/security-and-privacy.md](docs/security-and-privacy.md) |
| Upgrade from v0.2.1 | [docs/migration-v0.3.md](docs/migration-v0.3.md) |
| OpenAPI 3.1 contract | [api/openapi.yaml](api/openapi.yaml) |
| Development workflow | [CONTRIBUTING.md](CONTRIBUTING.md) |
| Security boundary | [SECURITY.md](SECURITY.md) |

## 🧑‍💻 Development

```bash
git clone https://github.com/intellisys-stevens/leviathan.git
cd leviathan
make bootstrap
make generate       # regenerate Go and TypeScript API types
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
