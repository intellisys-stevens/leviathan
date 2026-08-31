# Contributing

Leviathan is intentionally narrow and pre-1.0: Linux, NVIDIA, one host,
read-only.
Changes should preserve the MIG hierarchy and metric provenance rather than
papering over provider differences.

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
