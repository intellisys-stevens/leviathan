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

The hub is cloud-read-only and has four distinct layers:

1. The inventory layer obtains a project-scoped token from an allowlisted
   OpenStack identity host, then lists Nova instances through an allowlisted
   compute host. Token creation requires the identity service's authentication
   `POST`; subsequent inventory operations are `GET`/`HEAD`. The transport
   rejects redirects, non-HTTPS URLs, `all_tenants`, non-allowlisted hosts, and
   every other mutation method.
2. The policy layer authorizes an exact UUID pin before an optional exact Nova
   `user_id` creator rule. Mutable Exosphere metadata is never an authorization
   factor. An explicit UUID mismatch fails closed instead of falling through.
3. The telemetry layer gives an exact legacy HTTPS agent binding precedence,
   then uses a fresh authenticated outbound uplink, then a coarse Exosphere
   console fallback. Console access permits only the bounded
   `os-getConsoleOutput` action for a canonical UUID in the configured project;
   every cloud mutation action remains blocked.
4. The presentation layer removes free-form sensitive details and labels the
   source and fidelity of every retained snapshot. Unknown, mismatched,
   inactive, or unauthorized instances remain inventory-only.

OpenStack authentication material is read only from standard `OS_*`
environment variables. Uplink bearer tokens are also loaded only from the
specific environment-variable names referenced by creator rules. The hub TOML
is non-secret and rejects unknown fields; do not put application-credential
secrets, passwords, tokens, OpenRC contents, or SSH keys in it. Exact project
IDs, identity hosts, and compute hosts must be allowlisted independently of the
credential's own cloud role. Keep the hub on loopback. If VM uplinks are
enabled, put one HTTPS reverse proxy in front of that listener, preserve
`Authorization`, and disable request-body logging.

The fleet controller does not retrieve instance passwords, open SSH sessions,
bootstrap agents, start, stop, shelve, or unshelve instances. Its OpenStack
egress is allowlisted authentication, inventory, and the exact read-only
console-output action. Optional ingress stores only a bounded, fresh,
replay-resistant latest snapshot after creator-token and current-inventory
checks. Uplink bearer tokens are creator-scoped rather than instance-scoped:
compromise of one VM can forge telemetry for another eligible VM owned by that
same Nova creator, but not for a different creator or project. Rotate the
creator token after any VM compromise. Metadata-service UUID discovery is not
instance attestation, so optional uplink telemetry alone must not be used for
security decisions, billing, scheduling, or incident attribution. Keep it
disabled outside an explicitly approved pilot. Request bodies, concurrent
requests, their 256 MiB combined raw-body budget, retained bytes, and retained
entries all have hard limits. Fleet inventory, creator identities, process
users, and GPU telemetry are sensitive;
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
