# Security policy

## Supported versions

Leviathan is pre-1.0. Security fixes are applied to the latest release line.

## Reporting a vulnerability

Please use GitHub's private security advisory flow for the repository rather
than a public issue. Include the affected version, impact, reproduction, and
the PID namespace in which Leviathan was running. Do not attach production
process or GPU identifiers.

## Trust boundary

Leviathan is a local observability process with the same read visibility as its
Unix user. It intentionally:

- refuses non-loopback dashboard addresses;
- exposes no mutation endpoint;
- makes no outbound network request unless the administrator explicitly enables
  the credential-file-backed Yggdrasil uplink (the optional attribution client
  still uses a configured local Unix socket only);
- reads no process environment;
- hides full command arguments unless explicitly enabled;
- lists only GPU-connected processes with an open UVM device handle in its
  current PID namespace;
- reads cgroup paths only for those detected clients, and only when the
  optional attribution socket is configured;
- does not inspect container runtimes or query Pod objects;
- does not request or elevate its own privileges.

`/proc` and NVIDIA device visibility are sensitive privileges. Keep Leviathan in
the intended PID namespace and expose only the GPU or MIG device allocation the
workspace should monitor. Leviathan does not require the NVIDIA aggregate MIG
monitor or MIG configuration capabilities.

Running with `hostPID: true`, directly on a host, or through the packaged root
systemd instance intentionally expands the candidate process inventory. See
`docs/permissions.md` for that boundary. An SSH or Tailnet proxy does not make
it safe to bind Leviathan publicly; every release still refuses non-loopback
dashboard addresses.

The optional uploader is outbound only and projects the existing collector
snapshot onto a smaller contract. It excludes processes, users, command lines,
workload attribution, device paths, filesystem UUIDs, and raw diagnostic detail;
it follows no redirect and retains no offline queue. The hardened root unit
keeps `IPAddressDeny=any` unless an administrator installs the example drop-in
with Yggdrasil's fixed ingress IP or narrow CIDR. See `docs/uplink-v1.md` before
enabling it.

The optional Kubernetes bridge is a separate trust boundary. It receives a
read-only service-account token, watches ResourceSlices and explicitly selected
workspace namespaces, and writes sanitized assignment metadata to a root-only
host Unix socket. It receives no NVIDIA devices, runtime sockets, host network,
host PID namespace, Pods, Secrets, exec, logs, or mutation permission. The
bridge can still read cluster-wide ResourceSlice metadata because Kubernetes
RBAC cannot restrict that resource by node field selector. See
`docs/kubernetes-attribution.md` before enabling it.
