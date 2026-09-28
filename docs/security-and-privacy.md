# 🔐 Security and privacy

The Leviathan monitor reads Linux telemetry within its Unix user, PID namespace,
device, and filesystem permissions. Optional bridges and the separate privileged
updater have their own permissions; monitoring access does not grant update access.

## 🧭 Operating boundary

Leviathan:

- refuses non-loopback dashboard addresses;
- exposes no GPU mutation endpoint;
- never parses `nvidia-smi` output or changes GPU/MIG configuration;
- makes no outbound network request unless the administrator explicitly enables
  the Yggdrasil uplink;
- requires no Docker, containerd, CRI, or other runtime socket;
- does not request or elevate its own privileges.

Host discovery and metrics read procfs, mountinfo, statfs, and diskstats. GPU
discovery uses NVML, supported NVML GPM counters, and an optional local DCGM
hostengine. Exact GPU identifiers remain available to the loopback API for
stable history and attribution joins, while ordinary dashboard views favor
concise GPU/GI/CI numbers.

## 🧠 Telemetry and retention

Host, GPU, and optional owner samples and local chart history remain in memory and are discarded
on restart.
By default the latest hour is retained at collector cadence and older data is
held as bounded, gap-preserving aggregate trends for up to twelve hours.
Unavailable, stale, permission-denied, and failed measurements remain explicit;
Leviathan does not substitute fabricated zeros.

`serve` also retains one telemetry health observation per UTC minute for ninety
UTC dates, including today. This separate journal contains only timestamps and
component states; it never stores process, user, workspace, device, or diagnostic
details. Host uptime is read separately from `/proc/uptime`; monitor runtime uses
the process monotonic clock so clock corrections cannot alter elapsed time. The status panel's
healthy-observation percentage excludes unknown and unsupported samples, with
observation coverage reported separately. It is not external service availability
or an uptime SLA, and outages between minute samples may be missed.

Journals use private `0700` directories and `0600` regular files with a single
writer lock. They survive restart, preserve unobserved minutes as unknown, and
remove expired daily files. The default directory is
`$XDG_STATE_HOME/leviathan/health-v1` or `~/.local/state/leviathan/health-v1`.
Disable saving with `--health-history=false`; fake providers and fixtures always
keep observations in memory. A storage failure leaves live monitoring available
and is exposed by `/api/v1/status` as `persistence.saving=false`. Correct the
reported storage issue and restart to resume saving. Local health history is
never added to the Yggdrasil uplink contract.

The browser API is loopback-only and returns security headers that deny framing,
cross-origin dependencies, and active third-party content. An SSH or Tailnet
proxy should remain private to trusted operators.

## ⬆️ Yggdrasil uplink

When enabled, the in-process uploader sends only the newest sanitized
observation to one configured credential-free HTTPS origin. It does not retain
an offline queue, follow redirects, use ambient proxies or cookies, or accept a
remote command. The token is loaded from a private regular file for each request
so an atomic rotation does not require a process restart.

The independent uplink contract excludes processes, users, command lines,
workload attribution, PCI bus IDs, block-device paths, filesystem UUIDs, metric
error messages, and raw diagnostic detail. Filesystem identifiers are rehashed
before upload. A strict 8 MiB encoded-body limit and five-second request timeout
bound each attempt; failures use latest-only retry with capped backoff.

The hardened root service continues to deny non-loopback networking unless the
administrator installs the opt-in uplink drop-in. That drop-in should allow only
Yggdrasil's fixed ingress IP or narrow CIDR and uses a systemd credential rather
than TOML, environment, or command-line token material. See
[Yggdrasil Uplink v1](uplink-v1.md).

## 🧑‍💻 Process visibility

Process discovery reads numeric `/proc` entries and file-descriptor device
metadata for GPU-connected clients in the current PID namespace. It does not
read process environments. Full command arguments remain hidden unless
`--show-command-line` is explicitly enabled.

Running directly on a host, with `hostPID: true`, or through the packaged root
service intentionally expands the visible process inventory. Root mode can
expose cross-user PID, Unix user, executable, start-time, and status metadata to
every dashboard viewer. See [Container and workspace permissions](permissions.md)
for the exact capability and visibility model.

## ☸️ Kubernetes and Coder attribution

The optional bridge is a separate trust boundary. It reads NVIDIA
ResourceSlices and Coder-labeled ResourceClaims through least-privilege
Kubernetes RBAC, then publishes sanitized assignments over a root-only Unix
socket. The host service receives no Kubernetes credential and does not read
Pods, Secrets, logs, exec data, or container-runtime metadata.

The unreleased source chart enables aggregate GPU capacity by default. Its
separate inventory reads ResourceClaims across all namespaces, DeviceClasses,
and the current Node. The chart grants cluster-wide read access for those
resources; only aggregate counts reach the host. Set `gpuCapacity.enabled=false`
to remove these additional grants. See [GPU capacity](kubernetes-attribution.md#live-gpu-capacity).

The opt-in workload inventory adds namespace-scoped Pod `get/list/watch` to the
bridge only. Requests select this node's Coder Pods and require metadata-only
responses; full Pod fallback is rejected. The private `/v1/workloads` handoff
contains sanitized owner/workspace identities and hashed Pod scopes. The host
reads inclusive Pod cgroup counters without a runtime socket. Public owner
telemetry excludes raw Pod UIDs, namespace names, cgroup paths, and device paths;
the locked Yggdrasil upload excludes it entirely. See
[Per-owner host telemetry](workload-telemetry.md) for bounds and failure behavior.

When attribution is enabled, Leviathan reads a detected GPU client's cgroup path
only to perform a one-way workspace join. The resulting label identifies
workspace membership; it does not prove current GPU execution or identify a
particular GPU, GI, or CI. Dashboard viewers may see Coder usernames and
workspace names, so treat them as multi-user operational metadata. See
[Kubernetes and Coder attribution](kubernetes-attribution.md) for the RBAC,
privacy, failure, and rollback details.

## External plugins

Configured plugins supply versioned observations over local Unix sockets.
Leviathan bounds requests and payloads and reports invalid or stale data; the
plugin's supervisor owns its permissions, credentials, and lifecycle. A plugin
is trusted to report telemetry for its assigned resources, and the protocol does
not sandbox its executable. Keep environment credentials with the adapter and
grant the monitor access only to its observation socket. See [plugins](plugins.md).

## Managed updater

The separate root updater can replace the installed monitor binary and restart
its registered service. It checks signed release metadata, the authorized host
and installation, archive contents, and sustained telemetry before reporting
success. A failed startup triggers verified rollback; an unverified recovery
blocks further updates for operator repair. Its credentials and transaction
journal are separate from the monitor. See [managed updates](managed-updates.md)
and the [native acceptance procedure](generated-updater-acceptance.md).

## Vulnerability reporting

Use GitHub's private security-advisory flow instead of a public issue. Include
the affected version, impact, reproduction, and PID namespace, but do not attach
production process or GPU identifiers. See the project [security policy](../SECURITY.md)
for supported versions and reporting expectations.
