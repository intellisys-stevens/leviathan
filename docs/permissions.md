# Container and workspace permissions

Leviathan is designed to run as the ordinary workspace user. It needs access to
the NVIDIA devices, `/dev/nvidia-uvm`, and `libnvidia-ml.so.1` already exposed
to the workspace, plus the workspace's normal `/proc` view. It does not require
`sudo`, a privileged container, `hostPID`, runtime sockets, or NVIDIA's
aggregate MIG monitor capability.

## Process scope

The process table contains only visible processes with an open file descriptor
for the same device identity as `/dev/nvidia-uvm`. This detects GPU-connected
CUDA processes, including idle contexts. It does not claim instantaneous GPU
work, per-process GPU memory, or GPU/GI/CI ownership. Ordinary Coder services
and Leviathan itself do not appear.

Candidates still come only from the container's PID namespace: PID 1 may be
`coder`, `tini`, or another workspace-local process, and that is healthy. A
readable namespace with zero GPU clients is also healthy.

Leviathan does not mount or traverse a host `/proc` or query NVML for host GPU
PIDs. If it is intentionally launched directly on a host or in a pod with
`hostPID: true`, the visible process scope expands to that namespace. With DRA
attribution enabled, Leviathan may join an already detected client's cgroup Pod
UID to a sanitized workspace reference. This labels workspace membership only;
it does not attach the process to a GPU, GI, or CI.

Process environments are never read. Full command arguments remain disabled
unless `--show-command-line` or its equivalent configuration setting is
explicitly enabled.

## Hardened host-wide root mode

On a multi-user host, an ordinary service account cannot inspect other users'
`/proc/<pid>/fd` directories. Leviathan can intentionally run as the
`leviathan@root.service` template instance when host-wide GPU-process metadata is
required. The packaged root drop-in retains only `CAP_DAC_READ_SEARCH` and
`CAP_SYS_PTRACE`, makes the host and home filesystems unavailable for writes,
and limits networking to localhost so the loopback dashboard and optional
local DCGM connection continue to work.

Root mode expands process visibility for every dashboard viewer: PID, Unix
user, executable path, start time, and record status may cross workload-user
boundaries. It still reads only processes with a matching open NVIDIA UVM
handle, never reads process environments, and does not enable command-line
collection. Genuine provider or collector failures remain visible as
diagnostics; root mode only removes permission failures that it can actually
resolve.

## NVIDIA visibility

GPU and MIG discovery uses only the device handles, attributes, memory calls,
and supported GPM/DCGM counters already available to the process. Leviathan no
longer asks for physical MIG placement or host GPU process accounting, so it
does not need `/dev/nvidia-caps/nvidia-cap2` or
`NVIDIA_MIG_MONITOR_DEVICES=all`.

The container still needs its intended NVIDIA GPU or MIG device allocation,
`/dev/nvidia-uvm`, and the `compute,utility` driver capabilities normally
provided by the NVIDIA runtime or device plugin. Leviathan never requests MIG
configuration access and provides no GPU mutation endpoint.

## Coder workspaces

No Coder template integration is required when the existing workspace already
exposes the target GPUs and NVML library. Run the server normally:

```bash
leviathan serve
```

Coder can proxy `http://localhost:1397`, or the port can be forwarded over SSH.
Run `leviathan doctor` to verify GPU discovery, GPM support, readable MIG memory,
UVM visibility, and `/proc/<pid>/fd` inspection. Aggregated FD permission
failures mean some visible processes cannot be checked; they do not require
host PID access.

On a host-level deployment, the optional Kubernetes bridge can add Coder
workspace assignments from DRA ResourceClaims. An idle claim remains assigned;
an attributed GPU client is known to belong to a workspace but is not claimed
to be actively executing or to use a particular GPU, GI, or CI. See
[Kubernetes attribution](kubernetes-attribution.md) for its separate RBAC and
privacy boundary.
