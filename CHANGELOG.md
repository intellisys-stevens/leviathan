# Changelog

## 0.4.0 - Unreleased

### Added

- Host-wide CPU identity, utilization, and load; RAM capacity and utilization;
  aggregate storage capacity and throughput; and bounded per-filesystem capacity.
- CPU-only operation across snapshots, watch output, the TUI, browser, history,
  diagnostics, and health reporting. `doctor --require-gpu` retains strict GPU
  validation for deployments that require NVIDIA hardware.
- An in-process, latest-only Yggdrasil uplink. `leviathan serve` projects the
  existing immutable collector stream onto the independent `uplink-v1` contract;
  it never starts a second collector or stores an offline queue.
- An opt-in hardened-root systemd drop-in for credential delivery and a narrowly
  allowed Yggdrasil destination IP or CIDR.

### Security and privacy

- Uplink credentials use the `yv1` lookup-and-secret format, are read from a
  private regular file for every request, and are never accepted in TOML,
  environment variables, or process arguments.
- Uplink observations exclude processes, users, command lines, workload
  attribution, backing-device paths, filesystem UUIDs, and raw diagnostic
  details. Filesystem identifiers are deterministic opaque hashes.
- HTTPS uploads reject redirects, cookies, ambient proxies, oversized bodies,
  and malformed or mismatched receipts. Requests time out after five seconds.

### Compatibility

- Local API v1 remains additive. A v0.4 server always emits the top-level
  `system` object; clients may treat its absence as a legacy server.
- `/healthz` returns `200 degraded` when only system or GPU telemetry is usable
  and `503 unavailable` only when neither domain has a valid snapshot.
