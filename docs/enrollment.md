# Connect Leviathan to Yggdrasil

This workflow requires the unreleased source build. Published v0.4.1 uses
[manual token-file uplink](uplink-v1.md) and does not include `leviathan join`.

Create a join ticket in Yggdrasil for the intended machine. On that machine,
run the displayed `leviathan join` command and provide the ticket on standard
input. For the standard root service:

```sh
sudo leviathan --config /etc/leviathan/config.toml join \
  --server https://yggdrasil.example.edu --token-stdin
```

Paste the ticket, then end input. Automation can pipe the ticket from a private
file or credential manager. Do not put it in command arguments or logs.

The command registers the machine and updates only its uplink configuration.
Other TOML settings and the loopback listener remain intact; TOML formatting and
comments may be rewritten. Credentials are stored atomically with mode 0600 in
`/var/lib/leviathan/enrollment/state.json`. Use `--state-dir` for an alternate
private writable directory.

On Linux, root joins detect the existing `leviathan@root.service` running
`/usr/local/bin/leviathan` as root. Services using another executable or user
require explicit configuration and restart by their operator. The stock
monitor command gains the selected configuration path; an already configured
service keeps its arguments. A drop-in adds the currently resolved control-plane
and optional proxy/DNS addresses to the existing network allowlist, permits
enrollment-state writes, and restarts that service. Existing network deny rules
remain in place. If those addresses change, rerun join to refresh the allowlist.
The loopback listener and other service hardening remain intact. If no matching service is
installed, the command saves configuration and explains how to start `serve`.
This command does not install the agent or change updater enrollment.

Yggdrasil shows the machine as connected after its first accepted upload.
Successful registration alone is not telemetry readiness. The standard upload
interval is 15 seconds. `HTTPS_PROXY` and `NO_PROXY` are supported through the
normal Go HTTP transport; TLS still verifies the control-plane origin.

## Enrollment protocol

Both endpoints require HTTPS and JSON. Redirects are rejected.

| Endpoint | Request | Result |
| --- | --- | --- |
| `POST /api/enrollment/v1/join` | `ticket`, agent-generated `token`, `hostname`, `os`, `arch`, `agentVersion` | A server-assigned `machine`, `expiresAt`, `renewAfter`, `uplinkVersion`, `uplinkURL` |
| `POST /api/enrollment/v1/renew` | Bearer authorization and body `{ "token": "next agent-generated token" }` | The same receipt shape with the retained machine identity |

The `machine` object contains `platformId`, `scopeId`, and `machineId`.
The first join must redeem the administrator-scoped ticket within 15 minutes.
The bearer uses the existing `yv1_` format and is persisted **before** submission.
The central service stores its digest, not the plaintext secret. The same
ticket/secret can recover a lost response for 24 hours after redemption.

After a completed join, running the command again authenticates the retained
credential without issuing a new identity or extending its lifetime. An expired
or revoked enrollment must be reissued by the administrator. A different ticket
explicitly requests replacement enrollment in the same state directory: the
agent saves a new pending secret before submitting it, keeps the current local
credential until a replacement receipt is durable, and reuses the pending secret
after a lost response. A rejected or expired first ticket can therefore be
replaced without deleting local state.

Credentials last 180 days; renewal begins after 150 days. The uploader saves a
new pending secret before requesting rotation. After a valid response it
atomically promotes that secret. The previous secret remains usable for up to
seven days. Network failures preserve the still-valid current secret and retry
renewal after one minute. A restart reloads the pending secret rather than
creating another. If the old credential has expired after a lost response,
the client authenticates with the pending secret and requests its existing
receipt. This recovery does not extend expiry. Concurrent service/CLI writes
are serialized with a file lock.

## Uplink v2

Joined agents send `POST /api/uplink/v2/snapshots`. Existing token-file agents
keep v1 unless configured with `schema = "uplink-v2"`. Receipts, stream IDs,
sequence numbers, and exact retry behavior are unchanged.

V2 retains v1 `agent`, `host`, `system`, and `health` objects, and replaces
`gpus` with `accelerators`. Each accelerator contains `id`, `kind` (`gpu`,
`npu`, or `other`), `vendor`, `model`, `memory`, `metrics`, and `partitions`.
Each partition contains `id`, `parentId`, `kind`, `profile`, `memory`, and
`metrics`. The current NVIDIA projection preserves physical GPU, GPU-instance,
and compute-instance identities in this hierarchy. CPU-only agents send an
empty accelerator list. Metric values retain their explicit unit, timestamp,
source, scope, and availability; missing values are not zero. Plugin metric
names, sources, scopes, and units retain their original bounded identifiers.
Unknown GPU vendors remain `unknown`. Local compatibility diagnostics describe
uplink v1 limits and do not indicate failure of a valid v2 upload.

`capabilities` is an array of `{id,status,source}` objects. Status is
`available`, `unavailable`, `unsupported`, or `degraded`. Source identifiers are
bounded strings, allowing future hardware/OS plugins without NVIDIA-specific
enumerations. Optional `network` is a metric map; optional `extensions` contains
bounded metadata (64 KiB total), not executable instructions. The current
collector does not invent unavailable network measurements.

`accelerator.inventory` reports whether accelerator discovery completed.
An empty accelerator list proves a CPU-only inventory only when this capability
is `available`. Missing, degraded, unsupported, or failed inventory is unknown;
it must not be used as evidence that the host has no accelerators or is idle.

The DTO is in `internal/uplink/v2.go`. Shared golden fixtures include the
current NVIDIA/MIG projection and a separately labeled synthetic AMD/ROCm
payload. They establish wire compatibility, not actual AMD hardware collection.
Per-process identities, command lines, local owner telemetry, and detailed
diagnostic errors remain outside this projection.
