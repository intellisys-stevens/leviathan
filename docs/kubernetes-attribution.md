# Kubernetes and Coder attribution

Leviathan can optionally show scheduler assignments for Coder workspaces that use
Kubernetes Dynamic Resource Allocation (DRA). The integration is display-only:
it does not authorize access, change claims, or assert that an assigned device
is actively executing a workspace process.

Bare-metal installations do not enable or contact this integration unless an
attribution socket is configured.

## Data flow

The `leviathan-kubernetes-bridge` DaemonSet watches NVIDIA ResourceSlices and
Coder-labeled ResourceClaims. It joins the complete DRA `(driver, pool, device)`
identity. `/v1/allocations` retains the original direct-UUID schema.
`/v2/allocations` additionally carries hashed dynamic allocation references,
expected parent GPU/profile, allocation state, and inventory completeness.
The monitor publishes only verified physical-GPU and canonical MIG UUIDs. For each claim consumer, it also derives a
one-way scope reference from the Pod UID already present in
`ResourceClaim.status.reservedFor`; the default allocation integration does not
read Pod objects. The separately enabled [owner telemetry inventory](workload-telemetry.md)
reads Pod metadata and serves `/v1/workloads`, including CPU-only workspaces.

The bridge publishes sanitized JSON over
`/run/leviathan/attribution.sock`. The host Leviathan service polls that Unix
socket; it never receives Kubernetes credentials and does not use the Coder
API, Docker/containerd sockets, Pods, Secrets, exec, or logs.

## Install

Prerequisites:

- Kubernetes 1.34 or newer with the stable `resource.k8s.io/v1` DRA APIs;
- an NVIDIA DRA driver publishing node-local `gpu.nvidia.com` ResourceSlices;
- Coder workspaces using ResourceClaims in the namespaces you select below.

Install the versioned OCI chart published with the Leviathan release. Configure
the namespaces that contain Coder workspace claims:

```bash
helm upgrade --install leviathan-attribution \
  oci://ghcr.io/intellisys-stevens/charts/leviathan-attribution \
  --version 0.4.0 \
  --namespace leviathan-system \
  --create-namespace \
  --set-json 'workspaceNamespaces=["coder-workspaces"]'
```

From a source checkout or extracted release archive, replace the OCI chart and
version arguments with `./charts/leviathan-attribution`.

For multiple workspace namespaces, include each one in `workspaceNamespaces`.
The default DaemonSet targets nodes labeled `nvidia.com/gpu.present=true`;
selectors and tolerations are configurable in the chart values.

Enable the host client only after the bridge is ready:

```bash
sudo install -D -m 0644 contrib/systemd/leviathan-attribution.env \
  /etc/leviathan/leviathan.env
sudo systemctl daemon-reload
sudo systemctl restart leviathan@root.service
```

Confirm both sides:

```bash
helm status leviathan-attribution --namespace leviathan-system
sudo curl --unix-socket /run/leviathan/attribution.sock http://localhost/readyz
curl -fsS http://127.0.0.1:1397/api/v1/snapshot
```

The packaged bridge creates a root-only socket (`0600`), so the default host
integration requires `leviathan@root.service`. Alternate UID or shared-group
socket modes are not packaged in this release; do not make the socket
world-writable.

## RBAC and runtime security

By default, the chart creates two independent read-only grants:

- `get`, `list`, and `watch` for cluster-scoped
  `resourceslices.resource.k8s.io`;
- `get`, `list`, and `watch` for `resourceclaims.resource.k8s.io`, bound only in
  each configured workspace namespace.

The opt-in `workloadInventory.enabled=true` adds Pod `get/list/watch` only in
those workspace namespaces. Requests select the current node and Coder label,
negotiate metadata-only JSON, and reject ordinary Pod responses. The bridge
does not request Pod specs, environments, logs, or exec. RBAC itself authorizes
whole Pod reads, so the metadata-only restriction is also enforced in the
dedicated client's transport. No wildcard permissions, Nodes, Secrets, or
mutation APIs are granted. Kubernetes RBAC cannot restrict ResourceSlice
reads by node field selector, so the bridge can read cluster-wide slice device
metadata and filters it to its Downward-API node name in memory.

The container has a read-only root filesystem, `RuntimeDefault` seccomp, no
Linux capabilities, no host networking/PID namespace, and no writable host
mount except the dedicated socket directory.

## Privacy and status

The allocation integration reads workspace ID, workspace name, and username.
Optional owner telemetry additionally reads `com.coder.user.id` and the
metadata Pod UID. IDs are reduced to opaque join
references; neither raw value is emitted. On the host, Leviathan extracts a Pod
UID only from the cgroup path of an already detected GPU client, hashes it the
same way, and publishes only the matching workload reference. It does not read
Pod specs, process environments, or container-runtime metadata. Cgroup v1/v2 and
systemd/cgroupfs Pod paths are recognized; ambiguous scope-to-workspace joins
are omitted.

Leviathan does not expose email addresses, namespaces, claim or Pod identifiers,
container IDs, arbitrary labels/annotations, Kubernetes credentials, internal
scope references, or raw allocation records. Logs contain health and aggregate
counts only.

Dashboard viewers can see the Coder username and workspace name associated with
an assignment or matched GPU-client process. A process label establishes
workspace membership only; it does not prove active GPU execution or identify
which GPU, GI, or CI the process uses. Treat these names as multi-user
operational metadata and retain Leviathan's loopback/Tailnet access boundary.

Explicit bridge or Kubernetes source failures immediately mark retained
attribution stale. Silent observations become stale after 15 seconds and expire
after 60 seconds. A failed allocation watch rebuilds its caches before reporting
current inventory again; a successful API probe alone cannot revive old data.
Completeness is separate from freshness: unresolved allocations
remain visible as pending verification, unmatched devices have unknown assignment
state, and incomplete inventories cannot establish unassigned capacity. Bridge or Kubernetes
failure never changes GPU telemetry health or `/healthz`.

## Dynamic MIG (NVIDIA DRA v0.4.1)

Dynamic ResourceSlice devices describe a parent GPU and profile before a concrete
MIG UUID exists. Enable read-only resolution on the host monitor:

```toml
attribution_socket = "/run/leviathan/attribution.sock"
attribution_checkpoint_path = "/var/lib/kubelet/plugins/gpu.nvidia.com/checkpoint.json"
```

The equivalent environment variable is `LEVIATHAN_ATTRIBUTION_CHECKPOINT_PATH`;
the flag is `--attribution-checkpoint-path`. It is disabled by default and unused
by fake/fixture providers. The monitor must already have read access; do not
mount the driver's plugin directory into the bridge or grant the bridge access
to the driver socket. No new Kubernetes permissions are required.

An independent two-second reader follows atomic checkpoint replacements. It
accepts regular root-owned files without group/other write permission, up to
8 MiB, validates the v0.4.1 v2 checksum and current node boot ID, and accepts only
completed preparations. It never writes the checkpoint or takes a driver lock.
Claim UID, request, driver, pool, and device form one fixed, hashed allocation
reference shared with the bridge. Parent GPU + GI + CI and expected GI profile
must match fresh NVML topology. Some v0.4.1 checkpoints carry the parent UUID in
`migUUID`; the canonical instance UUID comes from NVML, never from that field.

Bindings remain pinned to their canonical MIG UUID. Reused numeric GI/CI IDs do
not transfer an assignment: replacement requires a new allocation or a verified
new preparation. Polling and unrelated checkpoint rewrites cannot rearm a
binding. A monitor restart may establish bindings from a valid current-boot
checkpoint and fresh topology. Allocation/checkpoint changes coalesce a topology
refresh before resolution. Concurrent, missing, corrupt, stale, ambiguous, or
unprepared observations remain incomplete; they never increase free capacity.

Local `Attribution.resolution` includes completeness, global/per-workload
unresolved counts, and sanitized reason codes. Raw claim/device references and
checkpoint records remain private. The locked Yggdrasil payload is unchanged.

Upgrade the monitor first, then the bridge. While reading a legacy v1 bridge,
verified direct assignments remain readable, but completeness is unknown. On
rollback, restore the previous monitor configuration (remove the new setting for
older strict parsers) and binary, then the prior Helm revision as needed. V1
handoffs, workload telemetry, and existing 90-day health journals remain intact.

## Limits and rollback

The integration supports `resource.k8s.io/v1` DRA allocations whose local
NVIDIA ResourceSlice has `spec.nodeName`. Process labels additionally require a
recognizable Kubernetes Pod UID in the client's visible cgroup path and an
unambiguous claim-consumer mapping. Unmatched or ambiguous processes remain
unattributed. Legacy `nvidia.com/gpu` resource-limit allocations cannot be
mapped reliably to exact UUIDs and are not attributed.

Disable attribution without stopping GPU monitoring:

```bash
sudo install -D -m 0644 contrib/systemd/leviathan.env.example \
  /etc/leviathan/leviathan.env
sudo systemctl restart leviathan@root.service
helm uninstall leviathan-attribution --namespace leviathan-system
```

The stale Unix-socket path may remain after uninstall; it contains no retained
assignment data and can be removed during planned host maintenance.
