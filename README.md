# MIGLens

MIGLens is a Linux-only, read-only NVIDIA GPU monitor built around the real
MIG hierarchy: physical GPU → GPU Instance (GI) → Compute Instance (CI). It
ships as one Go executable with both an interactive terminal UI and an
embedded local browser dashboard.

MIGLens distinguishes unavailable telemetry from a real zero. Every metric
includes its provider, scope, sample time, and one of `available`,
`unsupported`, `permission_denied`, `stale`, or `error`.

> v0.1 is single-host software. It does not reconfigure GPUs, kill processes,
> persist metrics, bind publicly, contact an external service, or require
> cluster-wide Kubernetes API access.

## What it shows

- Physical GPUs plus the discovered GI/CI hierarchy and profiles.
- GI-scoped GPU activity, SM activity, occupancy, tensor, and DRAM activity
  when GPM or DCGM supports it—without copying shared counters onto multiple
  CIs.
- Parent-GPU temperature, power, and clocks, clearly labelled as physical-GPU
  scope.
- PID, user, executable, and start time for GPU-connected CUDA processes
  visible in MIGLens' current Linux PID namespace.
- A bounded in-memory history window, one hour by default.
- Explicit degraded and permission states plus concrete `miglens doctor`
  remedies.

## Requirements

- Linux on `amd64` or `arm64`.
- An NVIDIA driver exposing `libnvidia-ml.so.1` for live monitoring.
- Hopper, Blackwell, or another GPM-capable device for NVML GPM counters; a
  local DCGM hostengine can fill supported per-MIG counters on other devices.
- No NVIDIA hardware is needed for development with `--provider fake`.

Releases contain executable archives with licenses and dependency notices,
plus SPDX SBOMs, provenance attestations, and SHA-256 checksums. To build from
source, install Go 1.27+ and Node.js 22.13+.

## Build from source

```bash
git clone https://github.com/miglens/miglens.git
cd miglens
make bootstrap
make test
make build
./bin/miglens doctor
```

The frontend is compiled first into `internal/webui/dist`; `go:embed` then
places it inside `bin/miglens`. End users do not need Node.js or a separate web
server.

## Commands

```text
miglens                         interactive TUI (same as `miglens tui`)
miglens snapshot -f table      one canonical snapshot
miglens snapshot -f json       one canonical JSON snapshot
miglens watch -f table         continuously render tables
miglens watch -f jsonl         newline-delimited snapshots for scripts
miglens serve                  dashboard on http://127.0.0.1:1397
miglens doctor -f text         capability and permission report
miglens doctor -f json         machine-readable diagnostic report
miglens version                version, commit, and build time
```

Sampling defaults to one second. Valid intervals range from 250 ms through 60
seconds. Run `miglens --help` or `miglens <command> --help` for all flags.

The TUI supports arrows or `j`/`k`, `Tab`, `/`, `Enter`, `p`, `?`, and `q`.
`NO_COLOR=1`, `--no-color`, and `--ascii` provide terminal fallbacks.

## Local dashboard and SSH tunnelling

`miglens serve` refuses every non-loopback address in v0.1. From another
machine, tunnel the loopback port instead of exposing it:

```bash
# Run on the GPU host
miglens serve

# Run on the workstation, then open http://127.0.0.1:1397
ssh -N -L 1397:127.0.0.1:1397 gpu-host.example
```

The one-route dashboard has dark and light themes, equal-width MIG instance
cards, searchable GPU-process rows, a GI/CI detail drawer, live SSE updates,
and four overview charts for temperature, GPU activity, memory, and SM
activity. Select a `5m`, `15m`, `30m`, or `1h` view and change the live
sampling cadence between `0.5s`, `1s`, and `2s` from the joined live-status
control in the header. Chart values use a trailing five-second average for
readability; raw samples remain unchanged. All JavaScript, CSS, icons, and
fonts are local.

## Provider behavior

MIGLens uses a fixed precedence ladder:

1. NVML discovers physical GPUs and the MIG hierarchy, memory, profiles, and
   parent metrics.
2. NVML GPM supplies supported per-GI profiling counters.
3. A dynamically detected local DCGM fills counters that remain unavailable.

An available GPM value wins over DCGM for the same canonical metric. An
unavailable high-priority value does not hide an available lower-priority
value. MIGLens never parses `nvidia-smi` output.

Use `--provider auto` (default), `nvml`, `dcgm`, or `fake`. `--no-profile`
disables GPM/DCGM counters, which is useful when Nsight owns the profiling
hardware. `--provider nvml` disables DCGM while retaining GPM unless
`--no-profile` is also set.

## GPU processes and privacy

MIGLens enumerates numeric entries in its current `/proc` view and keeps only
processes whose file-descriptor metadata points to the same device identity as
`/dev/nvidia-uvm`. An open UVM handle means GPU-connected, including an idle
CUDA context; it does not claim active kernels, GPU memory use, or a particular
GPU, GI, or CI. MIGLens itself is excluded. It does not ask NVML for host GPU
PIDs and does not cross PID namespaces.

By default, each row contains PID, user, executable path with `comm` fallback,
and start time. Full arguments are omitted unless `--show-command-line` is
explicitly enabled. MIGLens never reads process environments, cgroup identity,
container metadata, pod metadata, labels, or runtime sockets. A workspace with
zero GPU clients is healthy. Process lists are current-snapshot data and are
not retained in metric history.

## Configuration

Precedence is CLI flag → `MIGLENS_*` environment variable → TOML file →
default. The default file is `$XDG_CONFIG_HOME/miglens/config.toml`, falling
back to `~/.config/miglens/config.toml`. Override it with `--config` or
`MIGLENS_CONFIG`.

```toml
interval = "1s"
history_window = "1h"
topology_interval = "10s"
provider = "auto"
dcgm_address = "127.0.0.1:5555"
show_command_line = false
no_profile = false
listen = "127.0.0.1:1397"
no_color = false
ascii = false
```

Every setting also has an uppercase `MIGLENS_` form, for example
`MIGLENS_HISTORY_WINDOW`, `MIGLENS_DCGM_ADDRESS`, and
`MIGLENS_SHOW_COMMAND_LINE`. See `docs/config.example.toml` for the complete
reference.

## Permissions and `doctor`

Run MIGLens as the intended unprivileged user. Do not paper over missing
visibility by running the monitor with unrestricted `sudo`.

```bash
miglens doctor
```

The report checks NVML discovery, GPM support, MIG memory, optional DCGM,
`/dev/nvidia-uvm`, and file-descriptor inspection in the current `/proc`
namespace. A container-local PID 1 and zero GPU clients are healthy. MIGLens
does not require `hostPID`, runtime sockets, `/dev/nvidia-caps/nvidia-cap2`, or
privileged mode. See [Container permissions](docs/permissions.md) for the
resulting boundary.

## HTTP API

The OpenAPI 3.1 contract is `api/openapi.yaml`. Go wire types and TypeScript
client types are generated from it.

```text
GET /api/v1/snapshot
GET /api/v1/history?entity=<uuid>&metrics=sm_activity,dram_activity&window=5m
GET /api/v1/events
GET /api/v1/capabilities
GET /api/v1/settings
PATCH /api/v1/settings
GET /api/v1/version
GET /healthz
```

Times are RFC 3339, byte counts are integers, percentages are normalized to
0–100, and missing values are JSON `null`. The SSE endpoint emits named
`snapshot` events with sequence IDs plus `settings` events for dashboard-tab
synchronization. It immediately sends the current snapshot and effective
runtime settings after a reconnect. `PATCH /api/v1/settings` accepts only the
three dashboard sampling choices, changes process-local cadence for this run,
and never writes the configuration file. The version endpoint reports the
immutable version, commit, and build date embedded in the running binary.

## Deterministic fixtures

Use fixtures to develop every degraded state without NVIDIA hardware:

```bash
miglens --fixture blackwell serve
miglens --fixture multi-ci snapshot -f json
miglens --fixture permission-denied tui
```

Available scenarios are `blackwell`, `hopper-gpm`, `a100-dcgm`, `non-mig`,
`multi-ci`, `no-gpus`, `missing-libraries`, `permission-denied`,
`stale`, and `reconfiguration`.

## Development and verification

```bash
make generate        # OpenAPI Go and TypeScript types
make frontend        # audit, lint, component-test, and rebuild embedded assets
make test            # Go tests, race checks, vet, frontend checks, licenses
make vulncheck       # Go vulnerability database + npm audit
make soak            # accelerated bounded-history/goroutine soak
MIGLENS_SOAK=1 make soak-one-hour
```

Tests cover metric precedence, partial and wholly blank GPM samples,
unavailable states, multi-CI GI scope, bounded history under topology churn,
current-namespace UVM process detection, PID churn and reuse, command-line
redaction, `gpu_activity` precedence, overview history merging/downsampling,
five-second smoothing at every offered cadence, dynamic interval rescheduling,
reconfiguration generations, immediate retry/stale snapshots, JSON/JSONL, SSE
reconnects/settings synchronization, loopback enforcement, and TUI view/key
snapshots.

See `docs/architecture.md` for data flow and invariants, `CONTRIBUTING.md` for
the development workflow, and `SECURITY.md` for the security boundary.

## License

Apache-2.0. Embedded font and UI notices are listed in `NOTICE` and
`licenses/`. Release SBOMs enumerate compiled dependencies. MIGLens is a
working project name and not a statement of trademark clearance.
