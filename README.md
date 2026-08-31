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
GPU Instance (GI) → Compute Instance (CI) hierarchy. The primary Go binary
includes an interactive TUI, scriptable output, and a local React dashboard; an
optional Kubernetes bridge adds scheduler-authoritative workspace assignments.
The separate `leviathan-hub` process can add a cloud-read-only Jetstream fleet
view without changing or replacing any existing single-host deployment.

## ✨ Highlights

- MIG-aware topology, profiles, memory, activity, and parent-GPU telemetry.
- NVML GPM with optional DCGM fallback, including exact PCIe transfer rates.
- Four-view browser workbench for Overview, Resources, Workloads, and Operations,
  with a mobile-native layout and accessible dark/light themes.
- Optional Coder workspace attribution through Kubernetes DRA.
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
| `leviathan uplink --hub-url https://…` | Push full snapshots outbound to an authenticated Hub |
| `leviathan doctor -f text\|json` | Capability and permission report |
| `leviathan version` | Version, commit, and build time |
| `leviathan-hub --config hub.toml inventory` | Sanitized, project-scoped Jetstream inventory |
| `leviathan-hub --config hub.toml serve` | Yggdrasill platform dashboard on `127.0.0.1:1398/platforms` |

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

## Optional Jetstream fleet controller

`leviathan` and `leviathan-hub` are independent processes. The local
`leviathan` agent continues to own one host's NVML/DCGM collection and unchanged
`/api/v1/*` API. `leviathan-hub` does not start a GPU collector; it reads a
project-scoped OpenStack inventory and accepts telemetry only for explicitly
approved active instances. Instances can push full snapshots outbound to one
Hub, so they do not each need a Tailnet address or inbound agent port. A
strictly bounded Exosphere console record provides coarse GPU-utilization
fallback when no full snapshot is available.

The Hub keeps those surfaces on separate loopback listeners: the dashboard and
read APIs use the private `listen` address, while an enabled uplink uses
`uplink.listen` and exposes only the authenticated snapshot POST. Publish the
dashboard only inside the operator Tailnet. If instances need a public HTTPS
ingress, point that ingress exclusively at the uplink listener; never publish
the dashboard listener through it.

The Yggdrasill fleet dashboard presents Nidhogg and Jetstream as peers. The
configured Nidhogg entry is a credential-free HTTPS link to the existing
dashboard; the hub does not proxy, replace, or modify the Nidhogg entry or API.

Hub configuration is fail-closed. It requires exact OpenStack project,
identity-host, compute-host, and authoritative Nova creator-ID allowlists;
wildcards are rejected. Existing exact UUID bindings still take precedence,
while creator rules dynamically cover current and future instances. Uplink
tokens are creator-scoped, named in TOML but loaded only from environment
variables, and checked again against current Nova inventory before acceptance.
Instances outside those rules remain inventory-only. OpenStack credentials are
accepted only through standard `OS_*` environment variables.

An uplink token authenticates one Nova creator trust domain, not an individual
VM. A holder can claim another active, eligible VM owned by that creator, and a
metadata-service UUID is routing input rather than instance attestation. Uplink
is default-off and limited to explicitly approved pilots; its telemetry alone
must not drive security, billing, scheduling, or incident attribution.

See [Jetstream fleet controller](docs/jetstream-fleet.md) for source
precedence, synthetic configuration, credential handling, and commands.

## 🔒 Providers and privacy

Leviathan uses NVML for discovery and device metrics, NVML GPM for supported
per-GI activity, and a local DCGM hostengine as an optional fallback. It never
parses `nvidia-smi` output and never mutates GPU configuration.

The local agent's process discovery reads numeric `/proc` entries and
file-descriptor device metadata. When attribution is enabled, it also reads
matched clients' cgroup paths for a one-way workspace join. Command arguments
are hidden unless `--show-command-line` is enabled. The local agent does not
read process environments, contact external services unless the explicit
`leviathan uplink` command is selected, cross PID namespaces, or require Docker,
Kubernetes, or CRI sockets. Kubernetes is contacted only by the explicitly
installed attribution bridge. The separate hub's bounded HTTPS
destinations are documented in
[SECURITY.md](SECURITY.md#jetstream-fleet-controller).

The dashboard uses concise GPU/GI/CI numbers in normal views and reserves
shortened hardware identifiers for Diagnostics. Exact UUIDs remain available in
the API for stable history and attribution joins.

The dashboard refuses non-loopback addresses. Metrics remain in memory and are
discarded on restart.

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
| Optional Jetstream fleet controller | [docs/jetstream-fleet.md](docs/jetstream-fleet.md) |
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

Release archives include Linux `amd64` and `arm64` `leviathan` and
`leviathan-hub` binaries, the local and optional uplink systemd templates, the
hardened root drop-in, checksums, SPDX SBOMs, provenance attestations, and
dependency notices.

## 📄 License

Leviathan is released under the [MIT License](LICENSE). Embedded fonts,
shadcn-derived components, and other dependencies retain their original
licenses; see [NOTICE](NOTICE) and [`licenses/`](licenses/).
