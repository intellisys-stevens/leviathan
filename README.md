<div align="center">

# MIGLens

**MIG-first NVIDIA GPU monitoring for the terminal and browser.**

[![CI](https://github.com/intellisys-stevens/miglens/actions/workflows/ci.yml/badge.svg)](https://github.com/intellisys-stevens/miglens/actions/workflows/ci.yml)
![Version](https://img.shields.io/badge/version-v0.1.0-14b8a6)
![Go](https://img.shields.io/badge/Go-1.27-00ADD8?logo=go&logoColor=white)
![Linux](https://img.shields.io/badge/Linux-amd64%20%7C%20arm64-334155?logo=linux&logoColor=white)
[![License: MIT](https://img.shields.io/badge/license-MIT-22c55e)](LICENSE)

</div>

MIGLens is a Linux-only, read-only monitor that understands the physical GPU →
GPU Instance (GI) → Compute Instance (CI) hierarchy. One Go binary includes an
interactive TUI, scriptable output, and a local React dashboard.

## ✨ Highlights

- MIG-aware topology, profiles, memory, activity, and parent-GPU telemetry.
- NVML GPM with optional DCGM fallback for supported per-GI counters.
- Explicit unavailable, stale, permission-denied, and error states—never fake zeros.
- GPU-connected processes visible in the current PID namespace, detected through
  NVIDIA UVM without host PID access or runtime sockets.
- One-hour in-memory history, smooth overview charts, and live `0.5s`, `1s`, or
  `2s` dashboard sampling.

## 🚀 Quick start

Requirements: Linux, Go 1.27+, Node.js 22.13+, and an NVIDIA driver exposing
`libnvidia-ml.so.1`. NVIDIA hardware is optional when using fixtures.

```bash
git clone https://github.com/intellisys-stevens/miglens.git
cd miglens
make bootstrap
make build

./bin/miglens doctor
./bin/miglens serve
```

Open [http://127.0.0.1:1397](http://127.0.0.1:1397). To explore without a GPU:

```bash
./bin/miglens --fixture blackwell serve
```

## 🧭 Interfaces

| Command | Purpose |
| --- | --- |
| `miglens` or `miglens tui` | Interactive terminal monitor |
| `miglens snapshot -f table\|json` | One current snapshot |
| `miglens watch -f table\|jsonl` | Continuous scriptable output |
| `miglens serve` | Local dashboard on `127.0.0.1:1397` |
| `miglens doctor -f text\|json` | Capability and permission report |
| `miglens version` | Version, commit, and build time |

The TUI supports arrows or `j`/`k`, `Tab`, `/`, `Enter`, `p`, `?`, and `q`.
Use `NO_COLOR=1`, `--no-color`, or `--ascii` for terminal fallbacks.

For remote access, keep MIGLens on loopback and use SSH tunnelling:

```bash
ssh -N -L 1397:127.0.0.1:1397 gpu-host.example
```

## 🔒 Providers and privacy

MIGLens uses NVML for discovery and device metrics, NVML GPM for supported
per-GI activity, and a local DCGM hostengine as an optional fallback. It never
parses `nvidia-smi` output and never mutates GPU configuration.

Process discovery reads numeric `/proc` entries and file-descriptor device
metadata only. Command arguments are hidden unless `--show-command-line` is
enabled. MIGLens does not read environments, contact external services, cross
PID namespaces, or require Docker, Kubernetes, or CRI sockets.

The dashboard refuses non-loopback addresses. Metrics remain in memory and are
discarded on restart.

## Configuration

Precedence is CLI flag → `MIGLENS_*` environment variable → XDG TOML file →
default. See [the example configuration](docs/config.example.toml) or run
`miglens <command> --help` for the complete reference.

Provider modes are `auto`, `nvml`, `dcgm`, and `fake`. Use `--no-profile` when a
profiler such as Nsight owns the profiling hardware.

## Documentation

| Topic | Reference |
| --- | --- |
| Architecture and metric semantics | [docs/architecture.md](docs/architecture.md) |
| Container and process visibility | [docs/permissions.md](docs/permissions.md) |
| OpenAPI 3.1 contract | [api/openapi.yaml](api/openapi.yaml) |
| Development workflow | [CONTRIBUTING.md](CONTRIBUTING.md) |
| Security boundary | [SECURITY.md](SECURITY.md) |

## Development

```bash
make generate       # regenerate Go and TypeScript API types
make test           # Go, race, vet, frontend, and license checks
make vulncheck      # Go and npm vulnerability checks
make soak           # accelerated collector soak
```

Release archives include Linux `amd64` and `arm64` binaries, checksums, SPDX
SBOMs, provenance attestations, and dependency notices.

## License

MIGLens is released under the [MIT License](LICENSE). Embedded fonts,
shadcn-derived components, and other dependencies retain their original
licenses; see [NOTICE](NOTICE) and [`licenses/`](licenses/).
