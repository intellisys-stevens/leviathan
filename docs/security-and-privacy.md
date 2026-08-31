# 🔐 Security and privacy

Leviathan is a read-only Linux observability process. Its effective trust
boundary is the Unix user, PID namespace, NVIDIA devices, and optional local
services made visible to it.

## 🧭 Operating boundary

Leviathan:

- refuses non-loopback dashboard addresses;
- exposes no GPU mutation endpoint;
- never parses `nvidia-smi` output or changes GPU/MIG configuration;
- makes no outbound network request;
- requires no Docker, containerd, CRI, or other runtime socket;
- does not request or elevate its own privileges.

Discovery and metrics use NVML, supported NVML GPM counters, and an optional
local DCGM hostengine. Exact device identifiers remain available to the API for
stable history and attribution joins, while ordinary dashboard views favor
concise GPU/GI/CI numbers.

## 🧠 Telemetry and retention

GPU samples and chart history remain in memory and are discarded on restart.
Unavailable, stale, permission-denied, and failed measurements remain explicit;
Leviathan does not substitute fabricated zeros.

The browser API is loopback-only and returns security headers that deny framing,
cross-origin dependencies, and active third-party content. An SSH or Tailnet
proxy should remain private to trusted operators.

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

When attribution is enabled, Leviathan reads a detected GPU client's cgroup path
only to perform a one-way workspace join. The resulting label identifies
workspace membership; it does not prove current GPU execution or identify a
particular GPU, GI, or CI. Dashboard viewers may see Coder usernames and
workspace names, so treat them as multi-user operational metadata. See
[Kubernetes and Coder attribution](kubernetes-attribution.md) for the RBAC,
privacy, failure, and rollback details.

## 🚨 Vulnerability reporting

Use GitHub's private security-advisory flow instead of a public issue. Include
the affected version, impact, reproduction, and PID namespace, but do not attach
production process or GPU identifiers. See the project [security policy](../SECURITY.md)
for supported versions and reporting expectations.
