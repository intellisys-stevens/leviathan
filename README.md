<div align="center">

<h1><img src="web/public/miglens-mark.png" alt="MIGLens dragon mark" width="48" height="48" valign="middle"> MIGLens</h1>

**MIG-first NVIDIA GPU monitoring for the terminal and browser.**

[![CI](https://github.com/intellisys-stevens/miglens/actions/workflows/ci.yml/badge.svg)](https://github.com/intellisys-stevens/miglens/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/intellisys-stevens/miglens?display_name=tag&color=14b8a6)](https://github.com/intellisys-stevens/miglens/releases/latest)
![Go](https://img.shields.io/badge/Go-1.27-00ADD8?logo=go&logoColor=white)
![Linux](https://img.shields.io/badge/Linux-amd64%20%7C%20arm64-334155?logo=linux&logoColor=white)
[![License: MIT](https://img.shields.io/badge/license-MIT-22c55e)](LICENSE)

</div>

MIGLens is a Linux-only, read-only monitor that understands the physical GPU →
GPU Instance (GI) → Compute Instance (CI) hierarchy. One Go binary includes an
interactive TUI, scriptable output, and a local React dashboard; an optional
Kubernetes bridge adds scheduler-authoritative workspace assignments. The
separate `miglens-hub` process can add a read-only Jetstream fleet view without
changing or replacing any existing single-host deployment.

## ✨ Highlights

- MIG-aware topology, profiles, memory, activity, and parent-GPU telemetry.
- NVML GPM with optional DCGM fallback, including exact PCIe transfer rates.
- GPU and People perspectives, with optional Coder workspace attribution through
  Kubernetes DRA.
- Explicit unavailable, stale, permission-denied, and error states—never fake zeros.
- GPU-connected processes visible in the current PID namespace, detected through
  NVIDIA UVM without host PID access or runtime sockets.
- One-hour in-memory history with continuous, timestamp-aligned overview charts,
  plus live `0.5s`, `1s`, or `2s` sampling and independently throttled profiling
  and process scans.

## 🚀 Quick start

```bash
curl -fsSL https://github.com/intellisys-stevens/miglens/releases/latest/download/install.sh | sh
miglens serve
```

Open [http://127.0.0.1:1397](http://127.0.0.1:1397). The installer uses
`~/.local/bin` without `sudo` and prints PATH guidance when needed.

No GPU available? Preview the dashboard with fixture data:

```bash
miglens --fixture blackwell serve
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
| `miglens-hub --config hub.toml inventory` | Sanitized, project-scoped Jetstream inventory |
| `miglens-hub --config hub.toml serve` | Fleet dashboard on `127.0.0.1:1398/fleet` |

The TUI supports arrows or `j`/`k`, `Tab`, `/`, `Enter`, `p`, `?`, and `q`.
Use `NO_COLOR=1`, `--no-color`, or `--ascii` for terminal fallbacks.

For remote access, keep MIGLens on loopback and use SSH tunnelling:

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
sudo install -m 0755 miglens /usr/local/bin/miglens
sudo install -m 0644 miglens@.service /etc/systemd/system/miglens@.service
sudo install -D -m 0644 miglens.env.example /etc/miglens/miglens.env
sudo systemctl daemon-reload
sudo systemctl enable --now "miglens@${USER}.service"
```

This limits process discovery to workloads that user can inspect.

For host-wide process discovery, install the packaged hardened root drop-in and
switch instances:

```bash
sudo install -D -m 0644 \
  miglens@root.service.d/10-hardening.conf \
  /etc/systemd/system/miglens@root.service.d/10-hardening.conf
sudo systemctl daemon-reload
sudo systemctl disable --now "miglens@${USER}.service"
sudo systemctl enable --now miglens@root.service
```

Root mode makes cross-user process metadata visible to every dashboard viewer;
command lines stay hidden unless explicitly enabled. See
[permissions](docs/permissions.md#hardened-host-wide-root-mode) for details.

## Optional Coder attribution

MIGLens can display which Coder user/workspace has been assigned each full GPU
or MIG compute instance. A least-privilege bridge reads Kubernetes DRA claims
and publishes sanitized assignments over a root-only Unix socket; it does not
use a Coder token, container-runtime socket, or process inference.

The GPU perspective organizes host-wide topology and telemetry by device. The
People perspective groups scheduler assignments by Coder user and workspace.
An assignment means reserved or allocated by the scheduler, not active GPU use;
charts and the process inventory remain host-wide, and process rows are not
attributed to workspaces.

Install the versioned Helm chart published with the release:

```bash
helm upgrade --install miglens-attribution \
  oci://ghcr.io/intellisys-stevens/charts/miglens-attribution \
  --version 0.2.0 \
  --namespace miglens-system \
  --create-namespace \
  --set-json 'workspaceNamespaces=["coder-workspaces"]'
```

Then set
`MIGLENS_ATTRIBUTION_SOCKET=/run/miglens/attribution.sock` in the systemd
environment file. See [Kubernetes attribution](docs/kubernetes-attribution.md)
for Kubernetes 1.34 and NVIDIA DRA prerequisites, RBAC, privacy, and failure
behavior.

## Optional Jetstream fleet controller

`miglens` and `miglens-hub` are independent processes. The local `miglens`
agent continues to own one host's NVML/DCGM collection and unchanged
`/api/v1/*` API. `miglens-hub` does not start a GPU collector; it reads a
project-scoped OpenStack inventory and, only for explicitly approved active
instances, reads an existing agent's snapshot and version over HTTPS.

The fleet dashboard presents Nidhogg and Jetstream as peers. The configured
Nidhogg entry is a credential-free HTTPS link to the existing dashboard; the
hub does not proxy, replace, or modify the Nidhogg entry or API.

Hub configuration is fail-closed. It requires exact OpenStack project, identity
host, and compute host allowlists. Each test-enabled instance must also match
one exact lowercase UUID and creator username pair; wildcards are rejected.
Instances discovered outside that list remain inventory-only and receive no
agent request. OpenStack credentials are accepted only through standard `OS_*`
environment variables and never through the non-secret TOML file.

See [Jetstream fleet controller](docs/jetstream-fleet.md) for the three-layer
model, synthetic configuration, credential handling, and commands.

## 🔒 Providers and privacy

MIGLens uses NVML for discovery and device metrics, NVML GPM for supported
per-GI activity, and a local DCGM hostengine as an optional fallback. It never
parses `nvidia-smi` output and never mutates GPU configuration.

The local agent's process discovery reads numeric `/proc` entries and
file-descriptor device metadata only. Command arguments are hidden unless
`--show-command-line` is enabled. The local agent does not read environments,
contact external services, cross PID namespaces, or require Docker,
Kubernetes, or CRI sockets. Kubernetes is contacted only by the explicitly
installed attribution bridge. The separate hub's bounded HTTPS destinations
are documented in [SECURITY.md](SECURITY.md#jetstream-fleet-controller).

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
| Optional Kubernetes/Coder attribution | [docs/kubernetes-attribution.md](docs/kubernetes-attribution.md) |
| Optional Jetstream fleet controller | [docs/jetstream-fleet.md](docs/jetstream-fleet.md) |
| OpenAPI 3.1 contract | [api/openapi.yaml](api/openapi.yaml) |
| Development workflow | [CONTRIBUTING.md](CONTRIBUTING.md) |
| Security boundary | [SECURITY.md](SECURITY.md) |

## Development

```bash
git clone https://github.com/intellisys-stevens/miglens.git
cd miglens
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

MIGLens is released under the [MIT License](LICENSE). Embedded fonts,
shadcn-derived components, and other dependencies retain their original
licenses; see [NOTICE](NOTICE) and [`licenses/`](licenses/).
