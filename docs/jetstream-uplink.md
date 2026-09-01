# Jetstream Uplink

Leviathan's Jetstream support is machine-local. It discovers only the current
instance identity, collects the GPU/CPU/RAM snapshot visible on that machine,
and sends the snapshot to Yggdrasil. Nova inventory, ownership, platform state,
the central dashboard, and accounting are intentionally absent from this
repository.

## Runtime flow

```text
OpenStack metadata (169.254.169.254) -> instance UUID
local NVIDIA and /proc collectors    -> complete snapshot
Leviathan Uplink                     -> HTTPS -> Yggdrasil ingress
```

The client performs one synchronous request per interval. It has no durable
queue and never accepts commands from the receiver. A failed request is retried
at the next interval, while the local collector continues to sample normally.

On Linux, the Uplink adds optional aggregate guest CPU activity and system
memory usage read from `/proc/stat` and `/proc/meminfo`. These host fields are
best-effort: an unavailable host sample never blocks GPU/MIG telemetry, and old
agents that omit the optional fields remain wire-compatible.

## Run directly

Provide the token through an environment variable rather than a command-line
argument:

```bash
export LEVIATHAN_UPLINK_TOKEN='replace-with-the-issued-secret'
leviathan uplink \
  --uplink-url https://yggdrasil.example.test \
  --uplink-interval 15s
```

`--instance-uuid` is available for controlled tests. Production Jetstream
instances should omit it so the UUID comes from OpenStack's link-local metadata
service.

## Persistent service

The release archive contains:

- `contrib/systemd/leviathan-uplink@.service`
- `contrib/systemd/leviathan-uplink.env.example`

Install the template and create `/etc/leviathan/uplink-<user>.env` with mode
0600:

```text
YGGDRASIL_UPLINK_URL=https://yggdrasil.example.test
LEVIATHAN_UPLINK_TOKEN=replace-with-the-issued-secret
```

Then enable `leviathan-uplink@<user>.service`. The bootstrap helper can perform
the same operation after validating the selected Nova UUID against the remote
metadata endpoint:

```bash
scripts/bootstrap-jetstream-uplink.sh install \
  --instance-uuid 11111111-1111-4111-8111-111111111111 \
  --creator-username user@access-ci.org \
  --host 192.0.2.10 \
  --binary ./leviathan-linux-amd64 \
  --binary-sha256 <sha256> \
  --binary-arch amd64 \
  --token-stdin \
  --uplink-url https://yggdrasil.example.test
```

The helper is a dry run unless `--apply` is present.

## Protocol boundary

The current client sends complete snapshots to Yggdrasil's migration endpoint:

```text
POST /api/fleet/v1/uplink/{instanceUUID}
```

This creator-scoped endpoint is telemetry-only and is not a billing authority.
It remains temporarily compatible with already deployed agents. The canonical
machine-scoped `uplink-v1` OpenAPI and credential lifecycle are owned by the
[Yggdrasil repository](https://github.com/intellisys-stevens/yggdrasil); this
client will adopt that versioned contract without importing Yggdrasil code.

## Security properties

- Metadata requests are pinned to the exact link-local URL and bypass proxies.
- The receiver must be a credential-free HTTPS origin with no path or query.
- Redirects, cookies, embedded URL credentials, and oversized payloads are
  rejected.
- Tokens are never included in logged errors or command arguments.
- Leviathan receives acknowledgements only; it does not execute remote business
  commands.
