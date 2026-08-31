<div align="center">

<h1><img src="web/public/leviathan-mark.svg" alt="Leviathan world-serpent mark" width="48" height="48" valign="middle"> Leviathan</h1>

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
- GPU and People perspectives, with optional Coder workspace attribution through
  Kubernetes DRA.
- Explicit unavailable, stale, permission-denied, and error states—never fake zeros.
- GPU-connected processes visible in the current PID namespace, with optional
  Coder workspace labels and no container-runtime socket.
- One-hour in-memory history with continuous, timestamp-aligned overview charts,
  plus live `0.5s`, `1s`, or `2s` sampling and independently throttled profiling
  and process scans.

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

For remote access, keep Leviathan on loopback and use SSH tunnelling:

```bash
ssh -N -L 1397:127.0.0.1:1397 gpu-host.example
```

Tailscale users can publish the same loopback service privately on the
tailnet's standard HTTPS port:

```bash
sudo tailscale serve --yes --bg --https=443 http://127.0.0.1:1397
```

### systemd

Release archives include a service template. Install it with the binary, then
start an instance named for the GPU workload user:

```bash
sudo install -m 0755 leviathan /usr/local/bin/leviathan
sudo install -m 0644 leviathan@.service /etc/systemd/system/leviathan@.service
sudo install -D -m 0644 leviathan.env.example /etc/leviathan/leviathan.env
sudo systemctl daemon-reload
sudo systemctl enable --now "leviathan@${USER}.service"
```

This limits process discovery to workloads that user can inspect.

For host-wide process discovery, install the packaged hardened root drop-in and
switch instances:

```bash
sudo install -D -m 0644 \
  leviathan@root.service.d/10-hardening.conf \
  /etc/systemd/system/leviathan@root.service.d/10-hardening.conf
sudo systemctl daemon-reload
sudo systemctl disable --now "leviathan@${USER}.service"
sudo systemctl enable --now leviathan@root.service
```

Root mode makes cross-user process metadata visible to every dashboard viewer;
command lines stay hidden unless explicitly enabled. See
[permissions](docs/permissions.md#hardened-host-wide-root-mode) for details.

## Optional Coder attribution

Leviathan can display which Coder user/workspace has been assigned each full GPU
or MIG compute instance. A least-privilege bridge reads Kubernetes DRA claims
and publishes sanitized assignments over a root-only Unix socket; it does not
use a Coder token or container-runtime socket and does not inspect host
processes.

The GPU perspective organizes host-wide topology and telemetry by device. The
People perspective groups scheduler assignments by Coder user and workspace.
Leviathan can label a detected GPU client with its workspace by joining the
process cgroup to sanitized claim metadata; this identifies workspace
membership, not active GPU use or a particular GPU, GI, or CI.

Install the versioned Helm chart published with the release:

```bash
helm upgrade --install leviathan-attribution \
  oci://ghcr.io/intellisys-stevens/charts/leviathan-attribution \
  --version 0.3.0 \
  --namespace leviathan-system \
  --create-namespace \
  --set-json 'workspaceNamespaces=["coder-workspaces"]'
```

Then set
`LEVIATHAN_ATTRIBUTION_SOCKET=/run/leviathan/attribution.sock` in the systemd
environment file. See [Kubernetes attribution](docs/kubernetes-attribution.md)
for Kubernetes 1.34 and NVIDIA DRA prerequisites, RBAC, privacy, and failure
behavior.

## 🔒 Providers and privacy

Leviathan uses NVML for discovery and device metrics, NVML GPM for supported
per-GI activity, and a local DCGM hostengine as an optional fallback. It never
parses `nvidia-smi` output and never mutates GPU configuration.

Process discovery reads numeric `/proc` entries and file-descriptor device
metadata. When attribution is enabled, it also reads matched clients' cgroup
paths for a one-way workspace join. Command arguments are hidden unless
`--show-command-line` is enabled. Leviathan does not read environments, contact
external services, cross PID namespaces, or require Docker, Kubernetes, or CRI
sockets. Kubernetes is contacted only by the explicitly installed bridge.

The dashboard uses concise GPU/GI/CI numbers in normal views and reserves
shortened hardware identifiers for Diagnostics. Exact UUIDs remain available in
the API for stable history and attribution joins.

The dashboard refuses non-loopback addresses. Metrics remain in memory and are
discarded on restart.

## Configuration

Precedence is CLI flag → `LEVIATHAN_*` environment variable → XDG TOML file →
default. See [the example configuration](docs/config.example.toml) or run
`leviathan <command> --help` for the complete reference.

Provider modes are `auto`, `nvml`, `dcgm`, and `fake`. Use `--no-profile` when a
profiler such as Nsight owns the profiling hardware.

## Documentation

| Topic | Reference |
| --- | --- |
| Architecture and metric semantics | [docs/architecture.md](docs/architecture.md) |
| Container and process visibility | [docs/permissions.md](docs/permissions.md) |
| Optional Kubernetes/Coder attribution | [docs/kubernetes-attribution.md](docs/kubernetes-attribution.md) |
| Upgrade from v0.2.1 | [docs/migration-v0.3.md](docs/migration-v0.3.md) |
| OpenAPI 3.1 contract | [api/openapi.yaml](api/openapi.yaml) |
| Development workflow | [CONTRIBUTING.md](CONTRIBUTING.md) |
| Security boundary | [SECURITY.md](SECURITY.md) |

## Development

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

## License

Leviathan is released under the [MIT License](LICENSE). Embedded fonts,
shadcn-derived components, and other dependencies retain their original
licenses; see [NOTICE](NOTICE) and [`licenses/`](licenses/).
