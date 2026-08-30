# Container and workspace permissions

MIGLens is designed to run as the ordinary workspace user. It needs access to
the NVIDIA devices, `/dev/nvidia-uvm`, and `libnvidia-ml.so.1` already exposed
to the workspace, plus the workspace's normal `/proc` view. It does not require
`sudo`, a privileged container, `hostPID`, runtime sockets, or NVIDIA's
aggregate MIG monitor capability.

## Process scope

The process table contains only visible processes with an open file descriptor
for the same device identity as `/dev/nvidia-uvm`. This detects GPU-connected
CUDA processes, including idle contexts. It does not claim instantaneous GPU
work, per-process GPU memory, or GPU/GI/CI ownership. Ordinary Coder services
and MIGLens itself do not appear.

Candidates still come only from the container's PID namespace: PID 1 may be
`coder`, `tini`, or another workspace-local process, and that is healthy. A
readable namespace with zero GPU clients is also healthy.

MIGLens does not mount or traverse a host `/proc`, query NVML for host GPU PIDs,
or infer container and pod ownership. If it is intentionally launched directly
on a host or in a pod with `hostPID: true`, the visible process scope expands to
that namespace. The dashboard labels this boundary as the current PID
namespace rather than promising a Kubernetes workspace boundary. Expanding the
namespace may reveal more GPU clients, but still does not provide attribution.

Process environments are never read. Full command arguments remain disabled
unless `--show-command-line` or its equivalent configuration setting is
explicitly enabled.

## NVIDIA visibility

GPU and MIG discovery uses only the device handles, attributes, memory calls,
and supported GPM/DCGM counters already available to the process. MIGLens no
longer asks for physical MIG placement or host GPU process accounting, so it
does not need `/dev/nvidia-caps/nvidia-cap2` or
`NVIDIA_MIG_MONITOR_DEVICES=all`.

The container still needs its intended NVIDIA GPU or MIG device allocation,
`/dev/nvidia-uvm`, and the `compute,utility` driver capabilities normally
provided by the NVIDIA runtime or device plugin. MIGLens never requests MIG
configuration access and provides no GPU mutation endpoint.

## Coder workspace

No Coder template integration is required when the existing workspace already
exposes the target GPUs and NVML library. Run the server normally:

```bash
miglens serve
```

Coder can proxy `http://localhost:1397`, or the port can be forwarded over SSH.
Run `miglens doctor` to verify GPU discovery, GPM support, readable MIG memory,
UVM visibility, and `/proc/<pid>/fd` inspection. Aggregated FD permission
failures mean some visible processes cannot be checked; they do not require
host PID access.
