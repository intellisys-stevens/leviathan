# Browser workbench

| View        | What it shows                                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Overview    | CPU, RAM, unassigned GPU resources, and storage capacity; compact CPU/RAM and GPU charts followed by storage I/O or space usage  |
| Resources   | Interactive motherboard with CPU, RAM, and filesystem measurements; GPU boards with selectable MIG chip regions and assignment/activity indicators |
| Workloads | Per-owner CPU, RAM, GPU, and storage I/O telemetry; workspace assignments and integration status |
| Status | Yggdrasil connection and host/GPU telemetry, 90 days of minute observations, host uptime, monitor runtime, and diagnostic details |

GPU availability means resources without assignments in the configured workspace
integration. Allocated and reserved devices are excluded; incomplete or stale
observations stay explicit. It does not establish scheduler eligibility, quotas,
or how many additional users can be admitted. Unused VRAM is not free allocation
capacity. MIG capacity counts existing compute instances;
memory remains shared within each GPU instance.

Capacity cards share aligned rows and bottom bars. GPU metrics use the cyan gauge;
vendor marks identify devices in Resources, Workloads, and detail headers.
The mobile header exposes GitHub and the theme switch directly. Its View updates
popup keeps the hostname and connection state, with 0.5s, 1s, and 2s display
intervals. The desktop header offers the same choices. The selection is saved in
this browser and defaults to 0.5s; it never changes backend sampling or retained
history. Each display update uses the latest available snapshot. Offscreen charts
pause SVG redraws until they approach the viewport or receive keyboard focus.
Repeated unchanged measurements reuse the existing chart data.

On desktop, Overview and Workloads charts share aligned, equal-height panels with
single-row GPU legends. Swipe the legend or use its arrow buttons to reach
additional series. On mobile, every chart legend shows its complete list in two
columns, with values below labels and room for long names to wrap. Keyboard
Left/Right and Home/End move focus through the labels. Select a legend item to
highlight its series. Enlarged text can grow naturally.
Charts support direct tap and keyboard inspection (Left/Right, Home/End). Escape
or Live returns to current values.

Resources combines a motherboard on the left with all CPU, RAM, and Storage
measurements on the right; smaller screens stack the view above the measurements.
Select the CPU, RAM bank, or storage area to highlight its information, or use the
matching heading button. Zoom, Focus selected, and Reset control the view without
changing which measurements remain visible. CPU utilization and memory used
control cyan glow on a fixed 0–100% scale. Missing, estimated, or stale readings
use neutral styling. The board is illustrative: RAM modules represent aggregate
memory and the SSD-shaped storage area represents mounted filesystems, not an
observed inventory of slots or drives. Filesystem capacity, available space, and
the most-utilized mount remain visible beside the board.
Storage uses a compact summary and filesystem rows, with the fullest mount
marked inline.

GPU boards use locally bundled Three.js with
NVIDIA-green accents. Drag to rotate; use Zoom, Focus chip, or Reset view controls.
On phones, tap Interact to rotate or pinch, then Done to restore page scrolling.
Select a chip region or its keyboard-accessible button to open details. Hover or
focus shows assignment and shared GI telemetry, never fabricated per-CI memory.
A static board and the same inspection buttons remain available without WebGL
and in forced colors. Camera positions persist while navigating. Resources always
shows every GPU, including when opened from the Overview capacity tile.

Assigned chip regions and their badges use NVIDIA green; unassigned regions use
grey. Fresh SM activity increases the glow and adds a soft particle shimmer.
MIG regions use their shared GI activity, not inferred per-CI utilization. Idle
regions stay dim; unavailable readings remain distinct from zero in details.
Reserved resources use amber and unknown assignments use a dashed neutral badge.
Particles stop for stale data, hidden or offscreen views, and reduced motion.

Accumulated snow has 1–2 piles per panel, with varied heights and spacing. Each
page load generates fresh arrangements; polling, navigation, and resizing keep
them stable. Accumulation is decorative and follows the existing theme and
accessibility visibility preferences.

CPU, RAM, and storage bars show measured usage. The GPU bar shows the share of
existing allocation units that are assigned or reserved; its headline counts
unassigned resources. Partial readings stay labeled;
storage covers the persistent local filesystems visible to the collector.

Status reports **healthy observations** and **coverage**, not a service SLA.
Unknown periods are never filled as healthy or failed. Host uptime comes from
the Linux host; monitor runtime describes the current Leviathan process. See
[host monitoring](host-monitoring.md#health) and
[local persistence setup](deployment.md).
