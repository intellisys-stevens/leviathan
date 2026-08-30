# Security policy

## Supported versions

MIGLens is pre-1.0. Security fixes are applied to the latest release line.

## Reporting a vulnerability

Please use GitHub's private security advisory flow for the repository rather
than a public issue. Include the affected version, impact, reproduction, and
the PID namespace in which MIGLens was running. Do not attach production
process or GPU identifiers.

## v0.1 trust boundary

MIGLens is a local observability process with the same read visibility as its
Unix user. It intentionally:

- refuses non-loopback dashboard addresses;
- exposes no mutation endpoint;
- makes no outbound network request;
- reads no process environment;
- hides full command arguments unless explicitly enabled;
- lists only GPU-connected processes with an open UVM device handle in its
  current PID namespace;
- does not inspect cgroups, container runtimes, or Kubernetes APIs;
- does not request or elevate to root.

`/proc` and NVIDIA device visibility are sensitive privileges. Keep MIGLens in
the intended PID namespace and expose only the GPU or MIG device allocation the
workspace should monitor. MIGLens does not require the NVIDIA aggregate MIG
monitor or MIG configuration capabilities.

Running with `hostPID: true` or directly on a host intentionally expands the
candidate process inventory to that namespace. This is unnecessary for
ordinary Coder workspaces; see `docs/permissions.md` for the boundary. An SSH
tunnel does not make it safe to bind MIGLens publicly; v0.1 still refuses that
configuration.
