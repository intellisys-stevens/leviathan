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
identity and converts only physical-GPU and MIG UUID assignments into Leviathan's
provider-neutral attribution schema. For each claim consumer, it also derives a
one-way scope reference from the Pod UID already present in
`ResourceClaim.status.reservedFor`; it does not read Pod objects.

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
  --version 0.3.2 \
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

The chart creates two independent read-only grants:

- `get`, `list`, and `watch` for cluster-scoped
  `resourceslices.resource.k8s.io`;
- `get`, `list`, and `watch` for `resourceclaims.resource.k8s.io`, bound only in
  each configured workspace namespace.

It does not grant wildcard verbs/resources or access to Pods, Nodes, Secrets,
logs, exec, or mutation APIs. Kubernetes RBAC cannot restrict ResourceSlice
reads by node field selector, so the bridge can read cluster-wide slice device
metadata and filters it to its Downward-API node name in memory.

The container has a read-only root filesystem, `RuntimeDefault` seccomp, no
Linux capabilities, no host networking/PID namespace, and no writable host
mount except the dedicated socket directory.

## Privacy and status

The only Coder labels the bridge reads are workspace ID, workspace name, and
username. The ID and claim-consumer Pod UID are reduced to opaque join
references; neither raw value is emitted. On the host, Leviathan extracts a Pod
UID only from the cgroup path of an already detected GPU client, hashes it the
same way, and publishes only the matching workload reference. It does not read
Pods, process environments, or container-runtime metadata. Cgroup v1/v2 and
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

Fresh attribution data is retained during a short bridge interruption, marked
stale after 15 seconds, and removed after 60 seconds. Bridge or Kubernetes
failure never changes GPU telemetry health or `/healthz`.

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
