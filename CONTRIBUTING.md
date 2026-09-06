# Contributing

Leviathan is pre-1.0: one Linux host, read-only CPU, RAM, storage, and NVIDIA
telemetry. CPU-only hosts are supported. Changes must preserve independent
telemetry domains, the MIG hierarchy, and metric provenance.

## Setup

Install Go 1.27+, Node.js 24+, a C compiler, and `make`. NVIDIA hardware is
optional because all interfaces can run against fixtures.

```bash
make bootstrap
make test
```

`make frontend` regenerates the embedded browser bundle. Commit changes under
`internal/webui/dist` whenever browser source changes. `make generate` must
leave both generated API type files clean.

## Before opening a change

```bash
make fmt
make test
make vulncheck
git diff --check
```

Add a deterministic test when changing status precedence, topology grouping,
history, attribution, wire output, TUI layout, or browser state. Live-host
checks are useful but cannot replace a fixture for permission and architecture
branches.

New metrics must define:

- a canonical name and unit;
- the actual hardware scope;
- provider precedence;
- behavior for unsupported, denied, stale, and error states;
- an OpenAPI update and regenerated Go/TypeScript types.

Never parse `nvidia-smi`, make a runtime socket mutation request, expose an
arbitrary label/environment field, or turn missing telemetry into zero.

## Browser changes

Keep the four views focused: Overview for whole-machine capacity and activity,
Resources for hardware, Workloads for assignments, and
Diagnostics for health observations and diagnostic details. Provider setup and
status belong to their owning view rather than repeated overview panels.

Use logical processor counts and measured RAM/storage usage. GPU capacity counts
existing unassigned units from observed workspace assignments, not unused VRAM
or scheduler admission. Allocated and reserved assignments both consume units.
Missing or unresolved integration data must not imply free capacity.
Accelerator artwork is schematic: it must not invent slice placement, hardware
form factors, or per-CI measurements. Missing, estimated, stale, and partial data
must remain distinguishable.

Exercise keyboard and touch navigation, retained-history retries, changing
topology, CPU-only hosts, and absent/stale attribution. Check light and dark
themes, reduced motion, long labels, and narrow layouts including 390/430px
phones and the 640–767px breakpoint range. A healthy chart screenshot does not
replace tests for missing samples or asynchronous request races. Keep chart
bundles lazy so opening Diagnostics does not initialize GPU charts. All Overview
charts are visible immediately; one shared window controls their history. GPU
boards use one shared Three.js renderer with independent cameras and visible,
clipped scenes. Review actual WebGL renders separately from the static fallback;
verify chip picking after rotation/zoom/scroll, touch scrolling outside Interact,
and no accidental selection after dragging. Keep keyboard buttons functional
without graphics and shared GI measurements separate from CI identities.
Do not introduce continuous animation or external model/texture requests.
Snow uses a single
page-load seed and stable surface identities; set an explicit test seed for
repeatable visual baselines and verify fresh arrangements on unseeded reloads.

Health history records discrete observations. Tests must keep unknown and
unsupported periods separate from the healthy-observation denominator and
distinguish journal coverage, monitor runtime, and host uptime.

## Generated files

- `internal/api/wire.gen.go` from `api/openapi.yaml`.
- `web/src/api.gen.ts` from `api/openapi.yaml`.
- `internal/webui/dist/**` from `web/**`.
- `docs/assets/architecture.svg` from
  `docs/assets/architecture.mmd` using `pretty-mermaid`.

## Commit and review notes

Call out permission-bound behavior and the hardware/driver path you exercised.
Do not include real hostnames, GPU UUIDs, pod names, image registries, command
arguments, socket responses, or other production identifiers in fixtures.

Maintainers should follow the [release procedure](docs/releasing.md); branch
and pull-request CI performs the same packaging work without publishing.
