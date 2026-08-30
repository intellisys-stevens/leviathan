# Security policy

## Supported versions

MIGLens is pre-1.0. Security fixes are applied to the latest release line.

## Reporting a vulnerability

Please use GitHub's private security advisory flow for the repository rather
than a public issue. Include the affected version, impact, reproduction, and
the PID namespace in which MIGLens was running. Do not attach production
process or GPU identifiers.

## Local agent trust boundary

The `miglens` agent is a local observability process with the same read
visibility as its Unix user. It intentionally:

- refuses non-loopback dashboard addresses;
- exposes no GPU, host, or cloud mutation endpoint (the local settings endpoint
  changes only the process-local sampling cadence);
- makes no outbound network request (the optional attribution client uses a
  configured local Unix socket only);
- reads no process environment;
- hides full command arguments unless explicitly enabled;
- lists only GPU-connected processes with an open UVM device handle in its
  current PID namespace;
- does not inspect cgroups or container runtimes;
- does not request or elevate its own privileges.

`/proc` and NVIDIA device visibility are sensitive privileges. Keep MIGLens in
the intended PID namespace and expose only the GPU or MIG device allocation the
workspace should monitor. MIGLens does not require the NVIDIA aggregate MIG
monitor or MIG configuration capabilities.

Running with `hostPID: true`, directly on a host, or through the packaged root
systemd instance intentionally expands the candidate process inventory. See
`docs/permissions.md` for that boundary. An SSH or Tailnet proxy does not make
it safe to bind MIGLens publicly; every release still refuses non-loopback
dashboard addresses.

## Jetstream fleet controller

`miglens-hub` is a separate process and trust boundary. It does not start the
local NVIDIA provider or alter the existing Nidhogg dashboard and `/api/v1/*`
API. Its configured Nidhogg URL is a credential-free external link, not a
reverse proxy.

The hub has three distinct read-only layers:

1. The inventory layer obtains a project-scoped token from an allowlisted
   OpenStack identity host, then lists Nova instances through an allowlisted
   compute host. Token creation requires the identity service's authentication
   `POST`; subsequent inventory operations are `GET`/`HEAD`. The transport
   rejects redirects, non-HTTPS URLs, `all_tenants`, non-allowlisted hosts, and
   every other mutation method.
2. The agent layer considers an active instance probe-eligible only when its
   UUID and authoritative Nova `user_id` exactly match one configured pair and
   an explicit agent binding exists. The paired creator username is a trusted
   display label; mutable Exosphere metadata is not an authorization factor.
   It then uses a separate explicit UUID-to-HTTPS binding, reads only
   `/api/v1/snapshot` and `/api/v1/version`, rejects redirects and
   credential-bearing URLs, and checks
   snapshot schema `v1` plus the exact expected hostname before accepting the
   instance identity.
3. The telemetry layer wraps the accepted single-host snapshot in fleet state,
   removes free-form sensitive details, and serves a read-only fleet API and
   dashboard on loopback. An unknown, mismatched, inactive, or unbound instance
   remains inventory-only or unavailable; it does not become a new network
   target.

OpenStack authentication material is read only from standard `OS_*`
environment variables. The hub TOML is non-secret and rejects unknown fields;
do not put application-credential secrets, passwords, tokens, OpenRC contents,
or SSH keys in it. Exact project IDs, identity hosts, and compute hosts must be
allowlisted independently of the credential's own cloud role. Keep the hub on
loopback and expose it only through a separately authenticated SSH or Tailnet
proxy.

The fleet controller does not retrieve instance passwords, open SSH sessions,
bootstrap agents, start, stop, shelve, or unshelve instances. Its only agent
egress is explicit HTTPS `GET` traffic, and its only OpenStack egress is the
allowlisted authentication and read-only inventory traffic above. Fleet
inventory, creator identities, process users, and GPU telemetry are sensitive;
limit dashboard access accordingly. See `docs/jetstream-fleet.md` before
enabling the controller.

The optional Kubernetes bridge is a separate trust boundary. It receives a
read-only service-account token, watches ResourceSlices and explicitly selected
workspace namespaces, and writes sanitized assignment metadata to a root-only
host Unix socket. It receives no NVIDIA devices, runtime sockets, host network,
host PID namespace, Pods, Secrets, exec, logs, or mutation permission. The
bridge can still read cluster-wide ResourceSlice metadata because Kubernetes
RBAC cannot restrict that resource by node field selector. See
`docs/kubernetes-attribution.md` before enabling it.
